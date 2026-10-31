import 'package:claude_task_mobile/src/app.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

Future<Harness> _open(
  WidgetTester tester, {
  Size size = const Size(1000, 900),
  FakeApi? api,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final h = Harness(api: api);
  addTearDown(h.dispose);
  h.api.extraTasks = [taskData(id: 'task-2', title: 'Second task')];
  await h.login();
  await h.controller.selectProject(h.controller.projects.first);
  await tester.pumpWidget(TaskApp(controller: h.controller));
  await tester.pumpAndSettle();
  return h;
}

Finder _row(String id) => find.byKey(ValueKey('task-row:$id'));

Future<void> _rightClick(WidgetTester tester, Finder target) async {
  final gesture = await tester.startGesture(
    tester.getCenter(target),
    kind: PointerDeviceKind.mouse,
    buttons: kSecondaryMouseButton,
  );
  await gesture.up();
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'right click opens the Task menu; Select starts multi-selection',
    (tester) async {
      await _open(tester);
      await _rightClick(tester, _row('task-1'));
      expect(find.text('Select'), findsOneWidget);
      expect(find.text('Close'), findsOneWidget);
      expect(find.text('Delete'), findsOneWidget);
      await tester.tap(find.text('Select'));
      await tester.pumpAndSettle();
      expect(find.text('1 selected'), findsOneWidget);
      await tester.tap(_row('task-2'));
      await tester.pumpAndSettle();
      expect(find.text('2 selected'), findsOneWidget);
      // Unchecking the last one leaves selection mode.
      await tester.tap(_row('task-1'));
      await tester.tap(_row('task-2'));
      await tester.pumpAndSettle();
      expect(find.textContaining('selected'), findsNothing);
    },
  );

  testWidgets('closing the selection asks once and sends one bulk request', (
    tester,
  ) async {
    final h = await _open(tester);
    await _rightClick(tester, _row('task-1'));
    await tester.tap(find.text('Select'));
    await tester.pumpAndSettle();
    await tester.tap(_row('task-2'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Close selected'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Close').last);
    await tester.pumpAndSettle();
    expect(h.api.bodies['POST /projects/project-1/tasks/bulk'], {
      'action': 'move',
      'taskIds': ['task-1', 'task-2'],
      'statusId': 'status-2',
    });
    expect(find.textContaining('selected'), findsNothing);
  });

  testWidgets('bulk failures stay selected and name the reason', (
    tester,
  ) async {
    final h = await _open(tester);
    h.api.bulkResult = {
      'succeeded': ['task-1'],
      'failed': [
        {'taskId': 'task-2', 'message': 'An agent is working on this.'},
      ],
    };
    await _rightClick(tester, _row('task-1'));
    await tester.tap(find.text('Select'));
    await tester.pumpAndSettle();
    await tester.tap(_row('task-2'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Delete selected'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete').last);
    await tester.pumpAndSettle();
    expect(h.api.bodies['POST /projects/project-1/tasks/bulk'], {
      'action': 'delete',
      'taskIds': ['task-1', 'task-2'],
    });
    expect(find.text('1 selected'), findsOneWidget);
    expect(find.textContaining('An agent is working on this.'), findsOneWidget);
  });

  testWidgets('Mark all as read clears the Project in one tap', (tester) async {
    final h = await _open(tester);
    final mark = find.byTooltip('Mark all as read');
    expect(mark, findsOneWidget);
    // It sits between Edit project and Create Task.
    expect(
      tester.getCenter(mark).dx,
      lessThan(tester.getCenter(find.byTooltip('Create Task')).dx),
    );
    expect(
      tester
          .widget<Text>(
            find.descendant(
              of: _row('task-1'),
              matching: find.text('Fix login'),
            ),
          )
          .style!
          .fontWeight,
      FontWeight.w600,
    );

    await tester.tap(mark);
    await tester.pumpAndSettle();

    expect(h.api.calls, contains('POST /projects/project-1/read-all'));
    expect(mark, findsNothing);
    expect(
      tester
          .widget<Text>(
            find.descendant(
              of: _row('task-1'),
              matching: find.text('Fix login'),
            ),
          )
          .style!
          .fontWeight,
      FontWeight.w500,
    );
  });

  testWidgets('Mark all as read is hidden when every Task is read', (
    tester,
  ) async {
    await _open(tester, api: FakeApi()..pref = preferenceData(unread: false));
    expect(find.byTooltip('Mark all as read'), findsNothing);
  });

  testWidgets('a long press without moving starts multi-selection', (
    tester,
  ) async {
    await _open(tester, size: const Size(430, 900));
    final gesture = await tester.startGesture(tester.getCenter(_row('task-1')));
    await tester.pump(const Duration(milliseconds: 700));
    await gesture.up();
    await tester.pumpAndSettle();
    expect(find.text('Select'), findsNothing);
    expect(find.text('1 selected'), findsOneWidget);
  });

  testWidgets('swiping a row to the right closes the Task', (tester) async {
    final h = await _open(tester, size: const Size(430, 900));
    await tester.drag(_row('task-1'), const Offset(300, 0));
    await tester.pumpAndSettle();
    expect(h.api.bodies['POST /projects/project-1/tasks/bulk'], {
      'action': 'move',
      'taskIds': ['task-1'],
      'statusId': 'status-2',
    });
  });

  testWidgets('swiping a row to the left does nothing', (tester) async {
    final h = await _open(tester, size: const Size(430, 900));
    await tester.drag(_row('task-1'), const Offset(-300, 0));
    await tester.pumpAndSettle();
    expect(h.api.bodies['POST /projects/project-1/tasks/bulk'], isNull);
  });

  testWidgets('a long press then a move drags the Task', (tester) async {
    final h = await _open(tester, size: const Size(430, 900));
    final target = tester.getRect(_row('task-1'));
    final gesture = await tester.startGesture(tester.getCenter(_row('task-2')));
    await tester.pump(const Duration(milliseconds: 700));
    await gesture.moveBy(const Offset(0, -20));
    await tester.pump();
    await gesture.moveTo(Offset(target.center.dx, target.top + 4));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    expect(find.text('Select'), findsNothing);
    expect(h.api.bodies['POST /tasks/task-2/move'], {
      'statusId': 'status-1',
      'beforeTaskId': 'task-1',
    });
  });

  testWidgets('dragging a Task onto a Status header moves it there', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;
    final h = await _open(tester);
    final gesture = await tester.startGesture(
      tester.getCenter(_row('task-2')),
      kind: PointerDeviceKind.mouse,
    );
    await tester.pump();
    await gesture.moveBy(const Offset(0, 30));
    await tester.pump();
    final header = tester.getCenter(find.text('OPEN'));
    await gesture.moveTo(header);
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    expect(h.api.bodies['POST /tasks/task-2/move'], {'statusId': 'status-1'});
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('with a mouse, dropping on the upper half lands above it', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;
    final h = await _open(tester);
    final target = tester.getRect(_row('task-1'));
    final gesture = await tester.startGesture(
      tester.getCenter(_row('task-2')),
      kind: PointerDeviceKind.mouse,
    );
    await tester.pump();
    await gesture.moveBy(const Offset(0, -20));
    await tester.pump();
    await gesture.moveTo(Offset(target.center.dx, target.top + 4));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    expect(h.api.bodies['POST /tasks/task-2/move'], {
      'statusId': 'status-1',
      'beforeTaskId': 'task-1',
    });
    debugDefaultTargetPlatformOverride = null;
  });
}
