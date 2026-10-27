import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/settings.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

class SettingsApi extends FakeApi {
  final writes = <String>[];
  final tags = <Json>[];
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
    if (path == '/projects/project-1') {
      return {
        ...await super.request(method, path, body: body),
        'tags': tags,
      };
    }
    if (path == '/projects/project-1/tags' && method == 'POST') {
      writes.add('$method $path ${body!['name']}');
      tags.add({'id': 'tag-1', ...body});
      return {'tag': tags.last};
    }
    if (path == '/users') return {'users': [user]};
    if (path == '/credentials') return {'credentials': <Json>[]};
    return super.request(method, path, body: body, files: files);
  }
}

void main() {
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
