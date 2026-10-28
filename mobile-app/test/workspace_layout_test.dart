import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/conversation.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/workspace.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

class _WorkspaceApi extends FakeApi {
  final projects = [
    projectData,
    {'id': 'project-2', 'key': 'WEB', 'name': 'Website'},
  ];
  final tasks = [
    {
      ...taskData(),
      'title': 'Improve the checkout experience',
      'priority': 'high',
      'agentId': 'agent-1',
      'assigneeIds': ['user-1'],
      'tagIds': ['tag-1', 'tag-2'],
      'commentCount': 24,
      'session': {'state': 'idle'},
    },
    {
      ...taskData(id: 'task-2', title: 'Handle expired payment methods'),
      'commentCount': 8,
      'tagIds': ['tag-2'],
    },
    {
      ...taskData(
        id: 'task-3',
        title: 'Add receipt download',
        statusId: 'active',
      ),
      'key': 'API-3',
      'priority': 'low',
      'agentId': 'agent-1',
      'commentCount': 3,
      'session': {'state': 'idle'},
    },
    {
      ...taskData(
        id: 'task-4',
        title: 'Audit retry handling',
        statusId: 'review',
      ),
      'key': 'API-4',
      'priority': 'urgent',
      'tagIds': ['tag-2'],
    },
    {
      ...taskData(id: 'task-5', title: 'Refresh the landing page'),
      'projectId': 'project-2',
      'key': 'WEB-1',
    },
  ];

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    if (path == '/projects') return {'projects': projects};
    for (final project in projects) {
      final id = project['id'];
      final projectTasks = tasks.where((task) => task['projectId'] == id);
      if (path == '/projects/$id') {
        return {
          'project': project,
          'statuses': [
            {
              'id': 'status-1',
              'name': 'Backlog',
              'category': 'open',
              'color': '#999999',
            },
            {
              'id': 'active',
              'name': 'In progress',
              'category': 'active',
              'color': '#00BAFF',
            },
            {
              'id': 'review',
              'name': 'Review',
              'category': 'review',
              'color': '#BD33FF',
            },
            {
              'id': 'done',
              'name': 'Done',
              'category': 'done',
              'color': '#39FF14',
            },
          ],
          'tags': [
            {'id': 'tag-1', 'name': 'Design', 'color': '#00EDC4'},
            {'id': 'tag-2', 'name': 'Payments', 'color': '#FF9D00'},
          ],
        };
      }
      if (path == '/projects/$id/tasks?includeClosed=true') {
        return {'tasks': projectTasks.toList()};
      }
      if (path == '/projects/$id/task-preferences') {
        return {
          'preferences': [
            for (final task in projectTasks)
              {...preferenceData(), 'taskId': task['id']},
          ],
        };
      }
    }
    for (final task in tasks) {
      final id = task['id'];
      if (path == '/tasks/$id') return {'task': task};
      if (path == '/tasks/$id/timeline') {
        final entry = commentData(
          'comment-$id',
          'The latest changes are ready for review.',
        );
        (entry['comment'] as Json)['taskId'] = id;
        return {
          'items': [entry],
          'nextCursor': null,
        };
      }
      if (path == '/tasks/$id/session') return {'session': null};
      if (path == '/tasks/$id/preferences' ||
          path == '/tasks/$id/read-position') {
        return {
          'preference': {...preferenceData(unread: false), 'taskId': id},
        };
      }
    }
    return super.request(method, path, body: body, files: files);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    for (final (family, files) in [
      (
        'Geist',
        ['Geist-Regular.ttf', 'Geist-Medium.ttf', 'Geist-SemiBold.ttf'],
      ),
      ('GeistMono', ['GeistMono-Regular.ttf']),
    ]) {
      final loader = FontLoader(family);
      for (final file in files) {
        loader.addFont(rootBundle.load('assets/fonts/$file'));
      }
      await loader.load();
    }
  });

  testWidgets('Projects show running and unread badges only when there is activity', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = _WorkspaceApi();
    api.projects[0] = {
      ...projectData,
      'activity': {'runningAgents': 1, 'unreadTasks': 3},
    };
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('project-running:project-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('project-unread:project-1')), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    expect(find.byKey(const ValueKey('project-running:project-2')), findsNothing);
    expect(find.byKey(const ValueKey('project-unread:project-2')), findsNothing);
  });

  testWidgets('mobile Projects layout and navigation', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = _WorkspaceApi();
    api.projects[0] = {
      ...projectData,
      'description': 'Checkout, subscriptions and billing',
      'taskCounts': {'open': 2, 'active': 2, 'review': 1, 'done': 3},
    };
    api.projects[1] = {
      ...api.projects[1],
      'taskCounts': {'open': 1, 'active': 2},
    };
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    const boundary = Key('projects-layout');
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: TaskApp(controller: h.controller),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('2 projects · 11 tasks'), findsOneWidget);
    expect(find.text('38% done'), findsOneWidget);
    final row = find.byKey(const ValueKey('project-row:project-1'));
    expect(tester.getSize(row).height, lessThanOrEqualTo(112));
    expect(tester.takeException(), isNull);
    tester
        .renderObject<RenderRepaintBoundary>(find.byKey(boundary))
        .markNeedsPaint();
    await tester.pump();
    await expectLater(
      find.byKey(boundary),
      matchesGoldenFile('goldens/projects_phone.png'),
    );
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(h.controller.project!.id, 'project-1');
    expect(find.byType(TaskList), findsOneWidget);
    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();
    expect(find.byType(ProjectList), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Projects support long names, empty projects and larger text on small phones',
    (tester) async {
      tester.view.physicalSize = const Size(320, 700);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 1.6;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final api = _WorkspaceApi();
      api.projects[0] = {
        ...projectData,
        'name': 'A very long Project name that must fit on a small phone',
        'key': 'LONGPROJECTKEY',
        'description': 'A description that should stay on one line',
        'taskCounts': {'done': 1, 'closed': 1},
      };
      final h = Harness(api: api);
      addTearDown(h.dispose);
      await h.login();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      expect(find.text('100% done'), findsOneWidget);
      expect(find.text('No tasks yet'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (final (name, size) in [
    ('phone', const Size(390, 844)),
    ('desktop', const Size(1200, 900)),
  ]) {
    testWidgets('compact Task list on $name', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness(api: _WorkspaceApi());
      addTearDown(h.dispose);
      await h.login();
      await h.controller.selectProject(h.controller.projects.first);
      if (name == 'desktop') {
        await h.controller.selectTask(h.controller.tasks.first);
      }
      const boundary = Key('workspace-layout');
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: TaskApp(controller: h.controller),
        ),
      );
      await tester.pumpAndSettle();
      final row = find.byKey(const ValueKey('task-row:task-1'));
      expect(tester.getSize(row).height, lessThanOrEqualTo(64));
      expect(find.text('24'), findsOneWidget);
      expect(tester.takeException(), isNull);
      tester
          .renderObject<RenderRepaintBoundary>(find.byKey(boundary))
          .markNeedsPaint();
      await tester.pump();
      await expectLater(
        find.byKey(boundary),
        matchesGoldenFile('goldens/task_list_$name.png'),
      );
    });
  }

  testWidgets('Task and Project changes stay valid throughout every frame', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness(api: _WorkspaceApi());
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    final listState = tester.state(find.byType(TaskList));

    Future<void> checkFrames({required int conversations}) async {
      await tester.pump();
      for (var frame = 0; frame < 20; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
        expect(
          tester.takeException(),
          isNull,
          reason: 'Animation frame $frame',
        );
        expect(find.byType(TaskList), findsOneWidget);
        expect(find.byType(Conversation), findsNWidgets(conversations));
      }
    }

    for (final id in ['task-2', 'task-1', 'task-2']) {
      await tester.tap(find.byKey(ValueKey('task-row:$id')));
      await checkFrames(conversations: 1);
      expect(h.controller.task!.id, id);
      expect(tester.state(find.byType(TaskList)), same(listState));
    }
    // Clicking an already selected row must preserve the current composer.
    final composer = tester
        .widget<TextField>(find.byKey(const Key('comment-composer')))
        .controller;
    await tester.tap(find.byKey(const ValueKey('task-row:task-2')));
    await checkFrames(conversations: 1);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('comment-composer')))
          .controller,
      same(composer),
    );
    await tester.tap(
      find.descendant(
        of: find.byType(ProjectRail),
        matching: find.byTooltip('Payments'),
      ),
    );
    await checkFrames(conversations: 1);
    expect(h.controller.task!.id, 'task-2');
    for (final name in ['Website', 'Payments', 'Website', 'Payments']) {
      await tester.tap(
        find.descendant(
          of: find.byType(ProjectRail),
          matching: find.byTooltip(name),
        ),
      );
      await checkFrames(conversations: 0);
      expect(h.controller.project!.name, name);
    }
  });
}
