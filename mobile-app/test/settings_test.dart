import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/settings.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

class SettingsApi extends FakeApi {
  final writes = <String>[];
  final tags = <Json>[];
  Json project = {...projectData};
  SettingsApi() {
    user = {...userData, 'role': 'admin'};
  }
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    if (path == '/projects') {
      return {
        'projects': [project],
      };
    }
    if (path == '/projects/project-1') {
      if (method == 'PATCH') {
        project = {...project, ...body!};
        writes.add('$method $path ${body['name']}');
      }
      return {
        ...await super.request(method, path, body: body),
        'project': project,
        'tags': tags,
      };
    }
    if (path == '/projects/project-1/tags' && method == 'POST') {
      writes.add('$method $path ${body!['name']}');
      tags.add({'id': 'tag-1', ...body});
      return {'tag': tags.last};
    }
    if (path == '/users') {
      return {
        'users': [user],
      };
    }
    if (path == '/credentials') return {'credentials': <Json>[]};
    return super.request(method, path, body: body, files: files);
  }
}

void main() {
  for (final width in [390.0, 1400.0]) {
    testWidgets(
      'a Member edits the open Project from its header at width $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final api = SettingsApi()..user = {...userData, 'role': 'member'};
        final h = Harness(api: api);
        addTearDown(h.dispose);
        await h.login();
        await h.controller.selectProject(h.controller.projects.single);
        await tester.pumpWidget(TaskApp(controller: h.controller));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Edit project'));
        await tester.pumpAndSettle();
        expect(find.text('Payments settings'), findsOneWidget);
        await tester.tap(find.text('Payments'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField).first, 'Billing');
        await tester.tap(find.text('Save changes'));
        await tester.pumpAndSettle();
        expect(api.writes, ['PATCH /projects/project-1 Billing']);
        await tester.tap(find.byTooltip('Back'));
        await tester.pumpAndSettle();
        expect(find.text('Billing'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('an Admin adds a Tag from Project settings', (tester) async {
    final api = SettingsApi();
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    expect(h.controller.user!.isAdmin, isTrue);

    final context = tester.element(find.byType(Scaffold).first);
    showSettings(context, h.controller);
    await tester.pumpAndSettle();
    expect(find.text('Users'), findsOneWidget);
    expect(find.text('Credentials'), findsOneWidget);

    await tester.tap(find.text('Projects'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Payments'));
    await tester.pumpAndSettle();
    expect(find.text('Open'), findsOneWidget);

    await tester.scrollUntilVisible(find.byTooltip('Add tag'), 250);
    await tester.tap(find.byTooltip('Add tag'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'urgent');
    await tester.pump();
    await tester.tap(find.text('Add tag').last);
    await tester.pumpAndSettle();
    expect(api.writes, ['POST /projects/project-1/tags urgent']);
    expect(find.text('urgent'), findsOneWidget);
  });
}
