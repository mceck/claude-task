import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/context_badge.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

void main() {
  Future<Harness> open(
    WidgetTester tester, {
    bool running = false,
    Json? session,
  }) async {
    tester.view.physicalSize = const Size(1600, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness();
    addTearDown(h.dispose);
    h.api.session =
        session ??
        (running
            ? {
                'state': 'running',
                'queuePosition': null,
                'held': false,
                'unseenChanges': false,
              }
            : null);
    await h.login();
    await h.openTask();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    return h;
  }

  testWidgets('shows the context beside the Session state and in the details', (
    tester,
  ) async {
    await open(
      tester,
      session: {
        'state': 'idle',
        'queuePosition': null,
        'held': false,
        'unseenChanges': false,
        'context': {'tokens': 120252, 'window': 200000},
      },
    );
    // The header and, on this wide layout, the Task details pane beside it.
    expect(find.byType(ContextBadge), findsNWidgets(2));
    expect(find.text('120.3K (60%)'), findsNWidgets(2));
  });

  testWidgets('no context chip before the first Turn', (tester) async {
    await open(
      tester,
      session: {
        'state': 'pending',
        'queuePosition': null,
        'held': false,
        'unseenChanges': false,
        'context': null,
      },
    );
    expect(find.byType(ContextBadge), findsNothing);
  });

  testWidgets('Stop is an icon beside the title while the Agent runs', (
    tester,
  ) async {
    final h = await open(tester, running: true);
    final stop = find.byKey(const Key('session-stop'));
    expect(stop, findsOneWidget);
    expect(
      find.descendant(of: stop, matching: find.text('Stop')),
      findsNothing,
    );
    await tester.tap(stop);
    await tester.pump(const Duration(milliseconds: 200));
    expect(h.api.calls, contains('POST /tasks/task-1/session/stop'));
  });

  testWidgets('no Stop icon while the Agent is idle', (tester) async {
    await open(tester);
    expect(find.byKey(const Key('session-stop')), findsNothing);
  });

  testWidgets('the bell lives in the menu; Close sits before Details', (
    tester,
  ) async {
    final h = await open(tester);
    expect(find.byTooltip('Mute Task'), findsNothing);
    expect(
      tester.getCenter(find.byTooltip('Close Task')).dx,
      lessThan(tester.getCenter(find.byTooltip('Task actions')).dx),
    );
    await tester.tap(find.byTooltip('Task actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Mute Task'));
    await tester.pumpAndSettle();
    expect(h.api.bodies['PATCH /tasks/task-1/preferences'], {'muted': true});
  });
}
