import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/controller.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/push.dart';
import 'package:claude_task_mobile/src/storage.dart';

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
Json commentData(
  String id,
  String body, {
  bool internal = false,
  String position = '1',
}) => {
  'type': 'comment',
  'id': id,
  'createdAt': '2026-10-26T10:00:00.000Z',
  'readPosition': position,
  'comment': {
    'id': id,
    'taskId': 'task-1',
    'createdAt': '2026-10-26T10:00:00.000Z',
    'kind': 'user',
    'body': body,
    'internal': internal,
    'author': {'id': 'user-1', 'displayName': 'Ada', 'type': 'user'},
    'attachments': <Json>[],
    'delivery': internal ? null : {'state': 'queued', 'reason': null},
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
}

class FakeApi implements TaskApi {
  @override
  Uri installation = Uri.parse('https://tasks.example.com');
  @override
  String? cookie;
  final calls = <String>[];
  Json user = {...userData}, currentTask = taskData(), pref = preferenceData();
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
  int createCount = 0, sendCount = 0, readCount = 0;
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    calls.add('$method $path');
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
    if (path == '/projects') {
      return {
        'projects': [projectData],
      };
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
          taskData(
            id: 'closed-task',
            title: 'Archived Task',
            statusId: 'status-2',
          ),
        ],
      };
    }
    if (path == '/projects/project-1/task-preferences') {
      return {
        'preferences': [pref],
      };
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
    if (path == '/tasks/task-1/session') return {'session': null};
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
    if (path == '/notifications/status') {
      return {'configured': false, 'provider': 'fcm'};
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
  final api = FakeApi(),
      live = FakeLive(),
      storage = MemoryStorage(),
      push = FakePush();
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
