import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/conversation.dart';
import 'package:flutter/widgets.dart' as widgets;
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

Map<String, dynamic> _delta(String text) => {
  'type': 'live.delta',
  'taskId': 'task-1',
  'delta': {'kind': 'text', 'commentId': null, 'text': text},
};

Future<Harness> _open(WidgetTester tester, {int comments = 20}) async {
  tester.view.physicalSize = const Size(430, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final h = Harness();
  addTearDown(h.dispose);
  h.api.items = [
    for (var i = 1; i <= comments; i++)
      commentData('comment-$i', 'Earlier **comment** $i', position: '$i'),
  ];
  await h.login();
  await h.openTask();
  await tester.pumpWidget(TaskApp(controller: h.controller));
  await tester.pumpAndSettle();
  return h;
}

/// Counts the rebuilds of each widget type while [body] runs.
Future<Map<Type, int>> _rebuilds(Future<void> Function() body) async {
  final counts = <Type, int>{};
  widgets.debugOnRebuildDirtyWidget = (element, _) =>
      counts[element.widget.runtimeType] =
          (counts[element.widget.runtimeType] ?? 0) + 1;
  try {
    await body();
  } finally {
    widgets.debugOnRebuildDirtyWidget = null;
  }
  return counts;
}

void main() {
  testWidgets(
    'streamed text updates the Live Turn preview without rebuilding the app or the stored Entries',
    (tester) async {
      final h = await _open(tester);
      var notified = 0;
      h.controller.addListener(() => notified++);

      final counts = await _rebuilds(() async {
        for (var i = 0; i < 5; i++) {
          h.live.eventController.add(_delta('word$i '));
          await tester.pump(const Duration(milliseconds: 16));
        }
      });
      expect(find.textContaining('word4'), findsOneWidget);
      expect(notified, 0, reason: 'tokens notify only the preview');
      expect(counts[TimelineTile], isNull);
      expect(counts[Composer], isNull);

      // A stored Entry still updates everyone.
      h.live.eventController.add({
        'type': 'comment.created',
        'comment': {
          ...commentData('agent-9', 'Stored answer', position: '30')['comment']
              as Map<String, dynamic>,
          'kind': 'agent',
          'author': {
            'id': 'agent-1',
            'displayName': 'Ada Bot',
            'type': 'agent',
          },
        },
      });
      await tester.pump();
      expect(notified, greaterThan(0));
      expect(find.text('Stored answer'), findsOneWidget);
      expect(h.controller.liveText, isEmpty);
      await tester.pump(const Duration(milliseconds: 200));
    },
  );

  testWidgets('a refresh that changes nothing keeps the Timeline rows', (
    tester,
  ) async {
    final h = await _open(tester);
    final before = List.of(h.controller.timeline);

    final counts = await _rebuilds(() async {
      await h.controller.refresh();
      await tester.pump();
    });
    for (var i = 0; i < before.length; i++) {
      expect(identical(h.controller.timeline[i], before[i]), isTrue);
    }
    expect(counts[TimelineTile], isNull);
  });

  testWidgets(
    'a clamped live answer stays as shown until Show more opens it, with all the text',
    (tester) async {
      final h = await _open(tester);
      h.live.eventController.add(
        _delta(
          [for (var i = 1; i <= 60; i++) 'Paragraph $i of the plan.']
              .join('\n\n'),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      expect(find.text('Show more').hitTestable(), findsOneWidget);

      h.live.eventController.add(_delta('\n\nEND-OF-STREAM'));
      await tester.pump(const Duration(milliseconds: 16));
      expect(find.textContaining('END-OF-STREAM'), findsNothing);

      await tester.tap(find.text('Show more').hitTestable());
      for (var frame = 0; frame < 30; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(find.textContaining('END-OF-STREAM'), findsOneWidget);

      // Open, it grows with the text again.
      h.live.eventController.add(_delta(' AND-MORE'));
      await tester.pump(const Duration(milliseconds: 16));
      expect(find.textContaining('AND-MORE'), findsOneWidget);
    },
  );

  testWidgets('typing saves the draft without rebuilding the conversation', (
    tester,
  ) async {
    final h = await _open(tester);
    var notified = 0;
    h.controller.addListener(() => notified++);
    await tester.tap(find.byKey(const Key('comment-composer')));
    await tester.pump();

    final counts = await _rebuilds(() async {
      await tester.enterText(find.byKey(const Key('comment-composer')), 'Hel');
      await tester.pump();
      await tester.enterText(
        find.byKey(const Key('comment-composer')),
        'Hello',
      );
      await tester.pump();
    });
    expect(h.controller.draft.text, 'Hello');
    expect(h.storage.read('draft:task-1')!['text'], 'Hello');
    expect(notified, 0);
    expect(counts[TimelineTile], isNull);
  });
}
