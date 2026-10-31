import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart'
    show TestWidgetsFlutterBinding, WidgetTester;
import 'package:flutter/painting.dart' show PaintingBinding;

import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/controller.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/push.dart';
import 'package:claude_task_mobile/src/storage.dart';
import 'package:claude_task_mobile/src/ui/image_cache.dart';
import 'package:file/file.dart' as pkg_file;
import 'package:file/memory.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';

const userData = <String, dynamic>{
  'id': 'user-1',
  'email': 'ada@example.com',
  'displayName': 'Ada',
  'mustChangePassword': false,
};
const projectData = <String, dynamic>{
  'id': 'project-1',
  'key': 'API',
  'name': 'Payments',
};
Json taskData({
  String id = 'task-1',
  String title = 'Fix login',
  String statusId = 'status-1',
}) => {
  'id': id,
  'projectId': 'project-1',
  'key': id == 'task-1' ? 'API-1' : 'API-2',
  'title': title,
  'description': 'A **Markdown** description',
  'statusId': statusId,
  'priority': 'normal',
  'version': 1,
  'tagIds': <String>[],
  'assigneeIds': <String>[],
  'agentId': null,
};

/// Later positions were created later, as on the server.
String at(String position) => DateTime.utc(
  2026,
  10,
  26,
  10,
).add(Duration(seconds: int.parse(position))).toIso8601String();
Json commentData(
  String id,
  String body, {
  bool internal = false,
  String position = '1',
  String kind = 'user',
  Json? author,
  Json? question,
  Json? survey,
  String? answersCommentId,
  Json? limitResume,
}) => {
  'type': 'comment',
  'id': id,
  'createdAt': at(position),
  'readPosition': position,
  'comment': {
    'id': id,
    'taskId': 'task-1',
    'createdAt': at(position),
    'kind': kind,
    'body': body,
    'internal': internal,
    'author':
        author ??
        (kind == 'agent'
            ? {'id': 'agent-1', 'displayName': 'Ada Bot', 'type': 'agent'}
            : {'id': 'user-1', 'displayName': 'Ada', 'type': 'user'}),
    'attachments': <Json>[],
    'delivery': internal || kind != 'user'
        ? null
        : {'state': 'queued', 'reason': null},
    'question': question,
    'survey': survey,
    'answersCommentId': answersCommentId,
    'limitResume': limitResume,
  },
};

/// One file of a Task, as the attachments route returns it: a Comment's
/// (with its author) or the description's (no author).
Json taskAttachmentData(
  String id, {
  String filename = 'notes.txt',
  String contentType = 'text/plain',
  int size = 12,
  Json? author,
  String? createdAt,
}) => {
  'id': id,
  'commentId': author == null ? null : 'comment-1',
  'filename': filename,
  'contentType': contentType,
  'size': size,
  'url': '/api/v1/attachments/$id',
  'createdAt': createdAt ?? at('1'),
  'author': author,
};

const mia = <String, dynamic>{
  'id': 'user-2',
  'displayName': 'Mia',
  'type': 'user',
};
const ada = <String, dynamic>{
  'id': 'user-1',
  'displayName': 'Ada',
  'type': 'user',
};

/// Items of an Agent's Question or Survey: one single and one multiple choice.
List<Json> questionItems() => [
  {
    'header': 'Database',
    'question': 'Which **database** should I use?',
    'options': [
      {'label': 'Postgres', 'description': 'Already in the stack'},
      {'label': 'SQLite', 'description': ''},
    ],
    'multiSelect': false,
  },
  {
    'header': 'Targets',
    'question': 'Where should it run?',
    'options': [
      {'label': 'iOS', 'description': ''},
      {'label': 'Android', 'description': ''},
    ],
    'multiSelect': true,
  },
];

Json questionData({List<Json>? answer, Json? answeredBy}) => {
  'items': questionItems(),
  'state': answer == null ? 'open' : 'answered',
  'answer': answer,
  'answeredBy': answeredBy,
  'answeredAt': answer == null ? null : at('5'),
};

Json surveyData({
  List<Json> responses = const [],
  bool closed = false,
  Json? closedBy,
  List<Json> expected = const [ada, mia],
}) => {
  'items': questionItems(),
  'state': closed ? 'closed' : 'open',
  'expectedRespondents': expected,
  'responses': responses,
  'closedBy': closedBy,
  'closedAt': closed ? at('9') : null,
};

Json responseData(Json user, List<Json> answers, {String position = '4'}) => {
  'user': user,
  'answers': answers,
  'updatedAt': at(position),
};

/// A Scheduled Message, as the API sends it.
Json scheduledData(
  String id, {
  String body = 'Ship it',
  String kind = 'user',
  String state = 'pending',
  String dueAt = '2099-01-02T10:00:00.000Z',
  bool internal = false,
  String? cancelReason,
  List<Json> attachments = const [],
}) => {
  'id': id,
  'taskId': 'task-1',
  'kind': kind,
  'author': kind == 'limit_resume'
      ? {'id': null, 'displayName': 'System', 'type': 'system'}
      : ada,
  'body': body,
  'internal': internal,
  'attachments': attachments,
  'dueAt': dueAt,
  'state': state,
  'cancelReason': cancelReason,
  'commentId': state == 'sent' ? 'comment-1' : null,
  'createdAt': at('1'),
  'updatedAt': at('1'),
};

/// The offer on a usage limit's System Comment.
Json limitResumeData({
  String state = 'open',
  Json? decidedBy,
  String resetsAt = '2099-01-02T10:00:00.000Z',
}) => {
  'resetsAt': resetsAt,
  'state': state,
  'decidedBy': decidedBy,
  'decidedAt': state == 'open' ? null : at('5'),
  'scheduledMessageId': state == 'scheduled' ? 'scheduled-1' : null,
};

Json revisionData(String id, List<Json> changes, {String position = '1'}) => {
  'type': 'revision',
  'id': id,
  'createdAt': '2026-10-26T10:05:00.000Z',
  'readPosition': position,
  'revision': {
    'id': id,
    'taskId': 'task-1',
    'createdAt': '2026-10-26T10:05:00.000Z',
    'actor': {'id': 'user-1', 'displayName': 'Ada'},
    'changes': changes,
  },
};
Json preferenceData({
  bool unread = true,
  String position = '0',
  bool following = true,
  bool muted = false,
}) => {
  'taskId': 'task-1',
  'following': following,
  'muted': muted,
  'unread': unread,
  'readPosition': position,
  'latestPosition': '2',
};

Json runData({
  String id = 'run-1',
  String description = 'Explore the repo',
  String runType = 'subagent',
  String? subagentType = 'Explore',
  String status = 'running',
  int toolCalls = 0,
  String? error,
  String? outcome,
  String startedAt = '2026-10-26T10:00:00.000Z',
  String? finishedAt,
  String? toolUseId = 'task1',
}) => {
  'id': id,
  'runType': runType,
  'toolUseId': toolUseId,
  'description': description,
  'subagentType': subagentType,
  'depth': 1,
  'status': status,
  'startedAt': startedAt,
  'finishedAt': finishedAt,
  'toolCalls': toolCalls,
  'outcome': outcome,
  'error': error,
};

Json runText(int n, String text) => {'type': 'text', 'n': n, 'text': text};
Json runTool(
  int n,
  String name,
  String summary, {
  String status = 'pending',
  String? output,
  String? outcome,
  String? childRunId,
}) => {
  'type': 'tool',
  'n': n,
  'toolUseId': 'tool-$n',
  'name': name,
  'summary': summary,
  'status': status,
  'outcome': outcome,
  'input': {'file_path': 'src/a.ts'},
  'output': output,
  'childRunId': childRunId,
};

Json transcriptData(
  Json run, {
  String? prompt = 'Look around',
  List<Json> messages = const [],
  bool truncated = false,
  Json? usage,
}) => {
  'id': run['id'],
  'run': {...run}..remove('id'),
  'prompt': prompt,
  'usage': usage,
  'messages': messages,
  'nextIndex': messages.length,
  'truncated': truncated,
};

class MemoryStorage implements ProfileStorage {
  Json? login, pending;
  final profiles = <String, Map<String, Json>>{};
  Map<String, Json> data = {};
  String? scope;
  @override
  Future<Json?> readLogin() async => login;
  @override
  Future<void> writeLogin(Json? value) async {
    login = value;
  }

  @override
  Future<void> open(String installation, String userId) async {
    scope = '$installation:$userId';
    data = profiles.putIfAbsent(scope!, () => {});
  }

  @override
  Json? read(String key) => data[key];
  @override
  Future<void> write(String key, Json value) async {
    data[key] = value;
  }

  @override
  Future<void> clear() async {
    if (scope != null) profiles.remove(scope);
    data = {};
    login = null;
  }

  @override
  Future<File> attachment(String id, String filename) async =>
      File('/nonexistent/$id-$filename');
  @override
  Future<DraftFile> stageAttachment(DraftFile file) async => file;
  @override
  Future<Json?> pendingLogout() async => pending;
  @override
  Future<void> savePendingLogout(Json? value) async {
    pending = value;
  }
}

class FakeLive implements LiveConnection {
  final List<Json> sent = [];
  @override
  bool send(Json message) {
    sent.add(message);
    return true;
  }

  final eventController = StreamController<Json>.broadcast(sync: true);
  final stateController = StreamController<ConnectionState>.broadcast(
    sync: true,
  );
  Set<String> topics = {};
  @override
  Stream<Json> get events => eventController.stream;
  @override
  Stream<ConnectionState> get states => stateController.stream;
  @override
  void subscribe(Set<String> value) {
    topics = value;
  }

  @override
  void connect() {}
  @override
  void close() {}
}

class FakePush implements PhonePush {
  final opens = StreamController<String>.broadcast();
  String? initial;
  @override
  String status = 'Phone push is not configured';
  @override
  Stream<String> get taskOpens => opens.stream;
  @override
  Stream<String> get tokens => const Stream.empty();
  @override
  Future<void> initialize() async {}
  @override
  Future<String?> enable() async => null;
  @override
  Future<String?> currentToken() async => null;
  @override
  Future<void> disable() async {}
  @override
  String? takeInitialTask() {
    final id = initial;
    initial = null;
    return id;
  }

  @override
  bool Function(String taskId)? watching;
  final cleared = <String>[];
  @override
  Future<void> clearTask(String taskId) async => cleared.add(taskId);
}

class FakeApi implements TaskApi {
  @override
  Uri installation = Uri.parse('https://tasks.example.com');
  @override
  String? cookie;
  final calls = <String>[];
  Json user = {...userData},
      currentTask = taskData(),
      task2 = taskData(id: 'task-2', title: 'Other task'),
      pref = preferenceData();
  List<Json> items = [
    commentData('comment-1', 'Hello team'),
    commentData('comment-2', 'An Internal Note', internal: true, position: '2'),
  ];
  bool offline = false,
      expire = false,
      failAssignment = false,
      failSend = false,
      partialCreate = false;
  bool hasOlder = false;
  List<Json> projectList = [projectData];
  Json? session;
  int createCount = 0, sendCount = 0, readCount = 0;
  final createdTags = <Json>[];

  /// Every file of the open Task, as the attachments route returns them.
  List<Json> attachments = [];

  /// The Runs the bar lists, and the transcript of each the API still holds.
  List<Json> runs = [];
  final runTranscripts = <String, Json>{};

  /// Answers the Question and Survey routes (`/comments/:id/answer`,
  /// `/response`, `/close`); it may throw an [ApiException].
  Json Function(String method, String path, Json? body)? conversationTool;

  /// The Task's Scheduled Messages.
  List<Json> scheduled = [];

  /// Answers `/scheduled-messages/:id` routes and `/comments/:id/limit-resume`;
  /// it may throw an [ApiException].
  Json Function(String method, String path, Json? body)? scheduleTool;

  /// More open Tasks on the Project's list, after the current one.
  List<Json> extraTasks = [];

  /// What the bulk Task route answers; by default it applies to every Task.
  Json? bulkResult;

  /// The last body sent to each `METHOD /path`.
  final bodies = <String, Json?>{};
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    calls.add('$method $path');
    bodies['$method $path'] = body;
    if (offline) throw const SocketException('offline');
    if (expire) throw const ApiException(401, 'unauthorized', 'Login expired');
    if (path == '/auth/login') {
      cookie = 'ct_login=secret';
      return {'user': user};
    }
    if (path == '/auth/me') return {'user': user};
    if (path == '/auth/password') {
      user = {...user, 'mustChangePassword': false};
      return {'user': user};
    }
    if (path == '/auth/logout') return {};
    if (method == 'GET' && RegExp(r'^/tasks/[^/]+/voice$').hasMatch(path)) {
      return {
        'room': {
          'taskId': path.split('/')[2],
          'taskKey': currentTask['key'],
          'participants': <Json>[],
        },
      };
    }
    if (path == '/wikis') return {'wikis': <Json>[]};
    if (path == '/schedules') return {'schedules': <Json>[]};
    if (path == '/projects') {
      return {'projects': projectList};
    }
    if (path == '/agents') {
      return {
        'agents': [
          {
            'id': 'agent-1',
            'name': 'Ada Bot',
            'enabled': true,
            'avatarEmoji': '🤖',
          },
        ],
      };
    }
    if (path == '/users') {
      return {
        'users': [user],
      };
    }
    if (path == '/projects/project-1') {
      return {
        'project': projectData,
        'statuses': [
          {
            'id': 'status-1',
            'name': 'Open',
            'category': 'open',
            'color': '#999999',
          },
          {
            'id': 'status-2',
            'name': 'Closed',
            'category': 'closed',
            'color': '#999999',
          },
        ],
        'tags': <Json>[],
      };
    }
    if (path == '/projects/project-1/tasks?includeClosed=true') {
      return {
        'tasks': [
          currentTask,
          ...extraTasks,
          taskData(
            id: 'closed-task',
            title: 'Archived Task',
            statusId: 'status-2',
          ),
        ],
      };
    }
    if (path == '/projects/project-1/tasks/bulk' && method == 'POST') {
      return bulkResult ?? {'succeeded': body!['taskIds'], 'failed': <Json>[]};
    }
    final moving = RegExp(r'^/tasks/([^/]+)/move$').firstMatch(path);
    if (moving != null && method == 'POST') {
      final id = moving.group(1)!;
      final base = id == 'task-1'
          ? currentTask
          : extraTasks.firstWhere((t) => t['id'] == id, orElse: () => task2);
      return {
        'task': {...base, 'statusId': body!['statusId']},
      };
    }
    if (path == '/projects/project-1/task-preferences') {
      return {
        'preferences': [pref],
      };
    }
    if (path == '/projects/project-1/tags' && method == 'POST') {
      final tag = {'id': 'tag-${createdTags.length + 1}', ...body!};
      createdTags.add(tag);
      return {'tag': tag};
    }
    if (path == '/projects/project-1/tasks' && method == 'POST') {
      createCount++;
      currentTask = {
        ...taskData(),
        'title': body!['title'],
        'description': body['description'],
      };
      return {'task': currentTask};
    }
    if (path == '/tasks/task-1' && method == 'PATCH') {
      if (failAssignment && body!.containsKey('agentId')) {
        throw const ApiException(409, 'conflict', 'Assignment conflict');
      }
      currentTask = {
        ...currentTask,
        ...body!,
        'version': (currentTask['version'] as int) + 1,
      };
      return {'task': currentTask};
    }
    final other = RegExp(r'^/tasks/task-2(/.*)?$').firstMatch(path);
    if (other != null) {
      if (path == '/tasks/task-2' && method == 'GET') return {'task': task2};
      if (path == '/tasks/task-2' && method == 'PATCH') {
        task2 = {...task2, ...body!, 'version': (task2['version'] as int) + 1};
        return {'task': task2};
      }
      return request(
        method,
        '/tasks/task-1${other.group(1) ?? ''}',
        body: body,
        files: files,
      );
    }
    if (path == '/tasks/task-1/pull-request/merge' && method == 'POST') {
      currentTask = {
        ...currentTask,
        'pullRequest': {
          ...(currentTask['pullRequest'] as Map),
          'state': 'merged',
        },
      };
      return {'task': currentTask};
    }
    if (path == '/tasks/task-1') return {'task': currentTask};
    if (path.startsWith('/tasks/task-1/timeline')) {
      return {
        'items': path.contains('before=')
            ? [commentData('older-1', 'Older page', position: '0')]
            : items.reversed.toList(),
        'nextCursor': hasOlder && !path.contains('before=')
            ? 'older-cursor'
            : null,
      };
    }
    if (path == '/tasks/task-1/attachments') {
      return {'attachments': attachments};
    }
    if (path == '/tasks/task-1/runs') return {'runs': runs};
    final run = RegExp(r'^/tasks/task-1/runs/([^/]+)$').firstMatch(path);
    if (run != null) {
      final transcript = runTranscripts[run.group(1)];
      if (transcript == null) {
        throw const ApiException(404, 'not_found', 'Run not found');
      }
      return transcript;
    }
    if (path == '/tasks/task-1/session') return {'session': session};
    if (path.startsWith('/tasks/task-1/session/') && method == 'POST') {
      session = {...?session, 'unseenChanges': false};
      return {'session': session};
    }
    if (path == '/tasks/task-1/preferences') {
      if (method == 'PATCH') pref = {...pref, ...body!};
      return {'preference': pref};
    }
    if (path == '/tasks/task-1/read-position') {
      readCount++;
      pref = preferenceData(unread: false, position: '2');
      return {'preference': pref};
    }
    if (path == '/tasks/task-1/comments' && method == 'POST') {
      sendCount++;
      if (failSend) throw const SocketException('response lost');
      final entry = commentData(
        'sent-$sendCount',
        body!['body'] as String,
        internal: body['internal'] == true,
        position: '${items.length + 1}',
      );
      items.add(entry);
      return {'comment': entry['comment']};
    }
    if (path == '/tasks/task-1/scheduled-messages') {
      if (method == 'GET') return {'messages': scheduled};
      final message = scheduledData(
        'scheduled-${scheduled.length + 1}',
        body: body!['body'] as String,
        internal: body['internal'] == true,
        dueAt: body['dueAt'] as String,
      );
      scheduled = [...scheduled, message];
      return {'message': message};
    }
    if (path == '/tasks/task-1/auto-resume' && method == 'PUT') {
      currentTask = {
        ...currentTask,
        'autoResume': body!['enabled'],
        'version': (currentTask['version'] as int) + 1,
      };
      return {'task': currentTask};
    }
    if (scheduleTool != null &&
        RegExp(
          r'^/(scheduled-messages/[^/]+(/send)?|comments/[^/]+/limit-resume)$',
        ).hasMatch(path)) {
      return scheduleTool!(method, path, body);
    }
    if (path == '/notifications/status') {
      return {'configured': false, 'provider': 'fcm'};
    }
    if (conversationTool != null &&
        RegExp(r'^/comments/[^/]+/(answer|response|close)$').hasMatch(path)) {
      return conversationTool!(method, path, body);
    }
    if (path.startsWith('/comments/')) return {};
    throw StateError('Unexpected API call: $method $path');
  }

  @override
  Future<Uint8List> download(String path) async => Uint8List(0);
  @override
  void close() {}
}

class Harness {
  final FakeApi api;
  Harness({FakeApi? api}) : api = api ?? FakeApi();
  final live = FakeLive(), storage = MemoryStorage(), push = FakePush();
  late final TaskController controller = TaskController(
    storage: storage,
    push: push,
    apiFactory: (uri, cookie) {
      api.installation = uri;
      api.cookie = cookie;
      return api;
    },
    socketFactory: (_) => live,
  );
  Future<void> login() async {
    await controller.initialize();
    await controller.login(
      'https://tasks.example.com',
      'ada@example.com',
      'password',
    );
    controller.connection = ConnectionState.connected;
  }

  Future<void> openTask() async {
    await controller.selectProject(controller.projects.first);
    await controller.selectTask(controller.tasks.first);
  }

  void dispose() {
    controller.dispose();
  }
}

Json clone(Json json) => jsonDecode(jsonEncode(json)) as Json;

/// Stands in for the disk-backed cache: downloads once per key through the
/// API client and keeps the bytes in memory, with no timers or real IO.
class MemoryImageCache implements BaseCacheManager {
  final TaskApi api;
  final _files = <String, Future<pkg_file.File>>{};
  final _fs = MemoryFileSystem();
  MemoryImageCache(this.api);

  @override
  Stream<FileResponse> getFileStream(
    String url, {
    String? key,
    Map<String, String>? headers,
    bool withProgress = false,
  }) async* {
    final file = await (_files[key ?? url] ??= () async {
      final bytes = await api.download(url);
      return _fs.file('/${_files.length}')..writeAsBytesSync(bytes);
    }());
    yield FileInfo(file, FileSource.Online, DateTime(2100), url);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// A fresh in-memory cache per API client, so tests never share downloads.
void useMemoryImageCache() {
  createImageCacheManager = MemoryImageCache.new;
  TestWidgetsFlutterBinding.ensureInitialized();
  PaintingBinding.instance.imageCache.clear();
}

/// Lets the image cache read and decode files, which needs real async time.
Future<void> settleImages(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.pumpAndSettle();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
  }
  await tester.pumpAndSettle();
}
