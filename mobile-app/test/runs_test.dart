import 'package:claude_task_mobile/src/api.dart' as ct;
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

const _start = '2026-10-26T10:00:00.000Z';

/// What the open sheet shows, so the bar behind it doesn't count.
Finder _inSheet(Finder finder) =>
    find.descendant(of: find.byType(SheetScaffold), matching: finder);

/// A Run starting, moving on or ending, as the backend announces it.
void _update(Harness h, Json run) => h.live.eventController.add({
  'type': 'run.updated',
  'taskId': 'task-1',
  'run': run,
});

/// One message of a Run's transcript, as the backend streams it.
void _message(Harness h, String runId, Json message) =>
    h.live.eventController.add({
      'type': 'run.message',
      'taskId': 'task-1',
      'runId': runId,
      'message': message,
    });

/// A Run's trace in the Timeline: what stays once the Run ended.
Json _runItem(String runId, Json run) => {
  'type': 'agent',
  'id': runId,
  'createdAt': at('3'),
  'readPosition': '3',
  'item': {
    'id': runId,
    'createdAt': at('3'),
    'payload': {'kind': 'run', 'run': run},
  },
};

List<String> _transcript(Json transcript) => [
  for (final message in objects(transcript['messages']))
    '${message['text'] ?? message['summary']}',
];

Future<Harness> _openTask(FakeApi api) async {
  final h = Harness(api: api);
  await h.login();
  await h.openTask();
  return h;
}

Future<Harness> _pumpTask(WidgetTester tester, FakeApi api) async {
  tester.view.physicalSize = const Size(1200, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final h = await _openTask(api);
  await tester.pumpWidget(TaskApp(controller: h.controller));
  await tester.pumpAndSettle();
  return h;
}

/// Opens a bar chip's sheet and lets its transcript land.
Future<void> _tapChip(WidgetTester tester, String id) async {
  await tester.tap(find.byKey(Key('run-chip:$id')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump();
}

void main() {
  test('the bar lists what runs now, then the failures left open', () async {
    final api = FakeApi()
      ..runs = [
        runData(
          id: 'run-error',
          description: 'Broken',
          status: 'error',
          error: 'It crashed',
          startedAt: '2026-10-26T10:00:05.000Z',
        ),
        runData(
          id: 'run-done',
          description: 'Old',
          status: 'ok',
          startedAt: '2026-10-26T10:00:01.000Z',
          finishedAt: '2026-10-26T10:00:04.000Z',
        ),
        runData(
          id: 'run-long',
          description: 'Slow',
          startedAt: '2026-10-26T10:00:03.000Z',
        ),
        runData(
          id: 'run-first',
          description: 'Quick',
          startedAt: '2026-10-26T10:00:02.000Z',
        ),
      ];
    final h = await _openTask(api);
    addTearDown(h.dispose);

    expect(h.controller.runBar.map((run) => run['id']), [
      'run-first',
      'run-long',
      'run-error',
    ]);

    // A failure the reader closed leaves the bar.
    h.controller.dismissRun('run-error');
    expect(h.controller.runBar.map((run) => run['id']), [
      'run-first',
      'run-long',
    ]);

    // One that finishes ok leaves by itself.
    _update(
      h,
      runData(
        id: 'run-first',
        description: 'Quick',
        status: 'ok',
        startedAt: '2026-10-26T10:00:02.000Z',
        finishedAt: '2026-10-26T10:00:09.000Z',
      ),
    );
    expect(h.controller.runBar.map((run) => run['id']), ['run-long']);
  });

  test(
    'messages that arrive before the transcript are kept and merged',
    () async {
      final api = FakeApi()
        ..runs = [runData(toolCalls: 1)]
        ..runTranscripts['run-1'] = transcriptData(
          runData(toolCalls: 1),
          messages: [runText(0, 'First thought')],
        );
      final h = await _openTask(api);
      addTearDown(h.dispose);

      h.controller.openRun('run-1');
      // The snapshot is still in flight: the next message must not be lost.
      _message(h, 'run-1', runText(1, 'Second thought'));
      expect(h.controller.runTranscripts, isEmpty);
      await pumpEventQueue();

      final transcript = h.controller.runTranscripts['run-1']!;
      expect(_transcript(transcript), ['First thought', 'Second thought']);
      expect(transcript['nextIndex'], 2);
    },
  );

  test('a tool result replaces its call in place', () async {
    final api = FakeApi()
      ..runs = [runData(toolCalls: 1)]
      ..runTranscripts['run-1'] = transcriptData(
        runData(toolCalls: 1),
        messages: [runTool(0, 'Read', 'Read src/a.ts')],
      );
    final h = await _openTask(api);
    addTearDown(h.dispose);

    h.controller.openRun('run-1');
    await pumpEventQueue();
    _message(
      h,
      'run-1',
      runTool(0, 'Read', 'Read src/a.ts', status: 'ok', outcome: '12 lines'),
    );

    final messages = objects(h.controller.runTranscripts['run-1']!['messages']);
    expect(messages, hasLength(1));
    expect(messages.single['status'], 'ok');
    expect(messages.single['outcome'], '12 lines');
  });

  test('a Run the backend no longer holds is marked gone', () async {
    final api = FakeApi()..runs = [runData()];
    final h = await _openTask(api);
    addTearDown(h.dispose);

    h.controller.openRun('run-1');
    await pumpEventQueue();

    expect(h.controller.runTranscripts, isEmpty);
    expect(h.controller.goneRuns, {'run-1'});
  });

  test(
    'a lost connection clears the Runs, and the next snapshot brings them back',
    () async {
      final api = FakeApi()..runs = [runData()];
      final h = await _openTask(api);
      addTearDown(h.dispose);
      expect(h.controller.runBar, hasLength(1));

      h.live.stateController.add(ct.ConnectionState.offline);
      expect(h.controller.runs, isEmpty);
      expect(h.controller.runBar, isEmpty);

      h.live.stateController.add(ct.ConnectionState.connected);
      await pumpEventQueue();
      expect(h.controller.runBar.single['id'], 'run-1');
    },
  );

  testWidgets('a chip above the composer opens the Run transcript', (
    tester,
  ) async {
    final api = FakeApi()
      ..runTranscripts['run-1'] = transcriptData(
        runData(toolCalls: 2),
        messages: [
          runText(0, 'Looking at the files'),
          runTool(1, 'Read', 'Read src/a.ts'),
        ],
      );
    final h = await _pumpTask(tester, api);
    addTearDown(h.dispose);
    expect(find.byKey(const Key('run-chip:run-1')), findsNothing);

    _update(h, runData(toolCalls: 2, startedAt: _start));
    await tester.pump();
    expect(find.byKey(const Key('run-chip:run-1')), findsOneWidget);
    expect(find.textContaining('2 calls'), findsOneWidget);

    await _tapChip(tester, 'run-1');
    // The title, the statistics line and the transcript.
    expect(_inSheet(find.text('Explore the repo')), findsOneWidget);
    expect(_inSheet(find.textContaining('Explore · running')), findsOneWidget);
    expect(_inSheet(find.text('Looking at the files')), findsOneWidget);
    expect(_inSheet(find.textContaining('Read src/a.ts')), findsOneWidget);

    // The prompt is there, folded.
    expect(_inSheet(find.text('Prompt')), findsOneWidget);
    expect(_inSheet(find.text('Look around')), findsNothing);
    await tester.tap(_inSheet(find.text('Prompt')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(_inSheet(find.text('Look around')), findsOneWidget);

    // A message that lands while the sheet is open shows up live.
    _message(h, 'run-1', runText(2, 'Found the bug'));
    await tester.pump();
    expect(_inSheet(find.text('Found the bug')), findsOneWidget);
  });

  testWidgets('a finished Run leaves the bar but keeps its Timeline trace', (
    tester,
  ) async {
    final api = FakeApi()
      ..items = [
        _runItem(
          'run-1',
          runData(
            status: 'ok',
            finishedAt: '2026-10-26T10:04:00.000Z',
            toolCalls: 3,
          ),
        ),
      ];
    final h = await _pumpTask(tester, api);
    addTearDown(h.dispose);
    expect(find.byKey(const Key('run:run-1')), findsOneWidget);

    _update(h, runData(startedAt: _start));
    await tester.pump();
    expect(find.byKey(const Key('run-chip:run-1')), findsOneWidget);

    _update(
      h,
      runData(
        status: 'ok',
        startedAt: _start,
        finishedAt: '2026-10-26T10:04:00.000Z',
        toolCalls: 3,
      ),
    );
    await tester.pump();
    expect(find.byKey(const Key('run-chip:run-1')), findsNothing);
    expect(find.byKey(const Key('run:run-1')), findsOneWidget);
    expect(find.textContaining('finished'), findsOneWidget);

    // Its row still opens the sheet, which says the transcript is gone.
    await tester.tap(find.byKey(const Key('run:run-1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
    expect(find.text('Explore the repo'), findsOneWidget);
    expect(
      find.text('This Run’s transcript is no longer in memory.'),
      findsOneWidget,
    );
  });

  testWidgets('an error chip stays until the reader dismisses it', (
    tester,
  ) async {
    final h = await _pumpTask(tester, FakeApi());
    addTearDown(h.dispose);

    _update(
      h,
      runData(
        status: 'error',
        error: 'The subagent crashed',
        startedAt: _start,
        finishedAt: '2026-10-26T10:02:00.000Z',
      ),
    );
    await tester.pump();
    expect(find.byKey(const Key('run-chip:run-1')), findsOneWidget);
    expect(find.byKey(const Key('dismiss-run:run-1')), findsOneWidget);

    await tester.tap(find.byKey(const Key('dismiss-run:run-1')));
    await tester.pump();
    expect(find.byKey(const Key('run-chip:run-1')), findsNothing);
  });

  testWidgets('the sheet shows how a Background Command ended', (tester) async {
    final ended = runData(
      description: 'npm ci',
      runType: 'command',
      subagentType: null,
      toolUseId: null,
      status: 'ok',
      outcome: 'npm ci completed (exit 0)',
      finishedAt: '2026-10-26T10:05:00.000Z',
    );
    final api = FakeApi()..items = [_runItem('run-1', ended)];
    final h = await _pumpTask(tester, api);
    addTearDown(h.dispose);

    _update(h, ended);
    await tester.pump();
    await tester.tap(find.byKey(const Key('run:run-1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();

    expect(_inSheet(find.text('npm ci completed (exit 0)')), findsOneWidget);
  });

  testWidgets('a finished Run fetches its transcript once more', (
    tester,
  ) async {
    final api = FakeApi()
      ..runTranscripts['run-1'] = transcriptData(
        runData(),
        messages: [runText(0, 'Working')],
      );
    final h = await _pumpTask(tester, api);
    addTearDown(h.dispose);

    _update(h, runData());
    await tester.pump();
    await _tapChip(tester, 'run-1');
    expect(_inSheet(find.text('Working')), findsOneWidget);

    // The last messages can land after the final status: the snapshot arrives
    // on a second fetch, not on a live message.
    final done = runData(status: 'ok', finishedAt: _start);
    api.runTranscripts['run-1'] = transcriptData(
      done,
      messages: [runText(0, 'Working'), runText(1, 'Done')],
    );
    _update(h, done);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
    expect(_inSheet(find.text('Done')), findsOneWidget);
  });

  testWidgets('a nested Subagent Run opens in place, with a way back', (
    tester,
  ) async {
    final api = FakeApi()
      ..runTranscripts['run-1'] = transcriptData(
        runData(),
        messages: [
          runTool(
            0,
            'Agent',
            'Spawn a helper',
            status: 'ok',
            childRunId: 'run-2',
          ),
        ],
      )
      ..runTranscripts['run-2'] = transcriptData(
        runData(
          id: 'run-2',
          description: 'Read the config',
          toolUseId: 'task9',
        ),
        prompt: 'Read it',
        messages: [runText(0, 'Config is fine')],
      );
    final h = await _pumpTask(tester, api);
    addTearDown(h.dispose);

    _update(h, runData());
    await tester.pump();
    await _tapChip(tester, 'run-1');
    expect(_inSheet(find.text('Open its Run')), findsOneWidget);

    await tester.tap(find.byKey(const Key('open-run:run-2')));
    await tester.pump();
    await tester.pump();
    expect(_inSheet(find.text('Read the config')), findsOneWidget);
    expect(_inSheet(find.text('Config is fine')), findsOneWidget);

    // The chevron goes back to the parent Run.
    expect(find.byTooltip('Back to the parent Run'), findsOneWidget);
    await tester.tap(find.byTooltip('Back to the parent Run'));
    await tester.pump();
    expect(_inSheet(find.text('Explore the repo')), findsOneWidget);
    expect(find.text('Config is fine'), findsNothing);
  });
}
