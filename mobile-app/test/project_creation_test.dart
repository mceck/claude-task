import 'dart:async';

import 'package:claude_task_mobile/src/api.dart' as api;
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:claude_task_mobile/src/wiki.dart';
import 'package:claude_task_mobile/src/workspace.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

class _ProjectApi extends FakeApi {
  final List<Json> projects;
  Json? submitted;
  Completer<Json>? pendingRepositories;
  bool rejectCreation = false, failRepositories = false;
  final groups = <Json>[
    {
      'connection': {
        'id': 'git-1',
        'name': 'Company Git',
        'host': 'git.example.com',
      },
      'repositories': [
        {
          'connectionId': 'git-1',
          'providerRepoId': '101',
          'owner': 'acme',
          'name': 'app',
          'defaultBranch': 'main',
        },
      ],
    },
    {
      'connection': {
        'id': 'git-2',
        'name': 'Unavailable Git',
        'host': 'offline.example.com',
      },
      'repositories': <Json>[],
      'error': 'Connection unavailable',
    },
  ];
  _ProjectApi({bool empty = false}) : projects = empty ? [] : [projectData];

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    if (path == '/git/repositories') {
      if (pendingRepositories != null) return pendingRepositories!.future;
      if (failRepositories) {
        throw const api.ApiException(
          503,
          'unavailable',
          'Repository list unavailable',
        );
      }
      return {'groups': groups};
    }
    if (path == '/agents') {
      final result = await super.request(method, path);
      return {
        'agents': [
          ...objects(result['agents']),
          {'id': 'disabled', 'name': 'Disabled Bot', 'enabled': false},
        ],
      };
    }
    if (path == '/projects') {
      if (method == 'POST') {
        submitted = body;
        if (rejectCreation) {
          throw const api.ApiException(
            409,
            'conflict',
            'A project with this key already exists',
          );
        }
        final project = <String, dynamic>{'id': 'created-project', ...body!};
        projects.add(project);
        return {'project': project};
      }
      return {'projects': projects};
    }
    if (path == '/projects/created-project') {
      return {'project': projects.last, 'statuses': <Json>[], 'tags': <Json>[]};
    }
    if (path == '/projects/created-project/tasks?includeClosed=true') {
      return {'tasks': <Json>[]};
    }
    if (path == '/projects/created-project/task-preferences') {
      return {'preferences': <Json>[]};
    }
    return super.request(method, path, body: body, files: files);
  }
}

void main() {
  for (final width in [390.0, 1400.0]) {
    for (final empty in [true, false]) {
      testWidgets('create a Project at width $width with empty list $empty', (
        tester,
      ) async {
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final api = _ProjectApi(empty: empty);
        final h = Harness(api: api);
        addTearDown(h.dispose);
        await h.login();
        await tester.pumpWidget(TaskApp(controller: h.controller));
        await tester.pumpAndSettle();
        if (empty && width < 1000) {
          await tester.tap(find.widgetWithText(AppButton, 'New project'));
        } else {
          await tester.tap(find.byTooltip('New project'));
        }
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField).at(0), ' doc ');
        await tester.enterText(find.byType(TextField).at(1), ' Documentation ');
        await tester.enterText(find.byType(TextField).at(2), 'Team docs');
        await tester.ensureVisible(find.text('Create project'));
        await tester.tap(find.text('Create project'));
        await tester.pumpAndSettle();
        expect(api.submitted, {
          'key': 'DOC',
          'name': 'Documentation',
          'description': 'Team docs',
        });
        expect(h.controller.projects.last.key, 'DOC');
        expect(h.controller.project!.id, 'created-project');
        expect(find.byType(TaskList), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }

  for (final width in [390.0, 1400.0]) {
    testWidgets('creates with a Repository and default Agent at width $width', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = _ProjectApi();
      final h = Harness(api: api);
      addTearDown(h.dispose);
      await h.login();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('New project'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).at(0), 'CFG');
      await tester.enterText(find.byType(TextField).at(1), 'Configured');
      await tester.ensureVisible(find.text('No Agent'));
      await tester.tap(find.text('No Agent'));
      await tester.pumpAndSettle();
      expect(find.text('Disabled Bot'), findsNothing);
      await tester.tap(find.text('Ada Bot'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('No Repository'));
      await tester.tap(find.text('No Repository'));
      await tester.pumpAndSettle();
      expect(find.text('COMPANY GIT · GIT.EXAMPLE.COM'), findsOneWidget);
      await tester.enterText(find.byType(TextField).last, 'acme/app');
      await tester.pump();
      await tester.tap(find.text('acme/app').last);
      await tester.pumpAndSettle();
      expect(find.text('main'), findsOneWidget);
      await tester.ensureVisible(find.byType(TextField).last);
      await tester.enterText(find.byType(TextField).last, ' develop ');
      await tester.ensureVisible(find.text('Create project'));
      await tester.tap(find.text('Create project'));
      await tester.pumpAndSettle();
      expect(api.submitted, containsPair('defaultAgentId', 'agent-1'));
      expect(api.submitted!['repository'], {
        'connectionId': 'git-1',
        'providerRepoId': '101',
        'baseBranch': 'develop',
      });
      expect(find.byType(TaskList), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('clears optional choices and retries Repository list loading', (
    tester,
  ) async {
    final api = _ProjectApi()..failRepositories = true;
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('New project'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(0), 'CLEAR');
    await tester.enterText(find.byType(TextField).at(1), 'Basic Project');
    api.failRepositories = false;
    await tester.ensureVisible(find.text('Retry repositories'));
    await tester.tap(find.text('Retry repositories'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('No Agent'));
    await tester.tap(find.text('No Agent'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ada Bot'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ada Bot'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('No Agent'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('No Repository'));
    await tester.tap(find.text('No Repository'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('acme/app').last);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('acme/app'));
    await tester.tap(find.text('acme/app').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('No Repository'));
    await tester.pumpAndSettle();
    expect(find.text('Base branch'), findsNothing);
    await tester.ensureVisible(find.text('Create project'));
    await tester.tap(find.text('Create project'));
    await tester.pumpAndSettle();
    expect(api.submitted!.containsKey('repository'), isFalse);
    expect(api.submitted!.containsKey('defaultAgentId'), isFalse);
    expect(h.controller.project!.key, 'CLEAR');
    expect(tester.takeException(), isNull);
  });

  testWidgets('Repository loading spinner stays square in the creation form', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = _ProjectApi()..pendingRepositories = Completer<Json>();
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('New project'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(
      tester.getSize(find.byType(CircularProgressIndicator)),
      const Size(18, 18),
    );
    api.pendingRepositories!.complete({'groups': api.groups});
    await tester.pumpAndSettle();
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('phone drawer opens creation forms and empty lists', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness(api: _ProjectApi(empty: true));
    addTearDown(h.dispose);
    await h.login();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    final drawer = find.byType(Drawer);
    await tester.tap(find.byType(DrawerBrandMark));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(of: drawer, matching: find.text('New project')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Create project'), findsOneWidget);
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DrawerBrandMark));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: drawer, matching: find.text('Wikis')));
    await tester.pumpAndSettle();
    expect(find.byType(WikiList), findsOneWidget);
    await tester.tap(find.byType(DrawerBrandMark));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(of: drawer, matching: find.text('New wiki')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Create wiki'), findsOneWidget);
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DrawerBrandMark));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(of: drawer, matching: find.text('Projects')),
    );
    await tester.pumpAndSettle();
    expect(find.byType(ProjectList), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'offline lists stay reachable and creation actions are disabled',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness(api: _ProjectApi(empty: true));
      addTearDown(h.dispose);
      await h.login();
      h.live.stateController.add(api.ConnectionState.offline);
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'New project'))
            .onPressed,
        isNull,
      );
      await tester.tap(find.byType(DrawerBrandMark));
      await tester.pumpAndSettle();
      final drawer = find.byType(Drawer);
      for (final label in ['New project', 'New wiki']) {
        final button = find.descendant(
          of: drawer,
          matching: find.byWidgetPredicate(
            (widget) => widget is Pressable && widget.semanticLabel == label,
          ),
        );
        expect(tester.widget<Pressable>(button).onTap, isNull);
      }
      await tester.tap(
        find.descendant(of: drawer, matching: find.text('Wikis')),
      );
      await tester.pumpAndSettle();
      expect(find.byType(WikiList), findsOneWidget);
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'New wiki'))
            .onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('failed Project creation preserves input and supports retry', (
    tester,
  ) async {
    final api = _ProjectApi()..rejectCreation = true;
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('New project'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(0), 'DOC');
    await tester.enterText(find.byType(TextField).at(1), 'Documentation');
    await tester.pump();
    await tester.ensureVisible(find.text('Create project'));
    await tester.tap(find.text('Create project'));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('A project with this key already exists'),
      findsOneWidget,
    );
    expect(find.text('Documentation'), findsOneWidget);
    api.rejectCreation = false;
    await tester.ensureVisible(find.text('Create project'));
    await tester.tap(find.text('Create project'));
    await tester.pumpAndSettle();
    expect(h.controller.project!.key, 'DOC');
    expect(tester.takeException(), isNull);
  });
}
