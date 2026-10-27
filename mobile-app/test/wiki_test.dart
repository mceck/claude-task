import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/wiki.dart';
import 'package:claude_task_mobile/src/conversation.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

class WikiApi extends FakeApi {
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
  int resets = 0;
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    if (path == '/wikis' && method == 'GET') {
      return {
        'wikis': [wiki],
      };
    }
    if (path == '/wikis/wiki-1/reset') {
      resets++;
      items.clear();
      currentTask = {...currentTask, 'chatGeneration': resets};
      session = {'state': 'pending'};
      return {'wiki': wiki};
    }
    if ((path == '/wikis' && method == 'POST') ||
        (path == '/wikis/wiki-1' && method == 'PATCH')) {
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
    'Wiki conversations share comments, subscriptions and session APIs',
    () async {
      final h = Harness(api: WikiApi());
      addTearDown(h.dispose);
      await h.login();
      await h.controller.selectWiki(h.controller.wikis.single);
      expect(h.controller.wikiSection, isTrue);
      expect(h.controller.project, isNull);
      expect(h.live.topics, containsAll(['wikis', 'task:task-1']));
      await h.controller.setDraft(const Draft(text: 'A shared wiki question'));
      await h.controller.send();
      expect(h.api.items.last['comment']['body'], 'A shared wiki question');
      await h.controller.resetWiki();
      expect(h.controller.timeline, isEmpty);
      expect(h.controller.session?['state'], 'pending');
      expect(h.storage.read('task:task-1')!['items'], isEmpty);
      expect(h.controller.wiki!.repositoryName, 'acme/wiki');
    },
  );

  test(
    'another User resetting clears live output, pagination and cached messages',
    () async {
      final h = Harness(api: WikiApi());
      addTearDown(h.dispose);
      await h.login();
      await h.controller.selectWiki(h.controller.wikis.single);
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

  test('a missed reset clears cached messages on reconnect', () async {
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectWiki(h.controller.wikis.single);
    expect(h.controller.timeline, isNotEmpty);
    h.api.currentTask = {...h.api.currentTask, 'chatGeneration': 1};
    h.api.items = [];
    await h.controller.refresh();
    expect(h.controller.timeline, isEmpty);
    expect(h.storage.read('task:task-1')!['items'], isEmpty);
  });

  for (final width in [390.0, 1400.0]) {
    testWidgets('Wiki navigation and reset on a $width wide screen', (
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
        // The phone reaches Wikis from the drawer.
        await tester.tap(find.byTooltip('Menu'));
        await tester.pumpAndSettle();
      } else {
        await tester.tap(find.byTooltip('Wiki').first);
        await tester.pumpAndSettle();
        expect(find.byType(WikiList), findsOneWidget);
      }
      await tester.tap(find.text('Team knowledge'));
      await tester.pumpAndSettle();
      expect(find.byType(Conversation), findsOneWidget);
      expect(find.text('Hello team'), findsOneWidget);
      expect(find.byTooltip('Task details'), findsNothing);
      await tester.tap(find.byTooltip('Reset chat'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(AppButton, 'Reset chat'));
      await tester.pumpAndSettle();
      expect((h.api as WikiApi).resets, 1);
      expect(find.text('Hello team'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Wiki creation selects an agent and repository on the phone', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness(api: WikiApi());
    addTearDown(h.dispose);
    await h.login();
    h.controller.showWikis();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('New wiki'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'Product wiki');
    await tester.tap(find.text('Ada Bot'));
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
