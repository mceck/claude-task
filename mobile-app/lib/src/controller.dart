import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import 'api.dart';
import 'models.dart';
import 'push.dart';
import 'storage.dart';
import 'timeline_visibility.dart';
import 'voice.dart';

/// Colors handed to Tags created inline, cycling so neighbours differ (the
/// same cycle as the web app).
const _tagColors = [
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#0ea5e9',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
];

/// What a bulk action did: how many Tasks it applied to, and the reason for
/// each one it could not.
class BulkResult {
  final int succeeded;
  final Map<String, String> failed;
  const BulkResult(this.succeeded, this.failed);
}

class TaskController extends ChangeNotifier {
  late final VoiceController voice;

  /// The viewer's Timeline choice, shared by every Task of every Project.
  late final TimelineVisibilityStore timelineVisibility =
      TimelineVisibilityStore(storage);

  final ProfileStorage storage;
  final TaskApi Function(Uri, String?) apiFactory;
  final LiveConnection Function(TaskApi) socketFactory;
  final PhonePush push;
  TaskApi? api;
  LiveConnection? _socket;
  Json? _login;
  StreamSubscription<Json>? _events;
  StreamSubscription<ConnectionState>? _states;
  StreamSubscription<String>? _pushOpens, _pushTokens;
  Timer? _refreshTimer;
  Future<void>? _refreshing;
  bool booting = true, busy = false, sending = false, includeClosed = false;
  bool conversationVisible = false, appVisible = true;
  String? error, pendingTaskId, assignmentRetryId;

  /// The Task the failed Agent assignment belongs to, so Retry can't touch another one.
  String? assignmentRetryTaskId;
  ConnectionState connection = ConnectionState.connecting;

  /// Whether the live socket is up, independent of a one-off HTTP failure.
  bool _liveConnected = false;
  User? user;
  List<Project> projects = [];
  List<Wiki> wikis = [];
  Wiki? wiki;
  bool wikiSection = false;

  /// The Schedules section: the list, the open Schedule and its run history.
  List<Schedule> schedules = [];
  Schedule? schedule;
  List<ScheduleRun> scheduleRuns = [];
  bool scheduleSection = false;

  /// The open Wiki's Chats, most recently active first, and the one shown.
  List<WikiChat> chats = [];
  WikiChat? openChat;
  int _timelineEpoch = 0;
  List<Task> tasks = [];
  List<TaskStatus> statuses = [];
  List<Tag> tags = [];
  List<User> users = [];
  List<Agent> agents = [];
  Map<String, TaskPreference> preferences = {};
  Project? project;
  Task? task;

  /// Every file of the open Task, from its description and its Comments
  /// (newest first), as the Task details list shows them.
  List<Json> attachments = [];
  Json? session;

  /// The open Task's Scheduled Messages: pending by due time, then the
  /// finished ones, newest first.
  List<ScheduledMessage> scheduledMessages = [];
  List<TimelineEntry> timeline = [];
  String? nextCursor;
  final Map<String, String> liveText = {};

  /// Live text boxes the reader expanded, by [liveText] key, and the Agent
  /// Comments that replaced them, which open expanded too (as on the web).
  final Set<String> liveExpanded = {}, expandedComments = {};
  String liveThinking = '', liveStatus = '';

  /// Context size after the latest model call of each running Turn, by Task
  /// (`tokens` only). A Session's stored `context` moves only when a Turn ends.
  final Map<String, Json> liveContexts = {};

  /// The context of a Task: its running Turn's measurement over the stored one
  /// (keeping the stored window). Only a running Session trusts the live
  /// figure; a list row isn't told when its Session stops.
  Json? contextOf(String taskId, String? state, Json? stored) {
    final live = liveContexts[taskId];
    if (live == null || state != 'running') return stored;
    return {
      'tokens': live['tokens'],
      'window': live['window'] ?? stored?['window'],
    };
  }

  /// The open Task's context.
  Json? get sessionContext => contextOf(
    task?.id ?? '',
    session?['state'] as String?,
    session?['context'] as Json?,
  );

  /// Notified when only the Live Turn preview changes (streamed text and
  /// Thinking, the retry status, the preparation output), instead of every
  /// listener: tokens arrive many times a second, and rebuilding the whole
  /// app for each made the conversation and its composer stutter. Everything
  /// else, including the stored Entries that retire the preview, notifies
  /// everyone as usual.
  Listenable get live => _live;
  final _live = ValueNotifier(0);

  /// The running Job's worktree preparation output, as on the web: the Job id
  /// it belongs to and the last [setupOutputCap] characters streamed so far.
  /// Not stored in the Timeline, so it is never cached.
  Json? liveSetup;
  static const setupOutputCap = 64 * 1024;

  /// The Task's Runs: what the bar lists and the live transcript of each
  /// (docs/specs/clients.md#runs). The backend keeps transcripts in memory for
  /// as long as the Job runs, so the phone never caches them.
  final Map<String, Json> runs = {};
  final Map<String, Json> runTranscripts = {};
  final Map<String, List<Json>> _runBuffered = {};
  final Set<String> _runWanted = {},
      _runRefreshed = {},
      dismissedRuns = {},
      goneRuns = {};

  /// The Run whose sheet is open, from the bar or from its Timeline row.
  String? openRunId;
  bool _olderLoaded = false;
  int _profileEpoch = 0;
  bool get online => connection == ConnectionState.connected;
  Draft get draft => task == null
      ? const Draft()
      : Draft.fromJson(storage.read('draft:${task!.id}') ?? {});
  TaskPreference? get preference => task == null ? null : preferences[task!.id];

  /// What the bar lists, in the backend's order: what runs now, then the
  /// failures the reader hasn't closed.
  List<Json> get runBar {
    final listed = runs.values
        .where(
          (r) =>
              r['status'] == 'running' ||
              (r['status'] == 'error' && !dismissedRuns.contains(r['id'])),
        )
        .toList();
    return listed..sort((a, b) {
      int rank(Json run) => run['status'] == 'running' ? 0 : 1;
      final byRank = rank(a) - rank(b);
      return byRank != 0
          ? byRank
          : '${a['startedAt']}'.compareTo('${b['startedAt']}');
    });
  }

  TaskController({
    required this.storage,
    required this.push,
    TaskApi Function(Uri, String?)? apiFactory,
    LiveConnection Function(TaskApi)? socketFactory,
  }) : apiFactory =
           apiFactory ?? ((uri, cookie) => HttpTaskApi(uri, cookie: cookie)),
       socketFactory = socketFactory ?? TaskSocket.new {
    voice = VoiceController(send: (message) => _socket?.send(message) ?? false);
  }

  /// The Agent a Delivery names: the one whose Job carried the Comment, known
  /// from that Job's Timeline items, else the Task's Agent.
  String? deliveryAgentName(Map delivery) {
    final jobId = delivery['jobId'];
    // Every User Comment asks: index the Timeline once, not once per Comment.
    if (!identical(_jobAgentsOf, timeline)) {
      _jobAgentsOf = timeline;
      _jobAgents = {};
      for (final e in timeline) {
        if (e.type != 'agent') continue;
        _jobAgents.putIfAbsent(
          e.content['jobId'],
          () => e.content['agentId'] as String?,
        );
      }
    }
    final fromJob = jobId == null ? null : _jobAgents[jobId];
    return agents.byId(fromJob ?? task?.agentId)?.name;
  }

  List<TimelineEntry>? _jobAgentsOf;
  Map<Object?, String?> _jobAgents = {};

  /// Whether the User is reading this Task's conversation right now.
  bool watchingTask(String taskId) =>
      conversationVisible && appVisible && task?.id == taskId;

  /// Opening a conversation clears its notifications from this phone.
  void conversationShown() {
    final id = task?.id;
    if (id != null && conversationVisible && appVisible) {
      unawaited(push.clearTask(id));
    }
  }

  Future<void> initialize() async {
    push.watching = watchingTask;
    _pushOpens = push.taskOpens.listen((id) {
      unawaited(openNotification(id));
    });
    _pushTokens = push.tokens.listen((token) {
      if (user != null && !user!.mustChangePassword) {
        unawaited(
          _registerToken(token).catchError((Object _) {
            error = 'Phone token registration failed; try Enable notifications again';
            notifyListeners();
          }),
        );
      }
    });
    await push.initialize();
    pendingTaskId = push.takeInitialTask();
    await _flushPendingLogout();
    final login = await storage.readLogin();
    if (login != null) {
      try {
        await _activate(login);
      } catch (e) {
        _recordError(e);
      }
    }
    booting = false;
    notifyListeners();
  }

  Future<void> _flushPendingLogout() async {
    final pending = await storage.pendingLogout();
    if (pending == null) return;
    final old = apiFactory(
      installationUrl(pending['url'] as String),
      pending['cookie'] as String?,
    );
    try {
      await old.request('POST', '/auth/logout');
      await storage.savePendingLogout(null);
    } catch (_) {
      /* Retain securely for revocation on reconnect; never restore this Login. */
    } finally {
      old.close();
    }
  }

  Future<void> login(String url, String email, String password) async {
    busy = true;
    error = null;
    notifyListeners();
    try {
      final uri = installationUrl(url),
          client = apiFactory(installationUrl(url), null);
      try {
        final result = await client.request(
          'POST',
          '/auth/login',
          body: {'email': email, 'password': password},
        );
        if (client.cookie == null) {
          throw StateError('The installation did not return a Login cookie');
        }
        final login = <String, dynamic>{
          'url': uri.toString(),
          'cookie': client.cookie,
          'user': result['user'],
          'deviceId': const Uuid().v4(),
        };
        await storage.writeLogin(login);
        await _activate(login);
      } finally {
        client.close();
      }
    } catch (e) {
      _recordError(e);
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> _activate(Json login) async {
    _profileEpoch++;
    _login = login;
    user = User.fromJson(Map<String, dynamic>.from(login['user'] as Map));
    api?.close();
    api = apiFactory(
      installationUrl(login['url'] as String),
      login['cookie'] as String?,
    );
    await storage.open(login['url'] as String, user!.id);
    _resetProfileState();
    _hydrateGlobal();
    if (user!.mustChangePassword) return;
    try {
      final me = await _request('GET', '/auth/me');
      user = User.fromJson(me['user'] as Json);
      _login!['user'] = me['user'];
      await storage.writeLogin(_login);
      if (!user!.mustChangePassword) {
        _connectSocket();
        await refresh();
      }
    } catch (e) {
      if (user != null) {
        _connectSocket();
        _recordError(e);
      }
    }
    if (user != null) {
      await _openPending();
      try {
        final token = await push.currentToken();
        if (token != null) await _registerToken(token);
      } catch (_) {
        error =
            'Phone token registration failed; try Enable notifications again';
      }
    }
  }

  /// Drops everything that belongs to the previous User or Login before another one is activated.
  void _resetProfileState() {
    _timelineEpoch++;
    timelineVisibility.reload();
    _socket?.close();
    _socket = null;
    unawaited(_events?.cancel());
    _events = null;
    unawaited(_states?.cancel());
    _states = null;
    _liveConnected = false;
    connection = ConnectionState.connecting;
    voice.disconnected();
    project = null;
    task = null;
    timeline = [];
    scheduledMessages = [];
    session = null;
    nextCursor = null;
    _olderLoaded = false;
    statuses = [];
    tags = [];
    tasks = [];
    users = [];
    agents = [];
    projects = [];
    wikis = [];
    wiki = null;
    wikiSection = false;
    schedules = [];
    schedule = null;
    scheduleRuns = [];
    scheduleSection = false;
    chats = [];
    openChat = null;
    preferences = {};
    liveText.clear();
    liveThinking = '';
    liveStatus = '';
    liveContexts.clear();
    liveSetup = null;
    conversationVisible = false;
    assignmentRetryId = null;
    assignmentRetryTaskId = null;
  }

  void _hydrateGlobal() {
    final cached = storage.read('global') ?? {};
    projects = objects(cached['projects']).map(Project.fromJson).toList();
    wikis = objects(cached['wikis']).map(Wiki.fromJson).toList();
    if (wiki != null) wiki = wikis.byId(wiki!.id) ?? wiki;
    final cachedSchedules = storage.read('schedules') ?? {};
    schedules = objects(cachedSchedules['schedules'])
        .map(Schedule.fromJson)
        .toList();
    if (schedule != null) {
      schedule = schedules.byId(schedule!.id) ?? schedule;
    }
    agents = _unlessSame('agents', agents, cached['agents'], Agent.fromJson);
    users = _unlessSame('users', users, cached['users'], User.fromJson);
  }

  void _connectSocket() {
    voice.disconnected();
    _socket?.close();
    unawaited(_events?.cancel());
    unawaited(_states?.cancel());
    _socket = socketFactory(api!);
    _events = _socket!.events.listen(_event);
    _states = _socket!.states.listen((state) {
      if (state != ConnectionState.connected) voice.disconnected();
      final previous = connection;
      connection = state;
      _liveConnected = state == ConnectionState.connected;
      // Runs live in the backend: after a lost connection the next snapshot is
      // the truth, and its finished ones have left.
      if (state != ConnectionState.connected) _clearRuns();
      notifyListeners();
      if (state == ConnectionState.connected &&
          previous != ConnectionState.connected) {
        liveText.clear();
        liveThinking = '';
        unawaited(
          refresh().then((_) => _openPending()).catchError((Object e) {
            _recordError(e);
            notifyListeners();
          }),
        );
        unawaited(_flushPendingLogout());
      }
    });
    _subscribe();
    _socket!.connect();
  }

  void _subscribe() => _socket?.subscribe({
    'user:${user!.id}',
    'agents',
    'wikis',
    'projects',
    if (scheduleSection) 'schedules',
    if (project != null) 'project:${project!.id}',
    if (task != null) 'task:${task!.id}',
  });

  /// Settings screens call the same API as the web app's administration pages.
  Future<Json> settingsRequest(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) => _request(method, path, body: body, files: files);

  Future<Json> _request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    final epoch = _profileEpoch;
    final client = api!;
    try {
      final result = await client.request(
        method,
        path,
        body: body,
        files: files,
      );
      if (epoch != _profileEpoch) throw StateError('Login changed');
      if (_login != null &&
          api!.cookie != null &&
          _login!['cookie'] != api!.cookie) {
        _login!['cookie'] = api!.cookie;
        await storage.writeLogin(_login);
      }
      // An HTTP timeout marks the connection offline even when the socket stayed up;
      // a successful request proves the connection is usable again.
      if (_liveConnected && connection != ConnectionState.connected) {
        connection = ConnectionState.connected;
        notifyListeners();
      }
      return result;
    } on ApiException catch (e) {
      if (e.status == 401) await _expire();
      if (e.code == 'password_change_required' && user != null) {
        _login!['user'] = {
          ...(_login!['user'] as Json),
          'mustChangePassword': true,
        };
        user = User.fromJson(_login!['user'] as Json);
        notifyListeners();
      }
      rethrow;
    } on SocketException {
      connection = ConnectionState.offline;
      notifyListeners();
      rethrow;
    } on TimeoutException {
      connection = ConnectionState.offline;
      notifyListeners();
      rethrow;
    }
  }

  Future<void> _expire() async {
    voice.leave();
    _profileEpoch++;
    _socket?.close();
    user = null;
    _resetProfileState();
    api?.cookie = null;
    await storage.writeLogin(null);
    _login = null;
    error = 'Your Login expired. Sign in again.';
    notifyListeners();
  }

  Future<void> changePassword(String current, String password) async {
    final result = await _request(
      'POST',
      '/auth/password',
      body: {'currentPassword': current, 'newPassword': password},
    );
    _login!['user'] = result['user'];
    user = User.fromJson(result['user'] as Json);
    await storage.writeLogin(_login);
    _connectSocket();
    await refresh();
    await _openPending();
    notifyListeners();
  }

  Future<void> changeAvatar([DraftFile? file]) async {
    final profile = _profileEpoch;
    final id = user!.id;
    final result = await _request(
      file == null ? 'DELETE' : 'PUT',
      '/users/$id/avatar',
      files: file == null ? const [] : [file],
    );
    if (profile != _profileEpoch || _login == null) return;
    _login!['user'] = result['user'];
    user = User.fromJson(result['user'] as Json);
    users = [
      for (final u in users)
        if (u.id == id) user! else u,
    ];
    await storage.writeLogin(_login);
    final cached = storage.read('global');
    if (cached != null) {
      await storage.write('global', {
        ...cached,
        'users': [
          for (final u in objects(cached['users']))
            if (u['id'] == id) result['user'] else u,
        ],
      });
    }
    notifyListeners();
  }

  Future<void> logout() async {
    voice.leave();
    _profileEpoch++;
    final login = _login;
    _socket?.close();
    _refreshTimer?.cancel();
    _projectsTimer?.cancel();
    await _events?.cancel();
    await _states?.cancel();
    if (login != null) {
      await storage.savePendingLogout(login);
      try {
        await api!.request('POST', '/auth/logout');
        await storage.savePendingLogout(null);
      } catch (_) {}
    }
    try {
      await push.disable();
    } catch (_) {}
    await storage.clear();
    timelineVisibility.reload();
    api?.close();
    api = null;
    user = null;
    _login = null;
    projects = [];
    wikis = [];
    wiki = null;
    wikiSection = false;
    chats = [];
    openChat = null;
    tasks = [];
    statuses = [];
    tags = [];
    users = [];
    agents = [];
    preferences = {};
    task = null;
    project = null;
    timeline = [];
    session = null;
    liveText.clear();
    liveThinking = '';
    liveSetup = null;
    pendingTaskId = null;
    _clearRuns();
    assignmentRetryId = null;
    assignmentRetryTaskId = null;
    _liveConnected = false;
    connection = ConnectionState.connecting;
    error = null;
    notifyListeners();
  }

  Future<void> refresh() {
    _refreshing ??= _refresh().whenComplete(() {
      _refreshing = null;
    });
    return _refreshing!;
  }

  Timer? _projectsTimer;

  /// Refetches the Projects list, with every Project's indicators, once a
  /// burst of activity settles.
  void _refreshProjectsSoon() {
    _projectsTimer?.cancel();
    _projectsTimer = Timer(const Duration(milliseconds: 250), () {
      unawaited(() async {
        if (api == null || user == null || user!.mustChangePassword) return;
        try {
          final raw = objects((await _request('GET', '/projects'))['projects']);
          if (user == null) return;
          projects = raw.map(Project.fromJson).toList();
          final cached = storage.read('global') ?? {};
          await storage.write('global', {...cached, 'projects': raw});
          notifyListeners();
        } catch (e) {
          _recordError(e);
          notifyListeners();
        }
      }());
    });
  }

  Future<void> _refresh() async {
    if (api == null || user == null || user!.mustChangePassword) return;
    final results = await Future.wait([
      _request('GET', '/projects'),
      _request('GET', '/agents'),
      _request('GET', '/users'),
      _request('GET', '/wikis'),
      _request('GET', '/schedules'),
    ]);
    if (user == null) return;
    await storage.write('global', {
      'projects': results[0]['projects'],
      'agents': results[1]['agents'],
      'users': results[2]['users'],
      'wikis': results[3]['wikis'],
    });
    await storage.write('schedules', {'schedules': results[4]['schedules']});
    _hydrateGlobal();
    user = users.byId(user!.id) ?? user;
    final selectedProject = project;
    if (selectedProject != null) await _fetchProject(selectedProject.id);
    final selectedWiki = wiki;
    if (selectedWiki != null) await _fetchChats(selectedWiki.id);
    final selectedSchedule = schedule;
    if (selectedSchedule != null) await _fetchSchedule(selectedSchedule.id);
    final selectedTask = task;
    if (selectedTask != null) await _fetchTask(selectedTask.id);
    error = null;
    notifyListeners();
  }

  void showWikis() {
    wikiSection = true;
    wiki = null;
    chats = [];
    openChat = null;
    project = null;
    scheduleSection = false;
    schedule = null;
    scheduleRuns = [];
    task = null;
    _clearConversation();
    _subscribe();
    notifyListeners();
  }

  void showProjects() {
    wikiSection = false;
    scheduleSection = false;
    schedule = null;
    scheduleRuns = [];
    backToProjects();
  }

  /// Opens a Wiki on its Chat list. [chatId] opens that Chat, [openLatest]
  /// the most recent one; a Wiki without Chats opens an empty composer.
  Future<void> selectWiki(
    Wiki value, {
    String? chatId,
    bool openLatest = false,
  }) async {
    wikiSection = true;
    wiki = value;
    task = null;
    openChat = null;
    _clearConversation();
    project = null;
    scheduleSection = false;
    schedule = null;
    scheduleRuns = [];
    statuses = [];
    tags = [];
    chats = _cachedChats(value.id);
    _subscribe();
    notifyListeners();
    if (!online) {
      final target = chatId != null
          ? chats.byId(chatId)
          : openLatest
          ? chats.firstOrNull
          : null;
      if (target != null) await selectChat(target);
      return;
    }
    await _fetchChats(value.id);
    if (wiki?.id != value.id) return;
    var target = chatId == null ? null : chats.byId(chatId);
    if (chatId != null && target == null) {
      // A Chat that isn't listed (yet): open its Task as the Wiki's own.
      target = WikiChat.fromJson({
        'id': chatId,
        'wikiId': value.id,
        'agentId': value.agentId,
      });
    }
    if (target == null && openLatest) target = chats.firstOrNull;
    if (target != null) {
      await selectChat(target);
    } else if (chats.isEmpty) {
      await newChat();
    }
  }

  List<WikiChat> _cachedChats(String wikiId) =>
      objects(storage.read('chats:$wikiId')?['chats'])
          .map(WikiChat.fromJson)
          .toList();

  /// Loads the Wiki's Chat list. Cached Chats the server no longer lists are
  /// dropped with their cached conversation, and when the open one is among
  /// them the most recent remaining Chat (or an empty composer) opens.
  Future<void> _fetchChats(String wikiId) async {
    final result = await _request('GET', '/wikis/$wikiId/chats');
    if (wiki?.id != wikiId) return;
    final raw = objects(result['chats']);
    final fresh = raw.map(WikiChat.fromJson).toList();
    final previous = chats.isEmpty ? _cachedChats(wikiId) : chats;
    final listed = fresh.map((c) => c.id).toSet();
    final gone = previous.where((c) => !listed.contains(c.id)).toList();
    for (final chat in gone) {
      await storage.write('task:${chat.id}', {});
    }
    await storage.write('chats:$wikiId', {'chats': raw});
    chats = fresh;
    final open = openChat;
    if (open != null) {
      openChat = fresh.byId(open.id) ?? open;
      if (gone.any((c) => c.id == open.id) && task?.id == open.id) {
        await _openLatestOrNew();
      }
    }
  }

  Future<void> _openLatestOrNew() async {
    _timelineEpoch++;
    _clearConversation();
    task = null;
    openChat = null;
    if (chats.isNotEmpty) {
      await selectChat(chats.first);
    } else if (online) {
      await newChat();
    }
    notifyListeners();
  }

  /// Opens a Chat's conversation, driven by the Task that holds it.
  Future<void> selectChat(WikiChat chat) async {
    final wikiId = wiki?.id;
    final previous = openChat;
    openChat = chat;
    final cachedTask = storage.read('task:${chat.id}')?['task'];
    if (!online && cachedTask != null) {
      await selectTask(Task.fromJson(cachedTask as Json));
      return;
    }
    try {
      final result = await _request('GET', '/tasks/${chat.id}');
      if (wiki?.id != wikiId || openChat?.id != chat.id) return;
      await selectTask(Task.fromJson(result['task'] as Json));
    } catch (_) {
      // A failed selection must not leave the header on a Chat while the body
      // still shows the previous one (and sends there).
      if (openChat?.id == chat.id) openChat = previous;
      rethrow;
    }
  }

  /// New chat: reserves an empty Chat to post the first Comment to.
  Future<void> newChat() async {
    final current = wiki!;
    final result = await _request('POST', '/wikis/${current.id}/chats');
    if (wiki?.id != current.id) return;
    await selectChat(WikiChat.fromJson(result['chat'] as Json));
  }

  Future<void> renameChat(WikiChat chat, String title) async {
    final current = wiki!;
    final result = await _request(
      'PATCH',
      '/wikis/${current.id}/chats/${chat.id}',
      body: {'title': title},
    );
    if (wiki?.id != current.id) return;
    final renamed = WikiChat.fromJson(result['chat'] as Json);
    chats = [for (final c in chats) c.id == renamed.id ? renamed : c];
    if (openChat?.id == renamed.id) openChat = renamed;
    await _cacheChats(current.id);
    notifyListeners();
  }

  Future<void> deleteChat(WikiChat chat) async {
    final current = wiki!;
    await _request('DELETE', '/wikis/${current.id}/chats/${chat.id}');
    await storage.write('task:${chat.id}', {});
    if (wiki?.id != current.id) return;
    chats = chats.where((c) => c.id != chat.id).toList();
    await _cacheChats(current.id);
    if (task?.id == chat.id) {
      await _openLatestOrNew();
    } else {
      notifyListeners();
    }
  }

  Future<void> _cacheChats(String wikiId) => storage.write('chats:$wikiId', {
    'chats': [
      for (final c in chats)
        {
          'id': c.id,
          'wikiId': c.wikiId,
          'title': c.title,
          'agentId': c.agentId,
          'sessionState': c.sessionState,
          'running': c.running,
          'unread': c.unread,
          'createdAt': c.createdAt.toUtc().toIso8601String(),
          'lastActivityAt': c.lastActivityAt.toUtc().toIso8601String(),
        },
    ],
  });

  /// Back from a Chat to the Wiki's Chat list.
  void showChats() {
    task = null;
    openChat = null;
    conversationVisible = false;
    _clearConversation();
    _subscribe();
    notifyListeners();
  }

  /// Why the open Chat can't be written to: another Agent runs it.
  String? get chatReadOnlyReason {
    final chat = openChat, w = wiki;
    if (chat == null || w == null || task?.id != chat.id) return null;
    if (chat.agentId == null || chat.agentId == w.agentId) return null;
    final name = agents.byId(chat.agentId)?.name ?? 'another agent';
    return 'This chat is run by $name: assign the wiki back to that agent '
        'to continue it.';
  }

  /// Whether the open Task is the conversation of a Scheduled Run.
  bool get scheduleRunOpen =>
      scheduleSection && schedule != null && task != null;

  /// Why the open Scheduled Run can't be written to: the scheduler closed it.
  String? get scheduleRunReadOnlyReason {
    if (!scheduleRunOpen || session?['state'] != 'closed') return null;
    return 'This run is closed: its conversation is read-only.';
  }

  Future<List<Json>> wikiRepositories() async {
    final result = await _request('GET', '/git/repositories');
    final groups = objects(result['groups']);
    final repositories = [
      for (final g in groups) ...objects(g['repositories']),
    ];
    if (repositories.isEmpty && groups.any((g) => g['error'] != null)) {
      throw StateError(
        groups
            .where((g) => g['error'] != null)
            .map((g) => '${(g['connection'] as Map)['name']}: ${g['error']}')
            .join('\n'),
      );
    }
    return repositories;
  }

  Future<void> saveWiki(Json body, {Wiki? existing}) async {
    final result = await _request(
      existing == null ? 'POST' : 'PATCH',
      existing == null ? '/wikis' : '/wikis/${existing.id}',
      body: body,
    );
    await refresh();
    if (existing == null) {
      await selectWiki(Wiki.fromJson(result['wiki'] as Json));
    }
  }

  // Schedules (docs/specs/schedules.md). The scheduler owns their runs; clients
  // list them, read their history and, for Admins, configure and start them.

  /// The Schedules section, or its list on wide layouts.
  void showSchedules() {
    scheduleSection = true;
    schedule = null;
    scheduleRuns = [];
    project = null;
    task = null;
    wikiSection = false;
    wiki = null;
    chats = [];
    openChat = null;
    _clearConversation();
    _subscribe();
    notifyListeners();
  }

  /// Opens a Schedule on its configuration and run history.
  Future<void> selectSchedule(Schedule value) async {
    scheduleSection = true;
    schedule = value;
    scheduleRuns = _cachedScheduleRuns(value.id);
    task = null;
    project = null;
    wikiSection = false;
    wiki = null;
    chats = [];
    openChat = null;
    _clearConversation();
    _subscribe();
    notifyListeners();
    if (!online) return;
    try {
      await _fetchSchedule(value.id);
    } catch (e) {
      _recordError(e);
    }
    notifyListeners();
  }

  /// Back from a Scheduled Run's Task to the Schedule's history.
  void backToScheduleDetail() {
    task = null;
    conversationVisible = false;
    _clearConversation();
    _subscribe();
    notifyListeners();
  }

  /// Back from the Schedule to the Schedules list.
  void backToSchedules() {
    schedule = null;
    scheduleRuns = [];
    task = null;
    conversationVisible = false;
    _clearConversation();
    _subscribe();
    notifyListeners();
  }

  /// Opens the Task of a Scheduled Run in the normal conversation view.
  /// Skipped runs have no Task.
  Future<void> openScheduleRun(ScheduleRun run) async {
    final id = run.taskId;
    if (id == null) return;
    final cached = storage.read('task:$id')?['task'];
    if (!online && cached != null) {
      await selectTask(Task.fromJson(Json.from(cached as Map)));
      return;
    }
    final result = await _request('GET', '/tasks/$id');
    await selectTask(Task.fromJson(result['task'] as Json));
  }

  Future<void> saveSchedule(Json body, {Schedule? existing}) async {
    final result = await _request(
      existing == null ? 'POST' : 'PATCH',
      existing == null ? '/schedules' : '/schedules/${existing.id}',
      body: body,
    );
    final saved = Schedule.fromJson(result['schedule'] as Json);
    _replaceSchedule(saved);
    await _cacheSchedules();
    if (existing == null) {
      await selectSchedule(saved);
    } else if (schedule?.id == saved.id) {
      await _fetchSchedule(saved.id);
      notifyListeners();
    }
  }

  Future<void> setScheduleEnabled(Schedule value, bool enabled) async {
    final result = await _request(
      'PATCH',
      '/schedules/${value.id}',
      body: {'enabled': enabled},
    );
    final fresh = Schedule.fromJson(result['schedule'] as Json);
    _replaceSchedule(fresh);
    await _cacheSchedules();
    if (schedule?.id == fresh.id) schedule = fresh;
    notifyListeners();
  }

  /// Starts a run immediately, ignoring the previous-run check. The next run
  /// time does not move.
  Future<void> runScheduleNow() async {
    final current = schedule;
    if (current == null) return;
    await _request('POST', '/schedules/${current.id}/run');
    await _fetchSchedule(current.id);
    notifyListeners();
  }

  Future<void> deleteSchedule() async {
    final current = schedule;
    if (current == null) return;
    await _request('DELETE', '/schedules/${current.id}');
    for (final run in scheduleRuns) {
      if (run.taskId != null) await storage.write('task:${run.taskId}', {});
    }
    await storage.write('schedule:${current.id}', {});
    schedules = schedules.where((s) => s.id != current.id).toList();
    await _cacheSchedules();
    showSchedules();
  }

  void _replaceSchedule(Schedule fresh) {
    final known = schedules.any((s) => s.id == fresh.id);
    schedules = [
      if (known)
        for (final s in schedules) s.id == fresh.id ? fresh : s
      else ...[...schedules, fresh],
    ]..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  }

  Future<void> _cacheSchedules() => storage.write('schedules', {
    'schedules': [for (final s in schedules) s.json],
  });

  List<ScheduleRun> _cachedScheduleRuns(String id) =>
      objects(storage.read('schedule:$id')?['runs'])
          .map(ScheduleRun.fromJson)
          .toList();

  /// Loads the Schedule's configuration and its run history.
  Future<void> _fetchSchedule(String id) async {
    try {
      final results = await Future.wait([
        _request('GET', '/schedules/$id'),
        _request('GET', '/schedules/$id/runs'),
      ]);
      final fresh = Schedule.fromJson(results[0]['schedule'] as Json);
      _replaceSchedule(fresh);
      await _cacheSchedules();
      if (schedule?.id != id) return;
      schedule = fresh;
      final rawRuns = objects(results[1]['runs']);
      scheduleRuns = rawRuns.map(ScheduleRun.fromJson).toList();
      await storage.write('schedule:$id', {'runs': rawRuns});
    } on ApiException catch (e) {
      // Another client deleted the Schedule: the list is the truth.
      if (e.status == 404 && schedule?.id == id) {
        schedule = null;
        scheduleRuns = [];
        notifyListeners();
        return;
      }
      rethrow;
    }
  }

  void _clearConversation() {
    timeline = [];
    attachments = [];
    nextCursor = null;
    _olderLoaded = false;
    session = null;
    liveText.clear();
    liveThinking = '';
    liveStatus = '';
    liveSetup = null;
    _clearRuns();
  }

  /// Forgets the Task's Runs: another Task is open, or the connection went.
  void _clearRuns() {
    runs.clear();
    runTranscripts.clear();
    _runBuffered.clear();
    _runWanted.clear();
    _runRefreshed.clear();
    dismissedRuns.clear();
    goneRuns.clear();
    openRunId = null;
  }

  /// Seeds the bar with the Task's active Runs, when it opens or on a refresh.
  void _setActiveRuns(List<Json> listed) {
    final ids = {for (final run in listed) run['id']};
    // Runs the endpoint no longer lists are gone from the backend; the finished
    // ones the reader has seen keep their Timeline row's sheet working.
    for (final run in runs.values.toList()) {
      if (!ids.contains(run['id']) && run['status'] == 'running') {
        runs.remove(run['id']);
      }
    }
    for (final run in listed) {
      _upsertRun(run);
    }
  }

  void _upsertRun(Json run) {
    final id = run['id'] as String?;
    if (id == null) return;
    runs[id] = runs.containsKey(id) ? {...runs[id]!, ...run} : {...run};
  }

  void openRun(String id) {
    openRunId = id;
    _runWanted.add(id);
    notifyListeners();
    unawaited(_fetchRunTranscript(id));
  }

  void closeRun() {
    openRunId = null;
    notifyListeners();
  }

  /// A failure the reader closed leaves the bar, as on the web.
  void dismissRun(String id) {
    dismissedRuns.add(id);
    notifyListeners();
  }

  Future<void> _fetchRunTranscript(String id) async {
    final taskId = task?.id;
    if (taskId == null) return;
    try {
      final result = await _request('GET', '/tasks/$taskId/runs/$id');
      if (task?.id != taskId) return;
      var transcript = result;
      for (final message in _runBuffered.remove(id) ?? const <Json>[]) {
        transcript = _mergeRunMessage(transcript, message);
      }
      runTranscripts[id] = transcript;
      final run = transcript['run'];
      if (run is Map) _upsertRun({...Map<String, dynamic>.from(run), 'id': id});
    } on ApiException catch (e) {
      if (task?.id != taskId) return;
      if (e.status == 404) {
        goneRuns.add(id);
      } else {
        _recordError(e);
      }
    } catch (e) {
      _recordError(e);
    }
    notifyListeners();
  }

  /// Numbers make merging exact: a tool result replaces its message, a new one
  /// appends.
  Json _mergeRunMessage(Json transcript, Json message) {
    final n = message['n'] as int? ?? -1;
    final messages = objects(transcript['messages']);
    if (n < 0) return transcript;
    if (n < messages.length) {
      return {
        ...transcript,
        'messages': [for (final m in messages) m['n'] == n ? message : m],
      };
    }
    if (n > messages.length) return transcript;
    return {
      ...transcript,
      'messages': [...messages, message],
      'nextIndex': messages.length + 1,
    };
  }

  /// A Run starting, moving on or ending, or one message of its transcript.
  void _applyRunEvent(Json event) {
    if (event['taskId'] != task?.id) return;
    if (event['type'] == 'run.updated') {
      final run = event['run'];
      if (run is! Map) return;
      final typed = Map<String, dynamic>.from(run);
      _upsertRun(typed);
      // The last messages can land after the Run's final status: its transcript
      // is fetched once more while the reader has it open.
      final id = typed['id'];
      if (id == openRunId &&
          typed['status'] != 'running' &&
          _runRefreshed.add(id as String)) {
        unawaited(_fetchRunTranscript(id));
      }
    } else {
      final id = event['runId'] as String?;
      final message = event['message'];
      if (id == null || message is! Map) return;
      final typed = Map<String, dynamic>.from(message);
      final transcript = runTranscripts[id];
      if (transcript != null) {
        runTranscripts[id] = _mergeRunMessage(transcript, typed);
      } else if (_runWanted.contains(id)) {
        // The snapshot isn't here yet: hold the message so it isn't lost when
        // it lands.
        final held = _runBuffered.putIfAbsent(id, () => [])..add(typed);
        if (held.length > 2000) held.removeRange(0, held.length - 2000);
      } else {
        return;
      }
    }
    notifyListeners();
  }

  Future<void> deleteWiki() async {
    final current = wiki!;
    await _request('DELETE', '/wikis/${current.id}');
    for (final chat in chats) {
      await storage.write('task:${chat.id}', {});
    }
    await storage.write('task:${current.taskId}', {});
    await storage.write('chats:${current.id}', {});
    showWikis();
    await refresh();
  }

  Future<void> selectProject(Project value) async {
    wikiSection = false;
    wiki = null;
    chats = [];
    openChat = null;
    scheduleSection = false;
    schedule = null;
    scheduleRuns = [];
    project = value;
    task = null;
    timeline = [];
    session = null;
    conversationVisible = false;
    _olderLoaded = false;
    _hydrateProject(value.id);
    _subscribe();
    notifyListeners();
    try {
      await _fetchProject(value.id);
    } catch (e) {
      _recordError(e);
    }
    notifyListeners();
  }

  /// The lists each kind was last parsed into, with their JSON.
  final _parsedLists = <String, (Object?, List<Object>)>{};

  /// Keeps [current] when it was parsed from the same JSON: views compare
  /// these lists by identity to know whether names or pictures changed, and
  /// every refresh fetches them again.
  List<T> _unlessSame<T extends Object>(
    String kind,
    List<T> current,
    Object? raw,
    T Function(Json) parse,
  ) {
    final last = _parsedLists[kind];
    if (last != null &&
        identical(last.$2, current) &&
        _sameJson(last.$1, raw)) {
      return current;
    }
    final parsed = objects(raw).map(parse).toList();
    _parsedLists[kind] = (raw, parsed);
    return parsed;
  }

  void _hydrateProject(String id) {
    final cache = storage.read('project:$id') ?? {};
    statuses = _unlessSame(
      'statuses',
      statuses,
      cache['statuses'],
      TaskStatus.fromJson,
    );
    tags = _unlessSame('tags', tags, cache['tags'], Tag.fromJson);
    tasks = objects(cache['tasks']).map(Task.fromJson).toList();
    preferences = {
      for (final p in objects(
        cache['preferences'],
      ).map(TaskPreference.fromJson))
        p.taskId: p,
    };
  }

  Future<void> _fetchProject(String id) async {
    final result = await Future.wait([
      _request('GET', '/projects/$id'),
      _request('GET', '/projects/$id/tasks?includeClosed=true'),
      _request('GET', '/projects/$id/task-preferences'),
    ]);
    await storage.write('project:$id', {
      'statuses': result[0]['statuses'],
      'tags': result[0]['tags'],
      'tasks': result[1]['tasks'],
      'preferences': result[2]['preferences'],
    });
    if (project?.id == id) {
      project = Project.fromJson(result[0]['project'] as Json);
      _hydrateProject(id);
    }
  }

  /// True while the open Task's first page of the Timeline is on its way and
  /// nothing is cached to show meanwhile.
  bool timelineLoading = false;

  Future<void> selectTask(Task value) async {
    unawaited(push.clearTask(value.id));
    task = value;
    timeline = [];
    scheduledMessages = [];
    attachments = [];
    session = null;
    nextCursor = null;
    _olderLoaded = false;
    liveText.clear();
    liveThinking = '';
    liveStatus = '';
    liveSetup = null;
    _clearRuns();
    final cached = storage.read('task:${value.id}');
    if (cached != null && cached['task'] != null) {
      final cachedTask = Task.fromJson(cached['task'] as Json);
      // A list card newer than the offline cache must not be replaced by it.
      if (cachedTask.version >= value.version) task = cachedTask;
      timeline = objects(cached['items']).map(TimelineEntry.new).toList();
      attachments = objects(cached['attachments']);
      _setScheduled(objects(cached['scheduled']));
      nextCursor = cached['nextCursor'] as String?;
      session = cached['session'] as Json?;
    }
    _subscribe();
    timelineLoading = timeline.isEmpty;
    notifyListeners();
    try {
      await _fetchTask(value.id);
    } catch (e) {
      _recordError(e);
    }
    if (task?.id == value.id) timelineLoading = false;
    notifyListeners();
  }

  Future<void> _fetchTask(String id, [int attempt = 0]) async {
    final epoch = _timelineEpoch;
    final result = await Future.wait([
      _request('GET', '/tasks/$id'),
      _request('GET', '/tasks/$id/timeline'),
      _request('GET', '/tasks/$id/session'),
      _request('GET', '/tasks/$id/preferences'),
      _request('GET', '/tasks/$id/runs'),
      _request('GET', '/tasks/$id/attachments'),
      _request('GET', '/tasks/$id/scheduled-messages'),
    ]);
    if (task?.id != id || epoch != _timelineEpoch) return;
    final fresh = Task.fromJson(result[0]['task'] as Json);
    final pageGeneration = result[1]['chatGeneration'] as int?;
    if (pageGeneration != null && pageGeneration != fresh.chatGeneration) {
      if (attempt < 2) await _fetchTask(id, attempt + 1);
      return;
    }
    if (fresh.chatGeneration != task!.chatGeneration) _clearConversation();
    // A refresh started before a save can resolve after it: never roll the Task back.
    if (fresh.version < task!.version) return;
    task = fresh;
    session = result[2]['session'] as Json?;
    preferences[id] = TaskPreference.fromJson(result[3]['preference'] as Json);
    _setActiveRuns(objects(result[4]['runs']));
    attachments = objects(result[5]['attachments']);
    _setScheduled(objects(result[6]['messages']));
    _mergeTimeline(objects(result[1]['items']));
    if (!_olderLoaded) nextCursor = result[1]['nextCursor'] as String?;
    await _cacheTask();
  }

  void _mergeTimeline(List<Json> items) {
    final byId = {for (final entry in timeline) entry.id: entry};
    for (final item in items) {
      final id = item['id'] as String, known = byId[id];
      final position = known?.json['readPosition'];
      // Live events carry no position: keep the one already known.
      final json = item['readPosition'] == null && position != null
          ? {...item, 'readPosition': position}
          : item;
      // An unchanged Entry stays the same object, so the Timeline keeps what
      // it built for it instead of rebuilding every row on each refresh.
      if (known == null || !_sameJson(known.json, json)) {
        byId[id] = TimelineEntry(json);
      }
    }
    // Display order is the server's and the web's: creation time, then kind,
    // then id (loadTimeline's `created_at, kind, id`, oldest first). The read
    // position tracks reading only; it can be missing or '0', and sorting by
    // it showed the conversation newest first.
    timeline = byId.values.toList()
      ..sort((a, b) {
        final time = a.createdAt.compareTo(b.createdAt);
        if (time != 0) return time;
        final kind = a.type.compareTo(b.type);
        return kind != 0 ? kind : a.id.compareTo(b.id);
      });
  }

  static bool _sameJson(Object? a, Object? b) {
    if (identical(a, b)) return true;
    if (a is Map && b is Map) {
      if (a.length != b.length) return false;
      for (final MapEntry(:key, :value) in a.entries) {
        if (!b.containsKey(key) || !_sameJson(value, b[key])) return false;
      }
      return true;
    }
    if (a is List && b is List) {
      if (a.length != b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (!_sameJson(a[i], b[i])) return false;
      }
      return true;
    }
    return a == b;
  }

  Future<void> _cacheTask() async {
    final t = task;
    if (t == null) return;
    await storage.write('task:${t.id}', {
      'task': {
        'id': t.id,
        'projectId': t.projectId,
        'key': t.key,
        'title': t.title,
        'description': t.description,
        'statusId': t.statusId,
        'priority': t.priority,
        'agentId': t.agentId,
        'tagIds': t.tagIds,
        'assigneeIds': t.assigneeIds,
        'version': t.version,
        'chatGeneration': t.chatGeneration,
        'branchName': t.branchName,
        'branchUrl': t.branchUrl,
        'pullRequest': t.pullRequest,
        'autoResume': t.autoResume,
      },
      'items': timeline.map((e) => e.json).toList(),
      'attachments': attachments,
      'scheduled': scheduledMessages.map((m) => m.json).toList(),
      'nextCursor': nextCursor,
      'session': session,
    });
  }

  Future<void> loadOlder() async {
    if (task == null || nextCursor == null || !online) return;
    final id = task!.id, epoch = _timelineEpoch;
    final result = await _request(
      'GET',
      '/tasks/$id/timeline?before=${Uri.encodeQueryComponent(nextCursor!)}',
    );
    if (task?.id != id || epoch != _timelineEpoch) return;
    final generation = result['chatGeneration'] as int?;
    if (generation != null && generation != task!.chatGeneration) {
      await _fetchTask(id);
      notifyListeners();
      return;
    }
    _mergeTimeline(objects(result['items']));
    nextCursor = result['nextCursor'] as String?;
    _olderLoaded = true;
    await _cacheTask();
    notifyListeners();
  }

  Future<List<Json>> uploadTaskFiles(
    String taskId,
    List<DraftFile> files,
  ) async {
    final result = await _request(
      'POST',
      '/tasks/$taskId/attachments',
      files: files,
    );
    return objects(result['attachments']);
  }

  Future<Task?> createTask({
    required String title,
    String description = '',
    String? agentId,
  }) async {
    final projectId = project!.id;
    final result = await _request(
      'POST',
      '/projects/$projectId/tasks',
      body: {'title': title, 'description': description},
    );
    final created = Task.fromJson(result['task'] as Json);
    assignmentRetryId = null;
    assignmentRetryTaskId = null;
    await selectTask(created);
    if (agentId != null) {
      try {
        await updateTask({'agentId': agentId});
      } catch (e) {
        assignmentRetryId = agentId;
        assignmentRetryTaskId = created.id;
        error = 'Task created. Agent assignment failed: ${_message(e)}';
      }
    }
    unawaited(
      _fetchProject(projectId)
          .then((_) => notifyListeners())
          .catchError((Object _) {}),
    );
    notifyListeners();
    return task;
  }

  Future<void> retryAssignment() async {
    final id = assignmentRetryId;
    final taskId = assignmentRetryTaskId;
    if (id == null || taskId == null) return;
    // Target the Task that failed, not whichever Task happens to be open now.
    final result = await _request('GET', '/tasks/$taskId');
    final current = Task.fromJson(result['task'] as Json);
    final patched = await _request(
      'PATCH',
      '/tasks/$taskId',
      body: {'version': current.version, 'agentId': id},
    );
    final updated = Task.fromJson(patched['task'] as Json);
    if (task?.id == taskId) {
      task = updated;
      await _cacheTask();
    }
    assignmentRetryId = null;
    assignmentRetryTaskId = null;
    notifyListeners();
  }

  /// Creates a Tag in the open Project, with the next color of the web app's
  /// cycle, and adds it to the Project's Tags.
  Future<Tag> createTag(String name) async {
    final current = project!;
    final result = await _request(
      'POST',
      '/projects/${current.id}/tags',
      body: {
        'name': name,
        'color': _tagColors[tags.length % _tagColors.length],
      },
    );
    final json = result['tag'] as Json, tag = Tag.fromJson(json);
    if (project?.id == current.id) {
      tags = [...tags.where((t) => t.id != tag.id), tag];
      final key = 'project:${current.id}';
      final cache = storage.read(key) ?? {};
      await storage.write(key, {
        ...cache,
        'tags': [
          ...objects(cache['tags']).where((t) => t['id'] != tag.id),
          json,
        ],
      });
      notifyListeners();
    }
    return tag;
  }

  Future<void> updateTask(Json fields) async {
    final current = task!;
    final result = await _request(
      'PATCH',
      '/tasks/${current.id}',
      body: {'version': current.version, ...fields},
    );
    if (task?.id == current.id) {
      task = Task.fromJson(result['task'] as Json);
      if (fields.containsKey('agentId') &&
          assignmentRetryTaskId == current.id) {
        assignmentRetryId = null;
        assignmentRetryTaskId = null;
      }
      await _cacheTask();
      notifyListeners();
    }
  }

  /// Pending first by due time, then the finished ones, newest first.
  void _setScheduled(List<Json> messages) {
    final list = messages.map(ScheduledMessage.fromJson).toList();
    scheduledMessages = [
      ...list.where((m) => m.pending).toList()
        ..sort((a, b) => a.dueAt.compareTo(b.dueAt)),
      ...list.where((m) => !m.pending).toList()
        ..sort((a, b) => b.dueAt.compareTo(a.dueAt)),
    ];
  }

  void _upsertScheduled(Json message) {
    final id = message['id'];
    _setScheduled([
      for (final m in scheduledMessages)
        if (m.id != id) m.json,
      message,
    ]);
  }

  /// Plans a Comment for [dueAt] from the draft. Scheduling needs the
  /// connection and is never queued: offline, the draft stays as it is.
  Future<bool> scheduleDraft(DateTime dueAt) async {
    if (sending ||
        task == null ||
        chatReadOnlyReason != null ||
        scheduleRunReadOnlyReason != null) {
      return false;
    }
    if (!online) {
      error = 'Offline. Scheduling needs a connection; the draft is kept.';
      notifyListeners();
      return false;
    }
    final current = task!, value = draft;
    if (value.text.trim().isEmpty && value.files.isEmpty) return false;
    sending = true;
    error = null;
    notifyListeners();
    try {
      final result = await _request(
        'POST',
        '/tasks/${current.id}/scheduled-messages',
        body: {
          'body': value.text,
          'internal': value.internal,
          'dueAt': dueAt.toUtc().toIso8601String(),
        },
        files: value.files,
      );
      await storage.write('draft:${current.id}', const Draft().toJson());
      if (task?.id == current.id) {
        _upsertScheduled(Json.from(result['message'] as Map));
        await _cacheTask();
      }
      return true;
    } catch (e) {
      _recordError(e);
      return false;
    } finally {
      sending = false;
      notifyListeners();
    }
  }

  /// Edits, cancels or sends now a Scheduled Message; all need a connection.
  /// A `409` (it left `pending` meanwhile) refreshes the list.
  Future<bool> changeScheduled(
    String id,
    String method,
    String path, {
    Json? body,
  }) async {
    final current = task;
    if (current == null) return false;
    if (!online) {
      error = 'Offline. Scheduled messages can only change online.';
      notifyListeners();
      return false;
    }
    error = null;
    try {
      final result = await _request(method, path, body: body);
      if (task?.id == current.id) {
        _upsertScheduled(Json.from(result['message'] as Map));
        await _cacheTask();
      }
      return true;
    } catch (e) {
      _recordError(e);
      if (e is ApiException && e.status == 409 && task?.id == current.id) {
        try {
          await _fetchTask(current.id);
        } catch (_) {
          /* The banner already explains; the next refresh catches up. */
        }
      }
      return false;
    } finally {
      notifyListeners();
    }
  }

  Future<bool> editScheduled(String id, {String? body, DateTime? dueAt}) =>
      changeScheduled(
        id,
        'PATCH',
        '/scheduled-messages/$id',
        body: {
          'body': ?body,
          if (dueAt != null) 'dueAt': dueAt.toUtc().toIso8601String(),
        },
      );
  Future<bool> cancelScheduled(String id) =>
      changeScheduled(id, 'DELETE', '/scheduled-messages/$id');
  Future<bool> sendScheduledNow(String id) =>
      changeScheduled(id, 'POST', '/scheduled-messages/$id/send');

  /// Answers the offer on a usage limit's System Comment. The first answer
  /// wins: a `409` refreshes the conversation and says who answered.
  Future<bool> answerLimitResume(String commentId, bool schedule) async {
    final current = task;
    if (current == null) return false;
    if (!online) {
      error = 'Offline. Answer once back online.';
      notifyListeners();
      return false;
    }
    error = null;
    try {
      final result = await _request(
        'POST',
        '/comments/$commentId/limit-resume',
        body: {'schedule': schedule},
      );
      final comment = result['comment'] as Map;
      if (task?.id == current.id && comment['taskId'] == current.id) {
        _mergeTimeline([
          {
            'type': 'comment',
            'id': comment['id'],
            'createdAt': comment['createdAt'],
            'comment': Json.from(comment),
          },
        ]);
        await _cacheTask();
      }
      return true;
    } catch (e) {
      _recordError(e);
      if (e is ApiException && e.status == 409 && task?.id == current.id) {
        try {
          await _fetchTask(current.id);
        } catch (_) {
          /* The banner already explains; the next refresh catches up. */
        }
      }
      return false;
    } finally {
      notifyListeners();
    }
  }

  Future<void> setAutoResume(bool enabled) async {
    final current = task!;
    final result = await _request(
      'PUT',
      '/tasks/${current.id}/auto-resume',
      body: {'enabled': enabled},
    );
    if (task?.id == current.id) {
      task = Task.fromJson(result['task'] as Json);
      await _cacheTask();
      notifyListeners();
    }
  }

  Future<void> setDraft(Draft value) async {
    if (task != null) {
      await storage.write('draft:${task!.id}', value.toJson());
      notifyListeners();
    }
  }

  /// Saves what the User typed. The composer already shows it, and nothing
  /// else shows the draft's text, so nothing is rebuilt: rebuilding the whole
  /// app on every keystroke made typing lag.
  Future<void> setDraftText(String text) async {
    if (task != null) {
      await storage.write(
        'draft:${task!.id}',
        draft.copyWith(text: text).toJson(),
      );
    }
  }

  Future<void> send() async {
    if (sending ||
        task == null ||
        chatReadOnlyReason != null ||
        scheduleRunReadOnlyReason != null) {
      return;
    }
    if (!online) {
      error = 'Offline. Draft saved; send manually after reconnecting.';
      notifyListeners();
      return;
    }
    final current = task!, value = draft;
    if (value.ambiguous) {
      error =
          'Refresh and review the conversation before choosing Try manually.';
      notifyListeners();
      return;
    }
    if (value.text.trim().isEmpty && value.files.isEmpty) return;
    sending = true;
    error = null;
    notifyListeners();
    try {
      await storage.write(
        'draft:${current.id}',
        value.copyWith(ambiguous: true).toJson(),
      );
      final result = await _request(
        'POST',
        '/tasks/${current.id}/comments',
        body: {'body': value.text, 'internal': value.internal},
        files: value.files,
      );
      final comment = result['comment'] as Json;
      await storage.write('draft:${current.id}', const Draft().toJson());
      if (task?.id == current.id) {
        _mergeTimeline([
          {
            'type': 'comment',
            'id': comment['id'],
            'createdAt': comment['createdAt'],
            'comment': comment,
          },
        ]);
        await _cacheTask();
      }
    } catch (e) {
      final ambiguous = e is! ApiException || e.status >= 500;
      if (user != null) {
        await storage.write(
          'draft:${current.id}',
          value.copyWith(ambiguous: ambiguous).toJson(),
        );
      }
      error = ambiguous
          ? 'Send outcome unknown. Draft saved. Refresh and review the conversation before trying manually.'
          : _message(e);
    } finally {
      sending = false;
      notifyListeners();
    }
  }

  Future<void> reconcileSend() async {
    await _fetchTask(task!.id);
    await setDraft(draft.copyWith(ambiguous: false));
    error = 'Conversation refreshed. Check for your Comment; sending again is a manual action.';
    notifyListeners();
  }

  Future<void> editComment(String id, String text) async {
    await _request('PATCH', '/comments/$id', body: {'body': text});
    await _fetchTask(task!.id);
    notifyListeners();
  }

  Future<void> deleteComment(String id) async {
    await _request('DELETE', '/comments/$id');
    await _fetchTask(task!.id);
    notifyListeners();
  }

  /// Answers an Agent's Question; true once the answer is recorded. The first
  /// answer wins: a later one refreshes the Timeline and says who answered.
  Future<bool> answerQuestion(String commentId, List<QuestionAnswer> answers) =>
      _answer(
        'POST',
        '/comments/$commentId/answer',
        answers,
        (result) => [result['question'], result['answer']],
      );

  /// Saves or updates the signed-in User's response to an open Survey.
  Future<bool> respondToSurvey(
    String commentId,
    List<QuestionAnswer> answers,
  ) => _answer(
    'PUT',
    '/comments/$commentId/response',
    answers,
    (result) => [result['comment']],
  );

  /// "Send now": closes an open Survey and sends its results to the Agent.
  Future<bool> closeSurvey(String commentId) => _answer(
    'POST',
    '/comments/$commentId/close',
    null,
    (result) => [result['comment']],
  );

  /// Answering needs a connection: offline, the card keeps its selection and
  /// the banner says to answer later. Failures land in [error], and a `409`
  /// (answered or closed meanwhile) refreshes the conversation.
  Future<bool> _answer(
    String method,
    String path,
    List<QuestionAnswer>? answers,
    List<Object?> Function(Json result) comments,
  ) async {
    final current = task;
    if (current == null) return false;
    if (!online) {
      error = 'Offline. Your choices are kept; answer once back online.';
      notifyListeners();
      return false;
    }
    error = null;
    try {
      final result = await _request(
        method,
        path,
        body: answers == null
            ? null
            : {'answers': answers.map((a) => a.toJson()).toList()},
      );
      if (task?.id == current.id) {
        _mergeTimeline([
          for (final comment in comments(result))
            if (comment is Map && comment['taskId'] == current.id)
              {
                'type': 'comment',
                'id': comment['id'],
                'createdAt': comment['createdAt'],
                'comment': Json.from(comment),
              },
        ]);
        await _cacheTask();
      }
      return true;
    } catch (e) {
      _recordError(e);
      if (e is ApiException && e.status == 409 && task?.id == current.id) {
        try {
          await _fetchTask(current.id);
        } catch (_) {
          /* The banner already explains; the next refresh catches up. */
        }
      }
      return false;
    } finally {
      notifyListeners();
    }
  }

  /// Moves a Task to [statusId], below [afterTaskId] or above [beforeTaskId]
  /// (neither: the end of the column). The list shows the result right away;
  /// the refresh that follows reconciles it.
  Future<void> moveTask(
    Task moving,
    String statusId, {
    String? afterTaskId,
    String? beforeTaskId,
  }) async {
    final before = List<Task>.of(tasks);
    final previousOpen = task;
    final local = _inProject(moving)
        ? _placeTask(
            Task.movedTo(moving, statusId),
            statusId,
            afterTaskId,
            beforeTaskId,
          )
        : null;
    if (local != null) notifyListeners();
    final Json result;
    try {
      result = await _request(
        'POST',
        '/tasks/${moving.id}/move',
        body: {
          'statusId': statusId,
          'afterTaskId': ?afterTaskId,
          'beforeTaskId': ?beforeTaskId,
        },
      );
    } catch (_) {
      if (local != null) {
        _restoreTask(moving, before.indexWhere((t) => t.id == moving.id));
        if (task?.id == moving.id) task = previousOpen;
        notifyListeners();
      }
      rethrow;
    }
    final moved = Task.fromJson(result['task'] as Json);
    if (moved.projectId == project?.id) {
      _placeTask(moved, statusId, afterTaskId, beforeTaskId);
      notifyListeners();
    }
    unawaited(refresh().catchError((Object _) {}));
  }

  bool _inProject(Task t) => t.projectId == project?.id;

  /// Puts back a Task shown elsewhere, leaving the changes of others alone.
  void _restoreTask(Task original, int index) {
    tasks.removeWhere((t) => t.id == original.id);
    tasks.insert(index.clamp(0, tasks.length), original);
  }

  /// Puts [moved] in the list at its new place; null when it isn't there.
  Task? _placeTask(
    Task moved,
    String statusId,
    String? afterTaskId,
    String? beforeTaskId,
  ) {
    tasks.removeWhere((t) => t.id == moved.id);
    var at = tasks.lastIndexWhere((t) => t.statusId == statusId) + 1;
    final after = tasks.indexWhere((t) => t.id == afterTaskId);
    final before = tasks.indexWhere((t) => t.id == beforeTaskId);
    if (after >= 0) {
      at = after + 1;
    } else if (before >= 0) {
      at = before;
    }
    tasks.insert(at, moved);
    if (task?.id == moved.id) task = moved;
    return moved;
  }

  /// Moves [ids] to the end of [statusId] ("closing" is a move to a `closed`
  /// Status), or deletes them. Each Task is handled on its own: the ones the
  /// backend refused come back with the reason.
  Future<BulkResult> bulkTasks(
    String action,
    List<String> ids, {
    String? statusId,
  }) async {
    final before = List<Task>.of(tasks);
    final shown = <String>{};
    if (action == 'move' && statusId != null) {
      for (final id in ids) {
        final t = tasks.where((t) => t.id == id).firstOrNull;
        if (t == null) continue;
        _placeTask(Task.movedTo(t, statusId), statusId, null, null);
        shown.add(id);
      }
      if (shown.isNotEmpty) notifyListeners();
    }
    final Json result;
    try {
      result = await _request(
        'POST',
        '/projects/${project!.id}/tasks/bulk',
        body: {'action': action, 'taskIds': ids, 'statusId': ?statusId},
      );
    } catch (_) {
      if (shown.isNotEmpty) {
        for (final t in before.where((t) => shown.contains(t.id))) {
          _restoreTask(t, before.indexOf(t));
        }
        notifyListeners();
      }
      rethrow;
    }
    final done = strings(result['succeeded']).toSet();
    final refused = {
      for (final f in objects(result['failed'])) f['taskId'] as String,
    };
    if (shown.isNotEmpty && refused.isNotEmpty) {
      for (final t in before.where((t) => refused.contains(t.id))) {
        final i = tasks.indexWhere((x) => x.id == t.id);
        if (i >= 0) tasks[i] = t;
      }
      notifyListeners();
    }
    if (action == 'delete') {
      for (final id in done) {
        await storage.write('task:$id', {});
        await storage.write('draft:$id', const Draft().toJson());
      }
      tasks.removeWhere((t) => done.contains(t.id));
      if (task != null && done.contains(task!.id)) backToTasks();
      notifyListeners();
    }
    unawaited(refresh().catchError((Object _) {}));
    return BulkResult(done.length, {
      for (final f in objects(result['failed']))
        f['taskId'] as String: f['message'] as String? ?? 'Failed',
    });
  }

  Future<void> deleteTask() async {
    final current = task!;
    await _request('DELETE', '/tasks/${current.id}');
    if (task?.id == current.id) backToTasks();
    tasks.removeWhere((t) => t.id == current.id);
    await storage.write('task:${current.id}', {});
    await storage.write('draft:${current.id}', const Draft().toJson());
    notifyListeners();
  }

  Future<void> sessionAction(String action) async {
    final result = await _request('POST', '/tasks/${task!.id}/session/$action');
    session = result['session'] as Json?;
    notifyListeners();
  }

  Future<void> mergePullRequest() async {
    final current = task!;
    final result = await _request(
      'POST',
      '/tasks/${current.id}/pull-request/merge',
    );
    if (task?.id == current.id) {
      task = Task.fromJson(result['task'] as Json);
      await _cacheTask();
      notifyListeners();
    }
  }

  Future<void> setPreference(Json patch) async {
    final result = await _request(
      'PATCH',
      '/tasks/${task!.id}/preferences',
      body: patch,
    );
    final pref = TaskPreference.fromJson(result['preference'] as Json);
    preferences[pref.taskId] = pref;
    notifyListeners();
  }

  Future<void> reachedLatest() async {
    if (!conversationVisible ||
        !appVisible ||
        !online ||
        task == null ||
        timeline.isEmpty) {
      return;
    }
    final id = task!.id;
    final result = await _request(
      'PUT',
      '/tasks/$id/read-position',
      body: {'itemId': timeline.last.id},
    );
    preferences[id] = TaskPreference.fromJson(result['preference'] as Json);
    notifyListeners();
  }

  /// Moves the User's read position to the newest entry of every Task of the
  /// open Project at once.
  Future<void> markProjectRead() async {
    final p = project;
    if (p == null || !online) return;
    final result = await _request('POST', '/projects/${p.id}/read-all');
    for (final item in objects(result['preferences'])) {
      final pref = TaskPreference.fromJson(item);
      preferences[pref.taskId] = pref;
    }
    notifyListeners();
    // The Project badges count unread Turns: refetch them.
    _refreshProjectsSoon();
  }

  Future<File> downloadAttachment(Json attachment) async {
    final file = await storage.attachment(
      attachment['id'] as String,
      attachment['filename'] as String,
    );
    if (await file.exists()) return file;
    if (!online) {
      throw StateError('Only downloaded attachments are available offline');
    }
    final bytes = await api!.download(attachment['url'] as String);
    await file.writeAsBytes(bytes, flush: true);
    return file;
  }

  Future<void> enableNotifications() async {
    final status = await _request('GET', '/notifications/status');
    if (status['configured'] != true) {
      error = 'Phone push is not configured on this installation';
      notifyListeners();
      return;
    }
    final token = await push.enable();
    if (token != null) await _registerToken(token);
    notifyListeners();
  }

  Future<void> _registerToken(String token) async {
    if (_login == null || (!Platform.isIOS && !Platform.isAndroid)) return;
    await _request(
      'PUT',
      '/notifications/devices',
      body: {
        'deviceId': _login!['deviceId'],
        'platform': Platform.isIOS ? 'ios' : 'android',
        'token': token,
      },
    );
  }

  Future<void> openNotification(String id) async {
    pendingTaskId = id;
    if (user != null && !user!.mustChangePassword) await _openPending();
  }

  Future<void> _openPending() async {
    final id = pendingTaskId;
    if (id == null || user == null || user!.mustChangePassword) return;
    try {
      final result = await _request('GET', '/tasks/$id');
      final target = Task.fromJson(result['task'] as Json);
      if (!projects.any((p) => p.id == target.projectId)) await refresh();
      final targetWiki = wikis
          .where((w) => w.id == target.projectId || w.taskId == target.id)
          .firstOrNull;
      if (targetWiki != null) {
        await selectWiki(targetWiki, chatId: target.id);
        pendingTaskId = null;
        return;
      }
      // A Scheduled Run's Task opens within its Schedule, as on the web.
      final targetSchedule = schedules
          .where((s) => s.projectId == target.projectId)
          .firstOrNull;
      if (targetSchedule != null) {
        await selectSchedule(targetSchedule);
        await selectTask(target);
        pendingTaskId = null;
        notifyListeners();
        return;
      }
      final matches = projects.where((p) => p.id == target.projectId);
      if (matches.isEmpty) return;
      await selectProject(matches.first);
      await selectTask(target);
      pendingTaskId = null;
      notifyListeners();
    } catch (e) {
      _recordError(e);
      notifyListeners();
    }
  }

  void _event(Json event) {
    final type = event['type'] as String? ?? '';
    if (type.startsWith('voice.')) {
      voice.handle(event);
      return;
    }
    if (type == 'login.expired') {
      unawaited(_expire());
      return;
    }
    if (type == 'task.preference') {
      final pref = TaskPreference.fromJson(event['preference'] as Json);
      preferences[pref.taskId] = pref;
      notifyListeners();
      // Reading or muting a Task changes its Project's unread badge.
      _refreshProjectsSoon();
      return;
    }
    if (type == 'project.activity') {
      _refreshProjectsSoon();
      return;
    }
    if (type == 'scheduled_message.updated') {
      final message = Json.from(event['message'] as Map);
      if (message['taskId'] == task?.id) {
        _upsertScheduled(message);
        unawaited(_cacheTask());
        notifyListeners();
      }
      return;
    }
    if (type == 'schedule.changed') {
      // The event carries only the id: refetch the list and the open Schedule.
      unawaited(() async {
        try {
          final result = await _request('GET', '/schedules');
          final raw = objects(result['schedules']);
          schedules = raw.map(Schedule.fromJson).toList();
          await storage.write('schedules', {'schedules': raw});
          final open = schedule;
          if (open != null) await _fetchSchedule(open.id);
          notifyListeners();
        } catch (e) {
          _recordError(e);
          notifyListeners();
        }
      }());
      return;
    }
    if (type == 'live.delta' && event['taskId'] == task?.id) {
      final delta = event['delta'] as Json;
      if (delta['kind'] == 'thinking') {
        liveThinking += delta['text'] as String;
      } else {
        final id = delta['commentId'] as String? ?? 'current';
        // A new box starts clamped.
        if (!liveText.containsKey(id)) liveExpanded.remove(id);
        liveText[id] = (liveText[id] ?? '') + (delta['text'] as String);
      }
      _live.value++;
      return;
    }
    if (type == 'live.context') {
      // Also from the Project's topic, so the Task list follows every running Task.
      liveContexts[event['taskId'] as String] = Json.from(
        event['context'] as Map,
      );
      notifyListeners();
      return;
    }
    if (type == 'live.status' && event['taskId'] == task?.id) {
      liveStatus = event['status'] == null ? '' : 'Agent retrying request';
      _live.value++;
      return;
    }
    if (type == 'job.setup_output' && event['taskId'] == task?.id) {
      final jobId = event['jobId'] as String? ?? '';
      // A new Job's output starts over; the same Job's chunks append.
      final output =
          (liveSetup?['jobId'] == jobId ? liveSetup!['output'] as String : '') +
          (event['chunk'] as String? ?? '');
      liveSetup = {
        'jobId': jobId,
        'output': output.length > setupOutputCap
            ? output.substring(output.length - setupOutputCap)
            : output,
      };
      _live.value++;
      return;
    }
    if (type.startsWith('run.') && event['taskId'] == task?.id) {
      _applyRunEvent(event);
      return;
    }
    if (type == 'timeline.reset') {
      final id = event['taskId'] as String;
      if (id == task?.id) {
        liveContexts.remove(event['taskId']);
        _timelineEpoch++;
        _clearConversation();
        unawaited(_cacheTask());
        notifyListeners();
      } else {
        unawaited(storage.write('task:$id', {}));
      }
    }
    if (type == 'task.removed' && event['taskId'] == task?.id) {
      task = null;
      timeline = [];
      _subscribe();
      notifyListeners();
    }
    // Apply the new projection right away, in the same frame that retires its
    // live preview, so streamed text never vanishes before the stored version
    // shows up (the debounced refresh below only reconciles).
    final entry = _timelineEntry(type, event);
    if (entry != null) {
      _mergeTimeline([entry]);
      _retireLive(type, event);
      notifyListeners();
    }
    if (type == 'session.changed' && event['taskId'] == task?.id) {
      session = event['session'] as Json?;
      if (session?['state'] != 'running') {
        liveContexts.remove(task!.id);
        liveText.clear();
        liveThinking = '';
        liveStatus = '';
      }
      notifyListeners();
    }
    _refreshTimer?.cancel();
    _refreshTimer = Timer(const Duration(milliseconds: 180), () {
      unawaited(
        refresh().catchError((Object e) {
          _recordError(e);
          notifyListeners();
        }),
      );
    });
  }

  /// The Timeline item a Task event carries, shaped like the timeline API's.
  Json? _timelineEntry(String type, Json event) {
    final (kind, key) = type.startsWith('comment.')
        ? ('comment', 'comment')
        : type == 'revision.created'
        ? ('revision', 'revision')
        : type.startsWith('agent_item.')
        ? ('agent', 'item')
        : (null, null);
    final value = key == null ? null : event[key] as Map?;
    if (kind == null || value == null || value['taskId'] != task?.id) {
      return null;
    }
    // An update to an entry that isn't loaded (an older page) waits for the
    // refresh, instead of landing at the bottom.
    if (!type.endsWith('.created') &&
        !timeline.any((e) => e.id == value['id'])) {
      return null;
    }
    return {
      'type': kind,
      'id': value['id'],
      'createdAt': value['createdAt'],
      key!: Map<String, dynamic>.from(value),
    };
  }

  /// The stored version arrived: its live preview has done its job (as on the web).
  void _retireLive(String type, Json event) {
    if (type.startsWith('comment.')) {
      final comment = event['comment'] as Map;
      final id = comment['id'] as String;
      final wasExpanded =
          liveExpanded.remove(id) |
          (comment['kind'] == 'agent' && liveExpanded.remove('current'));
      if (wasExpanded) expandedComments.add(id);
      liveText.remove(id);
      if (comment['kind'] == 'agent') liveText.remove('current');
    } else if (type.startsWith('agent_item.')) {
      switch (((event['item'] as Map)['payload'] as Map?)?['kind']) {
        case 'thinking':
          liveThinking = '';
        case 'activity':
          liveText.remove('current');
          liveSetup = null;
        case 'turn_summary':
          liveText.clear();
          liveThinking = '';
          liveStatus = '';
          liveSetup = null;
      }
    }
  }

  void reconnect() {
    _socket?.connect();
    unawaited(
      refresh().catchError((Object e) {
        _recordError(e);
        notifyListeners();
      }),
    );
  }

  void backToTasks() {
    task = null;
    conversationVisible = false;
    wiki = null;
    _subscribe();
    notifyListeners();
  }

  void backToProjects() {
    wiki = null;
    scheduleSection = false;
    schedule = null;
    scheduleRuns = [];
    task = null;
    project = null;
    conversationVisible = false;
    _subscribe();
    notifyListeners();
  }

  void clearError() {
    error = null;
    notifyListeners();
  }

  String _message(Object e) => e is ApiException
      ? e.message
      : e is FormatException
      ? e.message
      : e is StateError
      ? e.message.toString()
      : 'Connection failed. Loaded conversations and drafts remain available.';
  void _recordError(Object e) {
    error = _message(e);
    if (e is SocketException || e is TimeoutException) {
      connection = ConnectionState.offline;
    }
  }

  @override
  void dispose() {
    _live.dispose();
    voice.dispose();
    _socket?.close();
    _refreshTimer?.cancel();
    _projectsTimer?.cancel();
    api?.close();
    unawaited(_events?.cancel());
    unawaited(_states?.cancel());
    unawaited(_pushOpens?.cancel());
    unawaited(_pushTokens?.cancel());
    super.dispose();
  }
}
