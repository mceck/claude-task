import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' hide ConnectionState;

import 'support.dart';

Future<Harness> _open(WidgetTester tester, List<Json> skills) async {
  tester.view.physicalSize = const Size(430, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final h = Harness();
  h.api.items = [commentData('comment-1', 'Hello')];
  h.api.sessionSkills = skills;
  addTearDown(h.dispose);
  await h.login();
  await h.openTask();
  await tester.pumpWidget(TaskApp(controller: h.controller));
  await tester.pumpAndSettle();
  return h;
}

Future<void> _showSkills(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Task actions'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Skills'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('the Task menu shows the Session Skills, used ones first', (
    tester,
  ) async {
    final h = await _open(tester, [
      {
        'name': 'deploy',
        'description': 'Deploy the service',
        'usedBy': ['agent'],
      },
      {'name': 'unused', 'description': 'Not used', 'usedBy': <String>[]},
    ]);
    await _showSkills(tester);

    expect(h.api.calls, contains('GET /tasks/task-1/skills'));
    expect(find.text('deploy'), findsOneWidget);
    expect(find.text('unused'), findsOneWidget);
    expect(find.byTooltip('Used by the agent'), findsOneWidget);
    expect(find.byTooltip('Not used yet'), findsOneWidget);
    expect(find.text('1 of 2 used'), findsOneWidget);
    final used = tester.getTopLeft(find.text('deploy'));
    final unused = tester.getTopLeft(find.text('unused'));
    expect(
      used.dy < unused.dy || (used.dy == unused.dy && used.dx < unused.dx),
      isTrue,
    );
  });

  testWidgets('says when the Session has no Skills', (tester) async {
    await _open(tester, []);
    await _showSkills(tester);
    expect(
      find.text('No skills are available in this session.'),
      findsOneWidget,
    );
  });
}
