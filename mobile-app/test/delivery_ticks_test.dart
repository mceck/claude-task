import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' hide ConnectionState;
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/theme.dart';

import 'support.dart';

Json _comment(String id, Json delivery, String position) {
  final item = commentData(id, 'Body of $id', position: position);
  return {
    ...item,
    'comment': {...(item['comment'] as Json), 'delivery': delivery},
  };
}

Finder _tooltip(bool Function(String message) match) => find.byWidgetPredicate(
  (w) => w is Tooltip && w.message != null && match(w.message!),
);

void main() {
  testWidgets('User Comments show their Delivery as ticks with labels', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(430, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness();
    addTearDown(h.dispose);
    h.api.currentTask = {...h.api.currentTask, 'agentId': 'agent-1'};
    const at = '2026-10-31T12:43:00.000Z';
    h.api.items = [
      _comment('queued', {
        'state': 'queued',
        'reason': null,
        'jobId': null,
        'at': null,
      }, '1'),
      _comment('delivered', {
        'state': 'delivered',
        'reason': null,
        'jobId': 'job-1',
        'at': at,
      }, '2'),
      _comment('handled', {
        'state': 'handled',
        'reason': null,
        'jobId': 'job-1',
        'at': at,
      }, '3'),
      _comment('dropped', {
        'state': 'not_delivered',
        'reason': 'task closed',
        'jobId': null,
        'at': at,
      }, '4'),
    ];
    await h.login();
    await h.openTask();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();

    expect(_tooltip((m) => m == 'Queued'), findsOneWidget);
    expect(
      _tooltip((m) => m.startsWith('Delivered to Ada Bot · ')),
      findsOneWidget,
    );
    expect(
      _tooltip((m) => m.startsWith('Handled by Ada Bot · ')),
      findsOneWidget,
    );
    expect(_tooltip((m) => m == 'Not delivered: task closed'), findsOneWidget);
    final handled = tester.widget<Icon>(
      find.descendant(
        of: _tooltip((m) => m.startsWith('Handled')),
        matching: find.byType(Icon),
      ),
    );
    expect(handled.icon, Icons.done_all_rounded);
    expect(handled.color, Palette.primary);
    final delivered = tester.widget<Icon>(
      find.descendant(
        of: _tooltip((m) => m.startsWith('Delivered')),
        matching: find.byType(Icon),
      ),
    );
    expect(delivered.icon, Icons.done_rounded);
    expect(find.text('Delivered'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
