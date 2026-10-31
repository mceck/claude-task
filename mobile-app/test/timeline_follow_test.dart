import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/conversation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

/// The Timeline is built from the bottom up: content arriving below the entry
/// the reader is on must not carry it off screen.
void main() {
  Future<Harness> openConversation(
    WidgetTester tester, {
    bool older = false,
  }) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness();
    addTearDown(h.dispose);
    // Enough conversation to scroll up into.
    h.api.items = [
      for (var i = 1; i <= 15; i++)
        commentData(
          'comment-$i',
          'Earlier comment $i\n\nwith a second paragraph so each takes room.',
          position: '$i',
        ),
    ];
    h.api.hasOlder = older;
    await h.login();
    await h.openTask();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    return h;
  }

  /// The entry nearest the top of the screen, which is what a reader is on.
  ({String id, double top}) reading(WidgetTester tester) {
    for (final element in find.byType(TimelineTile).evaluate()) {
      final tile = element.widget as TimelineTile;
      final rect = tester.getRect(find.byWidget(tile));
      if (rect.top > 120 && rect.top < 400) {
        return (id: tile.entry.id, top: rect.top);
      }
    }
    fail('No entry is on screen to read');
  }

  ScrollPosition timeline(WidgetTester tester) => tester
      .state<ScrollableState>(
        find
            .descendant(
              of: find.byKey(const Key('timeline')),
              matching: find.byType(Scrollable),
            )
            .first,
      )
      .position;

  void stream(WidgetTester tester, Harness h, String text) {
    h.live.eventController.add({
      'type': 'live.delta',
      'taskId': 'task-1',
      'delta': {'kind': 'text', 'commentId': null, 'text': text},
    });
  }

  /// The one frame that first shows the new content: what the reader sees.
  Future<void> frame(WidgetTester tester) async {
    await tester.pump();
  }

  testWidgets(
    'a growing Live Turn preview keeps the Entry being read in place',
    (tester) async {
      final h = await openConversation(tester);
      final position = timeline(tester);
      // Reading just above the newest entries, where the preview is on screen.
      position.jumpTo(120);
      await tester.pump();
      final read = reading(tester);

      for (var i = 0; i < 6; i++) {
        stream(tester, h, '\n\nParagraph $i of the answer.');
        await frame(tester);
        expect(reading(tester).id, read.id, reason: 'delta $i');
        expect(
          reading(tester).top,
          moreOrLessEquals(read.top, epsilon: 0.5),
          reason: 'the Entry being read stays where it is, delta $i',
        );
      }
      expect(
        position.pixels,
        greaterThan(120),
        reason: 'the Timeline scrolled by as much as the preview grew',
      );
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  testWidgets(
    'the Thinking box appearing keeps the Entry being read in place',
    (tester) async {
      final h = await openConversation(tester);
      final position = timeline(tester);
      position.jumpTo(120);
      await tester.pump();
      final read = reading(tester);

      h.live.eventController.add({
        'type': 'live.delta',
        'taskId': 'task-1',
        'delta': {'kind': 'thinking', 'text': 'Looking at the code.'},
      });
      await frame(tester);

      expect(reading(tester).id, read.id);
      expect(
        reading(tester).top,
        moreOrLessEquals(read.top, epsilon: 0.5),
        reason: 'the first frame already has the offset right: no jump back',
      );
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  testWidgets(
    'the answer stored as a Comment keeps the Entry being read in place',
    (tester) async {
      final h = await openConversation(tester);
      final position = timeline(tester);
      position.jumpTo(120);
      await tester.pump();
      for (var i = 0; i < 6; i++) {
        stream(tester, h, '\n\nParagraph $i of the answer.');
        await frame(tester);
      }
      final read = reading(tester);

      h.live.eventController.add({
        'type': 'comment.created',
        'comment': {
          ...commentData(
                'agent-9',
                'A stored answer',
                position: '16',
              )['comment']
              as Map<String, dynamic>,
          'kind': 'agent',
          'author': {
            'id': 'agent-1',
            'displayName': 'Ada Bot',
            'type': 'agent',
          },
        },
      });
      await frame(tester);

      expect(h.controller.liveText, isEmpty);
      expect(reading(tester).id, read.id);
      expect(
        reading(tester).top,
        moreOrLessEquals(read.top, epsilon: 0.5),
        reason: 'the Entry being read stays where it is',
      );
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  testWidgets('a Comment arriving keeps the Entry being read in place', (
    tester,
  ) async {
    final h = await openConversation(tester);
    final position = timeline(tester);
    position.jumpTo(120);
    await tester.pump();
    final read = reading(tester);

    h.live.eventController.add({
      'type': 'comment.created',
      'comment': {
        ...commentData('agent-9', 'An answer', position: '16')['comment']
            as Map<String, dynamic>,
        'kind': 'agent',
        'author': {'id': 'agent-1', 'displayName': 'Ada Bot', 'type': 'agent'},
      },
    });
    await frame(tester);

    expect(reading(tester).id, read.id);
    expect(
      reading(tester).top,
      moreOrLessEquals(read.top, epsilon: 0.5),
      reason: 'the Entry being read stays where it is',
    );
    await tester.pump(const Duration(milliseconds: 300));
  });

  testWidgets('a long Comment arriving keeps the Entry being read in place', (
    tester,
  ) async {
    final h = await openConversation(tester);
    final position = timeline(tester);
    position.jumpTo(120);
    await tester.pump();
    final read = reading(tester);

    h.live.eventController.add({
      'type': 'comment.created',
      'comment': {
        ...commentData(
              'agent-9',
              [for (var i = 1; i <= 30; i++) 'Paragraph $i of the answer.']
                  .join('\n\n'),
              position: '16',
            )['comment']
            as Map<String, dynamic>,
        'kind': 'agent',
        'author': {'id': 'agent-1', 'displayName': 'Ada Bot', 'type': 'agent'},
      },
    });
    await frame(tester);

    expect(reading(tester).id, read.id);
    expect(
      reading(tester).top,
      moreOrLessEquals(read.top, epsilon: 0.5),
      reason:
          'an Entry taller than the scroll offset still leaves the reader be',
    );
    await tester.pump(const Duration(milliseconds: 300));
  });

  testWidgets(
    'loading older entries does not move what the reader is reading',
    (tester) async {
      await openConversation(tester, older: true);
      final position = timeline(tester);
      // The oldest entries: reaching them loads the older page on its own.
      for (var i = 0; i < 3; i++) {
        position.jumpTo(position.maxScrollExtent);
        await tester.pump();
      }
      final read = reading(tester);

      await frame(tester);

      expect(find.textContaining('Older page'), findsOneWidget);
      expect(reading(tester).id, read.id);
      expect(
        reading(tester).top,
        moreOrLessEquals(read.top, epsilon: 0.5),
        reason: 'older Entries are added above the reader',
      );
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  testWidgets('at the bottom the Timeline follows new content', (tester) async {
    final h = await openConversation(tester);
    final position = timeline(tester);
    expect(position.pixels, 0);

    stream(tester, h, 'Here is what I found.');
    await frame(tester);

    expect(position.pixels, 0, reason: 'the newest content stays on screen');
    expect(find.textContaining('Here is what I found.'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 300));
  });
}
