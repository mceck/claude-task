import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/app.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' hide ConnectionState;

import 'support.dart';

void main() {
  Future<Harness> openApp(WidgetTester tester) async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    return h;
  }

  testWidgets('a quick reconnection does not flash the connection notice', (
    tester,
  ) async {
    final h = await openApp(tester);
    h.live.stateController.add(ConnectionState.connecting);
    await tester.pump();
    expect(find.textContaining('Reconnecting'), findsNothing);

    h.live.stateController.add(ConnectionState.offline);
    await tester.pump(connectionNoticeDelay ~/ 2);
    expect(find.textContaining('Offline ·'), findsNothing);

    h.live.stateController.add(ConnectionState.connected);
    await tester.pump(const Duration(seconds: 5));
    expect(find.textContaining('Offline ·'), findsNothing);
    expect(find.textContaining('Reconnecting'), findsNothing);
  });

  testWidgets(
    'a lasting disconnection shows the notice after the delay and hides it on reconnection',
    (tester) async {
      final h = await openApp(tester);
      h.live.stateController.add(ConnectionState.offline);
      await tester.pump();
      expect(find.textContaining('Offline ·'), findsNothing);

      await tester.pump(connectionNoticeDelay);
      expect(find.textContaining('Offline ·'), findsOneWidget);

      h.live.stateController.add(ConnectionState.connected);
      await tester.pumpAndSettle();
      expect(find.textContaining('Offline ·'), findsNothing);
    },
  );

  testWidgets(
    'returning to the app restarts the delay instead of flashing the notice',
    (tester) async {
      final h = await openApp(tester);
      h.live.stateController.add(ConnectionState.offline);
      await tester.pump();
      await tester.pump(connectionNoticeDelay);
      await tester.pumpAndSettle();
      expect(find.textContaining('Offline ·'), findsOneWidget);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(find.textContaining('Offline ·'), findsNothing);

      h.live.stateController.add(ConnectionState.connected);
      await tester.pumpAndSettle();
      expect(find.textContaining('Offline ·'), findsNothing);
    },
  );
}
