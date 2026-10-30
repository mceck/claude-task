import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

Json setupEvent(
  String chunk, {
  String jobId = 'job-1',
  String taskId = 'task-1',
}) => {
  'type': 'job.setup_output',
  'taskId': taskId,
  'jobId': jobId,
  'chunk': chunk,
};

Json activityEvent({String id = 'item-1', String position = '3'}) => {
  'type': 'agent_item.created',
  'item': {
    'id': id,
    'taskId': 'task-1',
    'createdAt': at(position),
    'payload': {'kind': 'activity', 'entries': <Json>[]},
  },
};

void main() {
  test(
    'setup output appends per Job and clears when the Activity item arrives',
    () async {
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.openTask();

      h.live.eventController.add(setupEvent('Cloning...\n'));
      h.live.eventController.add(setupEvent('Installing...\n'));
      expect(h.controller.liveSetup, {
        'jobId': 'job-1',
        'output': 'Cloning...\nInstalling...\n',
      });

      // Another Task's output never leaks into the open one.
      h.live.eventController.add(setupEvent('Elsewhere', taskId: 'task-2'));
      expect(h.controller.liveSetup!['output'], 'Cloning...\nInstalling...\n');

      // A new Job's output starts over instead of following the previous Job's.
      h.live.eventController.add(setupEvent('Fresh', jobId: 'job-2'));
      expect(h.controller.liveSetup, {'jobId': 'job-2', 'output': 'Fresh'});

      // The Activity item that follows takes over from the live preview, as on the web.
      h.live.eventController.add(activityEvent());
      expect(h.controller.liveSetup, isNull);
    },
  );

  test('setup output keeps only the last 64 KB', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();

    final chunk = 'x' * (40 * 1024);
    h.live.eventController.add(setupEvent(chunk));
    h.live.eventController.add(setupEvent(chunk));
    final output = h.controller.liveSetup!['output'] as String;
    expect(output.length, 64 * 1024);
    expect(output, 'x' * (64 * 1024));
  });

  testWidgets('the live tail shows an expandable "Preparing the worktree"', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();

    h.live.eventController.add(
      setupEvent('\$ mise install\nInstalling node 22.5.1\n'),
    );
    await tester.pump();
    final title = find.text('Preparing the worktree');
    expect(title, findsOneWidget);
    // Collapsed until the reader opens it.
    expect(find.textContaining('Installing node 22.5.1'), findsNothing);

    await tester.tap(title);
    await tester.pumpAndSettle();
    expect(find.textContaining('Installing node 22.5.1'), findsOneWidget);

    // The Activity item replaces the preview.
    h.live.eventController.add(activityEvent());
    await tester.pump();
    expect(find.text('Preparing the worktree'), findsNothing);
    // Let the controller's pending refresh run out.
    await tester.pump(const Duration(milliseconds: 200));
    expect(tester.takeException(), isNull);
  });
}
