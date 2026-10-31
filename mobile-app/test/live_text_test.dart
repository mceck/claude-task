import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

void main() {
  testWidgets(
    'a long live answer keeps its top in place while expanding and stays expanded once stored',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      // Enough conversation above the answer to scroll by its full height.
      h.api.items = [
        for (var i = 1; i <= 30; i++)
          commentData('comment-$i', 'Earlier comment $i', position: '$i'),
      ];
      await h.login();
      await h.openTask();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();

      final answer = [
        for (var i = 1; i <= 40; i++) 'Paragraph $i of the explanation.',
      ].join('\n\n');
      h.live.eventController.add({
        'type': 'live.delta',
        'taskId': 'task-1',
        'delta': {'kind': 'text', 'commentId': null, 'text': answer},
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));

      // Every clamp builds its toggle; only overflowing ones show it.
      Finder shown(String text) => find.text(text).hitTestable();

      // The live box is clamped, with its header (and so its top) on screen.
      final header = find.byType(TypingDots);
      final top = tester.getTopLeft(header).dy;
      expect(shown('Show more'), findsOneWidget);

      await tester.tap(shown('Show more'));
      for (var frame = 0; frame < 20; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
        expect(
          tester.getTopLeft(header).dy,
          moreOrLessEquals(top, epsilon: 0.5),
          reason: 'Animation frame $frame',
        );
      }
      // The toggle is now below the screen, under the whole answer.
      expect(find.text('Show less'), findsOneWidget);

      // More text in the expanded box grows it downward.
      h.live.eventController.add({
        'type': 'live.delta',
        'taskId': 'task-1',
        'delta': {
          'kind': 'text',
          'commentId': null,
          'text': '\n\nOne more paragraph.\n\nAnd another one.',
        },
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      expect(tester.getTopLeft(header).dy, moreOrLessEquals(top, epsilon: 0.5));

      final stored = commentData('agent-9', answer, position: '31');
      h.live.eventController.add({
        'type': 'comment.created',
        'comment': {
          ...stored['comment'] as Map<String, dynamic>,
          'kind': 'agent',
          'author': {
            'id': 'agent-1',
            'displayName': 'Ada Bot',
            'type': 'agent',
          },
        },
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      expect(h.controller.liveText, isEmpty);
      expect(find.text('Show less'), findsOneWidget);
      expect(shown('Show more'), findsNothing);
      // Let the controller's pending refresh run out.
      await tester.pump(const Duration(milliseconds: 200));
      expect(tester.takeException(), isNull);
    },
  );

  test(
    'live deltas notify only the Live Tail, not the whole conversation',
    () async {
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.openTask();
      var whole = 0, live = 0;
      h.controller.addListener(() => whole++);
      h.controller.live.addListener(() => live++);

      h.live.eventController.add({
        'type': 'live.delta',
        'taskId': 'task-1',
        'delta': {'kind': 'text', 'commentId': null, 'text': 'Streaming'},
      });
      expect(whole, 0, reason: 'a token must not rebuild the whole page');
      expect(live, 1);
      expect(h.controller.liveText['current'], 'Streaming');

      h.live.eventController.add({
        'type': 'comment.created',
        'comment': {
          ...commentData('agent-9', 'Stored', position: '3')['comment']
              as Map<String, dynamic>,
          'kind': 'agent',
          'author': {
            'id': 'agent-1',
            'displayName': 'Ada Bot',
            'type': 'agent',
          },
        },
      });
      expect(whole, 1, reason: 'stored Entries still update the Timeline');
    },
  );

  testWidgets(
    'a long live answer is clipped to its beginning until Show more opens it',
    (tester) async {
      tester.view.physicalSize = const Size(430, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      h.api.items = [
        for (var i = 1; i <= 20; i++)
          commentData('comment-$i', 'Earlier comment $i', position: '$i'),
      ];
      await h.login();
      await h.openTask();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();

      final answer = [
        for (var i = 1; i <= 120; i++) 'Paragraph $i of the explanation.',
        'END-OF-STREAM',
      ].join('\n\n');
      h.live.eventController.add({
        'type': 'live.delta',
        'taskId': 'task-1',
        'delta': {'kind': 'text', 'commentId': null, 'text': answer},
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));

      expect(find.text('Show more').hitTestable(), findsOneWidget);
      expect(find.textContaining('END-OF-STREAM'), findsNothing);

      await tester.tap(find.text('Show more').hitTestable());
      for (var frame = 0; frame < 30; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(find.textContaining('END-OF-STREAM'), findsOneWidget);
    },
  );
}
