import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import 'api.dart';
import 'models.dart';
import 'push.dart';
import 'storage.dart';

class TaskController extends ChangeNotifier {
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
  ConnectionState connection = ConnectionState.connecting;
  User? user;
  List<Project> projects = [];
  List<Wiki> wikis = [];
  Wiki? wiki;
  bool wikiSection = false;
  int _timelineEpoch = 0;
  List<Task> tasks = [];
  List<TaskStatus> statuses = [];
  List<Tag> tags = [];
  List<User> users = [];
  List<Agent> agents = [];
  Map<String, TaskPreference> preferences = {};
  Project? project;
  Task? task;
  Json? session;
  List<TimelineEntry> timeline = [];
  String? nextCursor;
  final Map<String, String> liveText = {};
  String liveThinking = '', liveStatus = '';
  bool _olderLoaded = false;
  int _profileEpoch = 0;
  bool get online => connection == ConnectionState.connected;
  Draft get draft => task == null
      ? const Draft()
      : Draft.fromJson(storage.read('draft:${task!.id}') ?? {});
  TaskPreference? get preference => task == null ? null : preferences[task!.id];
  TaskController({
    required this.storage,
    required this.push,
    TaskApi Function(Uri, String?)? apiFactory,
    LiveConnection Function(TaskApi)? socketFactory,
  }) : apiFactory =
           apiFactory ?? ((uri, cookie) => HttpTaskApi(uri, cookie: cookie)),
       socketFactory = socketFactory ?? TaskSocket.new;

  Future<void> initialize() async {
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

  void _hydrateGlobal() {
    final cached = storage.read('global') ?? {};
    projects = objects(cached['projects']).map(Project.fromJson).toList();
    wikis = objects(cached['wikis']).map(Wiki.fromJson).toList();
    if (wiki != null) wiki = wikis.byId(wiki!.id) ?? wiki;
    agents = objects(cached['agents']).map(Agent.fromJson).toList();
    users = objects(cached['users']).map(User.fromJson).toList();
  }

  void _connectSocket() {
    _socket?.close();
    unawaited(_events?.cancel());
    unawaited(_states?.cancel());
    _socket = socketFactory(api!);
    _events = _socket!.events.listen(_event);
    _states = _socket!.states.listen((state) {
      final previous = connection;
      connection = state;
      notifyListeners();
      if (state == ConnectionState.connected &&
          previous != ConnectionState.connected) {
        liveText.clear();
        liveThinking = '';
        unawaited(
          refresh().catchError((Object e) {
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
    if (project != null) 'project:${project!.id}',
    if (task != null) 'task:${task!.id}',
  });
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
    _profileEpoch++;
    _socket?.close();
    user = null;
    conversationVisible = false;
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
    _profileEpoch++;
    final login = _login;
    _socket?.close();
    _refreshTimer?.cancel();
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
    api?.close();
    api = null;
    user = null;
    _login = null;
    projects = [];
    wikis = [];
    wiki = null;
    wikiSection = false;
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
    pendingTaskId = null;
    assignmentRetryId = null;
    error = null;
    notifyListeners();
  }

  Future<void> refresh() {
    _refreshing ??= _refresh().whenComplete(() {
      _refreshing = null;
    });
    return _refreshing!;
  }

  Future<void> _refresh() async {
    if (api == null || user == null || user!.mustChangePassword) return;
    final results = await Future.wait([
      _request('GET', '/projects'),
      _request('GET', '/agents'),
      _request('GET', '/users'),
      _request('GET', '/wikis'),
    ]);
    if (user == null) return;
    await storage.write('global', {
      'projects': results[0]['projects'],
      'agents': results[1]['agents'],
      'users': results[2]['users'],
      'wikis': results[3]['wikis'],
    });
    _hydrateGlobal();
    user = users.byId(user!.id) ?? user;
    final selectedProject = project;
    if (selectedProject != null) await _fetchProject(selectedProject.id);
    final selectedTask = task;
    if (selectedTask != null) await _fetchTask(selectedTask.id);
    error = null;
    notifyListeners();
  }

  void showWikis() {
    wikiSection = true;
    wiki = null;
    project = null;
    task = null;
    _clearConversation();
    _subscribe();
    notifyListeners();
  }

  void showProjects() {
    wikiSection = false;
    backToProjects();
  }

  Future<void> selectWiki(Wiki value) async {
    wikiSection = true;
    wiki = value;
    task = null;
    _clearConversation();
    project = null;
    statuses = [];
    tags = [];
    notifyListeners();
    final cachedTask = storage.read('task:${value.taskId}')?['task'];
    if (!online && cachedTask != null) {
      await selectTask(Task.fromJson(cachedTask as Json));
      return;
    }
    final result = await _request('GET', '/tasks/${value.taskId}');
    if (wiki?.id != value.id) return;
    await selectTask(Task.fromJson(result['task'] as Json));
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
    await selectWiki(Wiki.fromJson(result['wiki'] as Json));
  }

  void _clearConversation() {
    timeline = [];
    nextCursor = null;
    _olderLoaded = false;
    session = null;
    liveText.clear();
    liveThinking = '';
    liveStatus = '';
  }

  Future<void> resetWiki() async {
    final current = wiki!;
    await _request('POST', '/wikis/${current.id}/reset');
    if (wiki?.id != current.id) return;
    _timelineEpoch++;
    _clearConversation();
    await _cacheTask();
    await _fetchTask(current.taskId);
    notifyListeners();
  }

  Future<void> deleteWiki() async {
    final current = wiki!;
    await _request('DELETE', '/wikis/${current.id}');
    await storage.write('task:${current.taskId}', {});
    showWikis();
    await refresh();
  }

  Future<void> selectProject(Project value) async {
    wikiSection = false;
    wiki = null;
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

  void _hydrateProject(String id) {
    final cache = storage.read('project:$id') ?? {};
    statuses = objects(cache['statuses']).map(TaskStatus.fromJson).toList();
    tags = objects(cache['tags']).map(Tag.fromJson).toList();
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

  Future<void> selectTask(Task value) async {
    task = value;
    timeline = [];
    session = null;
    nextCursor = null;
    _olderLoaded = false;
    liveText.clear();
    liveThinking = '';
    liveStatus = '';
    final cached = storage.read('task:${value.id}');
    if (cached != null && cached['task'] != null) {
      task = Task.fromJson(cached['task'] as Json);
      timeline = objects(cached['items']).map(TimelineEntry.new).toList();
      nextCursor = cached['nextCursor'] as String?;
      session = cached['session'] as Json?;
    }
    _subscribe();
    notifyListeners();
    try {
      await _fetchTask(value.id);
    } catch (e) {
      _recordError(e);
    }
    notifyListeners();
  }

  Future<void> _fetchTask(String id, [int attempt = 0]) async {
    final epoch = _timelineEpoch;
    final result = await Future.wait([
      _request('GET', '/tasks/$id'),
      _request('GET', '/tasks/$id/timeline'),
      _request('GET', '/tasks/$id/session'),
      _request('GET', '/tasks/$id/preferences'),
    ]);
    if (task?.id != id || epoch != _timelineEpoch) return;
    final fresh = Task.fromJson(result[0]['task'] as Json);
    final pageGeneration = result[1]['chatGeneration'] as int?;
    if (pageGeneration != null && pageGeneration != fresh.chatGeneration) {
      if (attempt < 2) await _fetchTask(id, attempt + 1);
      return;
    }
    if (fresh.chatGeneration != task!.chatGeneration) _clearConversation();
    task = fresh;
    session = result[2]['session'] as Json?;
    preferences[id] = TaskPreference.fromJson(result[3]['preference'] as Json);
    _mergeTimeline(objects(result[1]['items']));
    if (!_olderLoaded) nextCursor = result[1]['nextCursor'] as String?;
    await _cacheTask();
  }

  void _mergeTimeline(List<Json> items) {
    final byId = {for (final item in timeline) item.id: item.json};
    for (final item in items) {
      final id = item['id'] as String, known = byId[id]?['readPosition'];
      // Live events carry no position: keep the one already known.
      byId[id] = item['readPosition'] == null && known != null
          ? {...item, 'readPosition': known}
          : item;
    }
    // Display order is the server's and the web's: creation time, then kind,
    // then id (loadTimeline's `created_at, kind, id`, oldest first). The read
    // position tracks reading only; it can be missing or '0', and sorting by
    // it showed the conversation newest first.
    timeline = byId.values.map(TimelineEntry.new).toList()
      ..sort((a, b) {
        final time = a.createdAt.compareTo(b.createdAt);
        if (time != 0) return time;
        final kind = a.type.compareTo(b.type);
        return kind != 0 ? kind : a.id.compareTo(b.id);
      });
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
        'pullRequest': t.pullRequestUrl == null
            ? null
            : {'url': t.pullRequestUrl},
      },
      'items': timeline.map((e) => e.json).toList(),
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
    await selectTask(created);
    if (agentId != null) {
      try {
        await updateTask({'agentId': agentId});
      } catch (e) {
        assignmentRetryId = agentId;
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
    if (id == null) return;
    await _fetchTask(task!.id);
    await updateTask({'agentId': id});
    assignmentRetryId = null;
    notifyListeners();
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

  Future<void> send() async {
    if (sending || task == null) return;
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
      final targetWiki = wikis.where((w) => w.taskId == target.id).firstOrNull;
      if (targetWiki != null) {
        await selectWiki(targetWiki);
        pendingTaskId = null;
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
    if (type == 'login.expired') {
      unawaited(_expire());
      return;
    }
    if (type == 'task.preference') {
      final pref = TaskPreference.fromJson(event['preference'] as Json);
      preferences[pref.taskId] = pref;
      notifyListeners();
      return;
    }
    if (type == 'live.delta' && event['taskId'] == task?.id) {
      final delta = event['delta'] as Json;
      if (delta['kind'] == 'thinking') {
        liveThinking += delta['text'] as String;
      } else {
        final id = delta['commentId'] as String? ?? 'current';
        liveText[id] = (liveText[id] ?? '') + (delta['text'] as String);
      }
      notifyListeners();
      return;
    }
    if (type == 'live.status' && event['taskId'] == task?.id) {
      liveStatus = event['status'] == null ? '' : 'Agent retrying request';
      notifyListeners();
      return;
    }
    if (type == 'timeline.reset') {
      final id = event['taskId'] as String;
      if (id == task?.id) {
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
      liveText.remove(comment['id']);
      if (comment['kind'] == 'agent') liveText.remove('current');
    } else if (type.startsWith('agent_item.')) {
      switch (((event['item'] as Map)['payload'] as Map?)?['kind']) {
        case 'thinking':
          liveThinking = '';
        case 'activity':
          liveText.remove('current');
        case 'turn_summary':
          liveText.clear();
          liveThinking = '';
          liveStatus = '';
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
    _socket?.close();
    _refreshTimer?.cancel();
    api?.close();
    unawaited(_events?.cancel());
    unawaited(_states?.cancel());
    unawaited(_pushOpens?.cancel());
    unawaited(_pushTokens?.cancel());
    super.dispose();
  }
}
