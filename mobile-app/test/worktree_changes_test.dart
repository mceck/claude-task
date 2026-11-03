import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' hide ConnectionState;

import 'support.dart';

Future<Harness> _open(WidgetTester tester, Json worktreeStatus) async {
  tester.view.physicalSize = const Size(430, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final h = Harness();
  h.api.items = [commentData('comment-1', 'Hello')];
  h.api.worktreeStatus = worktreeStatus;
  addTearDown(h.dispose);
  await h.login();
  await h.openTask();
  await tester.pumpWidget(TaskApp(controller: h.controller));
  await tester.pumpAndSettle();
  return h;
}

Future<void> _showChanges(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Task actions'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Changes'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('the Task menu lists the Worktree changes', (tester) async {
    final h = await _open(tester, {
      'status': {
        'capturedAt': '2026-11-02T23:00:00.000Z',
        'files': [
          {'path': 'src/app.ts', 'status': 'modified'},
          {'path': 'src/new.ts', 'status': 'untracked'},
        ],
        'total': 2,
        'truncated': false,
      },
      'live': true,
      'reason': null,
    });
    await _showChanges(tester);

    expect(h.api.calls, contains('GET /tasks/task-1/worktree-status'));
    expect(find.text('app.ts'), findsOneWidget);
    expect(find.text('new.ts'), findsOneWidget);
    expect(find.text('M'), findsOneWidget);
    expect(find.text('U'), findsOneWidget);
    expect(find.text('Read just now.'), findsOneWidget);
  });

  testWidgets('the sheet explains a stopped Worker when nothing was read', (
    tester,
  ) async {
    await _open(tester, {'status': null, 'live': false, 'reason': 'no-runner'});
    await _showChanges(tester);
    expect(find.textContaining('worker isn’t running'), findsOneWidget);
  });
}
