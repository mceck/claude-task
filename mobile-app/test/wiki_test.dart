import 'package:claude_task_mobile/src/api.dart' as api_;
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/wiki.dart';
import 'package:claude_task_mobile/src/conversation.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

Json chat(
  String id,
  String title,
  String last, {
  String agentId = 'agent-1',
  bool unread = false,
  bool running = false,
}) => {
  'id': id,
  'wikiId': 'wiki-1',
  'title': title,
  'agentId': agentId,
  'sessionState': 'idle',
  'running': running,
  'unread': unread,
  'createdAt': last,
  'lastActivityAt': last,
};

class WikiApi extends FakeApi {
  bool empty;
  WikiApi({this.empty = false}) {
    if (empty) chats = [];
  }
  Json wiki = {
    'id': 'wiki-1',
    'name': 'Team knowledge',
    'description': 'Shared documentation',
    'taskId': 'task-1',
    'agentId': 'agent-1',
    'repository': {
      'connectionId': 'git-1',
      'providerRepoId': '1',
      'owner': 'acme',
      'name': 'wiki',
      'defaultBranch': 'main',
    },
  };
  List<Json> chats = [
    chat('task-1', 'Hello team', '2026-10-26T10:00:00.000Z'),
    chat(
      'task-2',
      'Older talk',
      '2026-10-25T10:00:00.000Z',
      agentId: 'agent-2',
      unread: true,
    ),
  ];
  int newChats = 0;
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    // Let the base fake apply its offline/expired switches before the Wiki routes.
    if (offline) return super.request(method, path, body: body, files: files);
    if (path == '/wikis' && method == 'GET') {
      return {
        'wikis': empty ? <Json>[] : [wiki],
      };
    }
    if (path == '/wikis/wiki-1/chats' && method == 'GET') {
      calls.add('GET $path');
      return {'chats': chats};
    }
    if (path == '/wikis/wiki-1/chats' && method == 'POST') {
      calls.add('POST $path');
      newChats++;
      return {'chat': chat('task-1', 'Chat', '2026-10-27T10:00:00.000Z')};
    }
    final chatPath = RegExp(r'^/wikis/wiki-1/chats/([^/]+)$').firstMatch(path);
    if (chatPath != null) {
      calls.add('$method $path');
      final id = chatPath.group(1)!;
      bodies['$method $path'] = body;
      if (method == 'PATCH') {
        chats = [
          for (final c in chats)
            if (c['id'] == id) {...c, 'title': body!['title']} else c,
        ];
        return {'chat': chats.firstWhere((c) => c['id'] == id)};
      }
      chats = chats.where((c) => c['id'] != id).toList();
      return {};
    }
    // Chats other than task-1 are served by the same fake Task.
    final other = RegExp(r'^/tasks/task-2(/.*)?$').firstMatch(path);
    if (other != null) {
      if (path == '/tasks/task-2') {
        return {
          'task': {...currentTask, 'id': 'task-2', 'key': 'API-2'},
        };
      }
      return super.request(
        method,
        '/tasks/task-1${other.group(1)}',
        body: body,
        files: files,
      );
    }
    if ((path == '/wikis' && method == 'POST') ||
        (path == '/wikis/wiki-1' && method == 'PATCH')) {
      empty = false;
      wiki = {...wiki, ...body!};
      return {'wiki': wiki};
    }
    if (path == '/git/repositories') {
      return {
        'groups': [
          {
            'repositories': [wiki['repository']],
          },
        ],
      };
    }
    return super.request(method, path, body: body, files: files);
  }
}

void main() {
  test(
    'opening a Wiki lists its Chats, most recent first, and caches them',
    () async {
      final h = Harness(api: WikiApi());
      addTearDown(h.dispose);
      await h.login();
      await h.controller.selectWiki(h.controller.wikis.single);
      expect(h.controller.wikiSection, isTrue);
      expect(h.controller.project, isNull);
      expect(h.controller.task, isNull);
      expect(h.controller.chats.map((c) => c.id), ['task-1', 'task-2']);
      expect(h.controller.chats.last.unread, isTrue);
      expect(h.storage.read('chats:wiki-1')!['chats'], hasLength(2));
      expect(h.live.topics, contains('wikis'));
    },
  );

  test('a Chat is driven by its Task: timeline, comments and topic', () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.selectChat(h.controller.chats.first);
    expect(h.controller.task!.id, 'task-1');
    expect(h.live.topics, containsAll(['wikis', 'task:task-1']));
    await h.controller.setDraft(const Draft(text: 'A shared wiki question'));
    await h.controller.send();
    expect(h.api.items.last['comment']['body'], 'A shared wiki question');
    await h.controller.selectChat(h.controller.chats.last);
    expect(h.controller.task!.id, 'task-2');
    expect(h.live.topics, contains('task:task-2'));
    expect(h.controller.wiki!.repositoryName, 'acme/wiki');
  });

  test('a failed Chat selection keeps the previous Chat selected', () async {
    final api = WikiApi();
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.selectChat(h.controller.chats.first);
    expect(h.controller.openChat!.id, 'task-1');

    api.offline = true;
    h.controller.connection = api_.ConnectionState.offline;
    await expectLater(
      h.controller.selectChat(h.controller.chats.last),
      throwsA(anything),
    );
    expect(h.controller.openChat!.id, 'task-1');
    expect(h.controller.task!.id, 'task-1');
  });

  test('New chat reserves an empty Chat and opens it', () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.newChat();
    expect((h.api as WikiApi).newChats, 1);
    expect(h.controller.task!.id, 'task-1');
    expect(h.controller.openChat!.title, 'Chat');
  });

  test('a Wiki without Chats opens an empty composer', () async {
    final api = WikiApi()..chats = [];
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    expect(api.newChats, 1);
    expect(h.controller.task, isNotNull);
    expect(h.controller.chats, isEmpty);
  });

  test('opening a Wiki on a wide window shows its latest Chat', () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single, openLatest: true);
    expect(h.controller.task!.id, 'task-1');
  });

  test('renaming a Chat updates the list and the cache', () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.renameChat(h.controller.chats.last, 'Release notes');
    expect(h.controller.chats.last.title, 'Release notes');
    expect(
      (h.storage.read('chats:wiki-1')!['chats'] as List).last['title'],
      'Release notes',
    );
    expect(h.api.bodies['PATCH /wikis/wiki-1/chats/task-2'], {
      'title': 'Release notes',
    });
  });

  test('deleting the open Chat opens the most recent remaining one', () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.selectChat(h.controller.chats.last);
    await h.controller.deleteChat(h.controller.chats.last);
    expect(h.api.calls, contains('DELETE /wikis/wiki-1/chats/task-2'));
    expect(h.controller.chats.map((c) => c.id), ['task-1']);
    expect(h.controller.task!.id, 'task-1');
    expect(h.storage.read('task:task-2'), isEmpty);
  });

  test(
    'deleting a Chat that is not open leaves the conversation alone',
    () async {
      final h = Harness(api: WikiApi());
      addTearDown(h.dispose);
      await h.login();
      await h.controller.selectWiki(h.controller.wikis.single);
      await h.controller.deleteChat(h.controller.chats.last);
      expect(h.controller.task, isNull);
      expect(h.controller.chats.map((c) => c.id), ['task-1']);
    },
  );

  test('another User deleting the open Chat opens the remaining one', () async {
    final api = WikiApi();
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.selectChat(h.controller.chats.last);
    api.chats = api.chats.where((c) => c['id'] != 'task-2').toList();
    h.live.eventController.add({'type': 'timeline.reset', 'taskId': 'task-2'});
    h.live.eventController.add({'type': 'wiki.changed', 'wikiId': 'wiki-1'});
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(h.controller.chats.map((c) => c.id), ['task-1']);
    expect(h.controller.task!.id, 'task-1');
  });

  test('a Chat the server no longer lists is dropped from the cache', () async {
    final api = WikiApi();
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.selectChat(h.controller.chats.last);
    await h.controller.selectChat(h.controller.chats.first);
    expect(h.storage.read('task:task-2')!['task'], isNotNull);
    api.chats = api.chats.where((c) => c['id'] != 'task-2').toList();
    await h.controller.refresh();
    expect(h.controller.chats.map((c) => c.id), ['task-1']);
    expect(h.storage.read('task:task-2'), isEmpty);
    expect(h.storage.read('chats:wiki-1')!['chats'], hasLength(1));
  });

  test('Chats are read offline from the cache', () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.selectChat(h.controller.chats.first);
    h.controller.showWikis();
    h.controller.connection = api_.ConnectionState.offline;
    await h.controller.selectWiki(h.controller.wikis.single, openLatest: true);
    expect(h.controller.chats, hasLength(2));
    expect(h.controller.task!.id, 'task-1');
    expect(h.controller.timeline, isNotEmpty);
  });

  test("another Agent's Chat is read-only with the reason", () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.selectChat(h.controller.chats.first);
    expect(h.controller.chatReadOnlyReason, isNull);
    await h.controller.selectChat(h.controller.chats.last);
    expect(
      h.controller.chatReadOnlyReason,
      'This chat is run by another agent: assign the wiki back to that agent '
      'to continue it.',
    );
    await h.controller.setDraft(const Draft(text: 'Hi'));
    await h.controller.send();
    expect(h.api.sendCount, 0);
  });

  test('a notification opens the Chat within its Wiki', () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    h.api.currentTask = {...h.api.currentTask, 'projectId': 'wiki-1'};
    await h.controller.openNotification('task-2');
    expect(h.controller.wiki!.id, 'wiki-1');
    expect(h.controller.task!.id, 'task-2');
    expect(h.controller.pendingTaskId, isNull);
  });

  test(
    'another User deleting a Chat clears its live output and cache',
    () async {
      final h = Harness(api: WikiApi());
      addTearDown(h.dispose);
      await h.login();
      await h.controller.selectWiki(h.controller.wikis.single);
      await h.controller.selectChat(h.controller.chats.first);
      h.controller.liveText['current'] = 'Old response';
      h.controller.nextCursor = 'old-page';
      h.live.eventController.add({
        'type': 'timeline.reset',
        'taskId': 'task-1',
      });
      await Future<void>.delayed(Duration.zero);
      expect(h.controller.timeline, isEmpty);
      expect(h.controller.liveText, isEmpty);
      expect(h.controller.nextCursor, isNull);
      expect(h.storage.read('task:task-1')!['items'], isEmpty);
    },
  );

  test('a missed deletion clears cached messages on reconnect', () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    await h.controller.selectChat(h.controller.chats.first);
    expect(h.controller.timeline, isNotEmpty);
    h.api.currentTask = {...h.api.currentTask, 'chatGeneration': 1};
    h.api.items = [];
    await h.controller.refresh();
    expect(h.controller.timeline, isEmpty);
    expect(h.storage.read('task:task-1')!['items'], isEmpty);
  });

  for (final width in [390.0, 1400.0]) {
    testWidgets('Wiki, Chat list and Chat on a $width wide screen', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness(api: WikiApi());
      addTearDown(h.dispose);
      await h.login();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      if (width < 1000) {
        expect(find.byIcon(Icons.menu_rounded), findsNothing);
        await tester.tap(find.byType(DrawerBrandMark));
        await tester.pumpAndSettle();
      } else {
        await tester.tap(find.byTooltip('Wiki').first);
        await tester.pumpAndSettle();
        expect(find.byType(WikiList), findsOneWidget);
      }
      await tester.tap(find.text('Team knowledge'));
      await tester.pumpAndSettle();
      expect(find.byType(ChatList), findsOneWidget);
      expect(find.byKey(const ValueKey('chat-row:task-1')), findsOneWidget);
      expect(find.byKey(const ValueKey('chat-row:task-2')), findsOneWidget);
      expect(find.byKey(const ValueKey('chat-unread:task-2')), findsOneWidget);
      if (width < 1000) {
        expect(find.byType(Conversation), findsNothing);
        await tester.tap(find.byKey(const ValueKey('chat-row:task-1')));
        await tester.pumpAndSettle();
        expect(find.byType(ChatList), findsNothing);
      } else {
        expect(find.byType(WikiList), findsOneWidget);
      }
      expect(find.byType(Conversation), findsOneWidget);
      expect(find.text('Hello team'), findsWidgets);
      expect(find.byTooltip('Reset chat'), findsNothing);
      expect(find.byTooltip('Task details'), findsNothing);
      if (width < 1000) {
        await tester.tap(find.byTooltip('Back'));
        await tester.pumpAndSettle();
        expect(find.byType(ChatList), findsOneWidget);
      }
      // Delete the other Chat from its row menu.
      await tester.tap(
        find.descendant(
          of: find.byKey(const ValueKey('chat-row:task-2')),
          matching: find.byTooltip('Chat actions'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete chat'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Delete this chat and everything in it for everyone. Wiki files are kept.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.widgetWithText(AppButton, 'Delete chat'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('chat-row:task-2')), findsNothing);
      expect(h.api.calls, contains('DELETE /wikis/wiki-1/chats/task-2'));
      if (width < 1000) {
        await tester.tap(find.byTooltip('Back'));
        await tester.pumpAndSettle();
        expect(find.byType(WikiList), findsOneWidget);
        await tester.tap(find.byType(DrawerBrandMark));
        await tester.pumpAndSettle();
        expect(find.text('Agents'), findsOneWidget);
        expect(find.byIcon(Icons.menu_rounded), findsNothing);
      }
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    "the composer of another Agent's Chat is replaced by the reason",
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness(api: WikiApi());
      addTearDown(h.dispose);
      await h.login();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      await h.controller.selectWiki(h.controller.wikis.single);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('chat-row:task-2')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('comment-composer')), findsNothing);
      expect(find.textContaining('This chat is run by'), findsOneWidget);
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('chat-row:task-1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('comment-composer')), findsOneWidget);
    },
  );

  testWidgets('Wiki creation selects an agent and repository on the phone', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness(api: WikiApi(empty: true));
    addTearDown(h.dispose);
    await h.login();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DrawerBrandMark));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Wikis'));
    await tester.pumpAndSettle();
    expect(find.byType(WikiList), findsOneWidget);
    expect(find.text('No Wikis'), findsOneWidget);
    await tester.tap(find.widgetWithText(AppButton, 'New wiki'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'Product wiki');
    await tester.tap(find.byKey(const Key('wiki-agent')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ada Bot'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose a repository'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('acme/wiki').last);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Create wiki'));
    await tester.tap(find.text('Create wiki'));
    await tester.pumpAndSettle();
    expect(h.controller.wiki!.name, 'Product wiki');
    expect(find.byType(Conversation), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
