import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' hide ConnectionState;

import 'support.dart';

Json _limitComment(Json offer) => commentData(
  'limit-1',
  'Claude hit its usage limit.',
  kind: 'system',
  position: '3',
  author: {'id': null, 'displayName': 'System', 'type': 'system'},
  limitResume: offer,
);

Future<Harness> _open(
  List<Json> items, {
  List<Json> scheduled = const [],
}) async {
  final h = Harness();
  h.api.items = [commentData('comment-1', 'Hello'), ...items];
  h.api.scheduled = scheduled;
  await h.login();
  await h.openTask();
  return h;
}

void main() {
  group('TaskController', () {
    test(
      'lists pending messages by due time, then the finished ones',
      () async {
        final h = await _open(
          [],
          scheduled: [
            scheduledData('late', dueAt: '2099-03-01T10:00:00.000Z'),
            scheduledData(
              'done',
              state: 'sent',
              dueAt: '2098-01-01T10:00:00.000Z',
            ),
            scheduledData('soon', dueAt: '2099-02-01T10:00:00.000Z'),
          ],
        );
        addTearDown(h.dispose);
        expect(h.controller.scheduledMessages.map((m) => m.id), [
          'soon',
          'late',
          'done',
        ]);
      },
    );

    test(
      'scheduled_message.updated inserts, replaces and ignores other Tasks',
      () async {
        final h = await _open([], scheduled: [scheduledData('a')]);
        addTearDown(h.dispose);
        h.live.eventController.add({
          'type': 'scheduled_message.updated',
          'message': scheduledData('b', dueAt: '2099-01-01T10:00:00.000Z'),
        });
        expect(h.controller.scheduledMessages.map((m) => m.id), ['b', 'a']);
        h.live.eventController.add({
          'type': 'scheduled_message.updated',
          'message': scheduledData('b', state: 'cancelled', cancelReason: 'x'),
        });
        expect(h.controller.scheduledMessages.map((m) => m.id), ['a', 'b']);
        expect(h.controller.scheduledMessages.last.pending, isFalse);
        h.live.eventController.add({
          'type': 'scheduled_message.updated',
          'message': {...scheduledData('c'), 'taskId': 'other'},
        });
        expect(h.controller.scheduledMessages.length, 2);
      },
    );

    test('scheduling is not queued offline and keeps the draft', () async {
      final h = await _open([]);
      addTearDown(h.dispose);
      await h.controller.setDraft(const Draft(text: 'Later'));
      h.controller.connection = ConnectionState.offline;
      final ok = await h.controller.scheduleDraft(
        DateTime.now().add(const Duration(hours: 2)),
      );
      expect(ok, isFalse);
      expect(h.controller.error, contains('Offline'));
      expect(h.controller.draft.text, 'Later');
      expect(
        h.api.calls,
        isNot(contains('POST /tasks/task-1/scheduled-messages')),
      );
    });

    test('scheduling posts the draft with a UTC time and clears it', () async {
      final h = await _open([]);
      addTearDown(h.dispose);
      await h.controller.setDraft(const Draft(text: 'Later', internal: true));
      final due = DateTime.now().add(const Duration(hours: 2));
      expect(await h.controller.scheduleDraft(due), isTrue);
      final body = h.api.bodies['POST /tasks/task-1/scheduled-messages']!;
      expect(body['body'], 'Later');
      expect(body['internal'], true);
      expect(DateTime.parse(body['dueAt'] as String).isUtc, isTrue);
      expect(h.controller.draft.text, isEmpty);
      expect(h.controller.scheduledMessages.single.internal, isTrue);
    });

    test(
      'a 409 on a scheduled message refreshes the list and reports it',
      () async {
        final h = await _open([], scheduled: [scheduledData('a')]);
        addTearDown(h.dispose);
        h.api.scheduleTool = (method, path, body) {
          h.api.scheduled = [scheduledData('a', state: 'sent')];
          throw const ApiException(409, 'conflict', 'Already sent');
        };
        expect(await h.controller.cancelScheduled('a'), isFalse);
        expect(h.controller.error, 'Already sent');
        expect(h.controller.scheduledMessages.single.state, 'sent');
      },
    );

    test('Automatic resume at limit follows the Task', () async {
      final h = await _open([]);
      addTearDown(h.dispose);
      expect(h.controller.task!.autoResume, isFalse);
      await h.controller.setAutoResume(true);
      expect(h.api.bodies['PUT /tasks/task-1/auto-resume'], {'enabled': true});
      expect(h.controller.task!.autoResume, isTrue);
    });
  });

  group('widgets', () {
    Future<Harness> pump(
      WidgetTester tester,
      List<Json> items, {
      List<Json> scheduled = const [],
    }) async {
      tester.view.physicalSize = const Size(430, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = await _open(items, scheduled: scheduled);
      addTearDown(h.dispose);
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      return h;
    }

    Future<void> pickTime(WidgetTester tester) async {
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
    }

    testWidgets('the /schedule command turns Send into Schedule', (
      tester,
    ) async {
      final h = await pump(tester, []);
      expect(find.byKey(const Key('scheduled-section')), findsNothing);
      expect(find.byKey(const Key('schedule-button')), findsNothing);
      await tester.enterText(
        find.byKey(const Key('comment-composer')),
        'Later /sch',
      );
      await tester.pumpAndSettle();
      // The hint is tagged System, and picking it removes the token.
      expect(find.text('System'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('skill-command:schedule')));
      await tester.pumpAndSettle();
      await pickTime(tester);
      expect(find.byKey(const Key('schedule-chip')), findsOneWidget);
      expect(find.text('Schedule'), findsOneWidget);
      expect(h.controller.draft.text.trim(), 'Later');

      // Clearing goes back to a plain send.
      await tester.tap(find.byTooltip('Clear schedule'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('schedule-chip')), findsNothing);
      expect(find.text('Schedule'), findsNothing);

      // Sending only /schedule runs the command instead of posting it.
      await tester.enterText(
        find.byKey(const Key('comment-composer')),
        '/schedule',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('send-comment')));
      await tester.pumpAndSettle();
      expect(h.api.sendCount, 0);
      await pickTime(tester);
      expect(find.byKey(const Key('schedule-chip')), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('comment-composer')),
        'Later',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('send-comment')));
      await tester.pumpAndSettle();
      expect(h.api.sendCount, 0);
      expect(
        h.api.bodies['POST /tasks/task-1/scheduled-messages']!['body'],
        'Later',
      );
      expect(find.byKey(const Key('schedule-chip')), findsNothing);
      // The new message shows in the Scheduled section.
      expect(find.byKey(const Key('scheduled-section')), findsOneWidget);
      expect(find.text('Later'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the Scheduled section acts on pending messages', (
      tester,
    ) async {
      final h = await pump(
        tester,
        [],
        scheduled: [
          scheduledData('s1', body: 'Ping the team', internal: true),
          scheduledData(
            's2',
            kind: 'limit_resume',
            body: '',
            dueAt: '2099-03-01T10:00:00.000Z',
          ),
          scheduledData('s3', state: 'cancelled', cancelReason: 'Superseded'),
        ],
      );
      expect(find.text('Ping the team'), findsOneWidget);
      expect(find.text('Internal chat'), findsWidgets);
      expect(find.text('Resume after usage limit'), findsOneWidget);
      // History is collapsed.
      expect(find.byKey(const ValueKey('scheduled:s3')), findsNothing);
      await tester.tap(find.byKey(const Key('scheduled-history-toggle')));
      await tester.pumpAndSettle();
      expect(find.textContaining('Cancelled · Superseded'), findsOneWidget);

      h.api.scheduleTool = (method, path, body) {
        final id = path.split('/')[2];
        return {
          'message': scheduledData(
            id,
            state: method == 'DELETE' ? 'cancelled' : 'sent',
            cancelReason: method == 'DELETE' ? 'Cancelled by Ada' : null,
          ),
        };
      };
      await tester.tap(find.byKey(const Key('scheduled-cancel:s1')));
      await tester.pumpAndSettle();
      expect(h.api.calls, contains('DELETE /scheduled-messages/s1'));
      expect(find.byKey(const Key('scheduled-cancel:s1')), findsNothing);
      await tester.tap(find.byKey(const Key('scheduled-send:s2')));
      await tester.pumpAndSettle();
      expect(h.api.calls, contains('POST /scheduled-messages/s2/send'));
      expect(find.byKey(const Key('scheduled-section')), findsOneWidget);
    });

    testWidgets('editing a Limit Resume changes only its time', (tester) async {
      // Two days out, so the picker opens on a month where a neighbouring
      // day is still ahead.
      final base = DateTime.now().add(const Duration(days: 2));
      final h = await pump(
        tester,
        [],
        scheduled: [
          scheduledData(
            's2',
            kind: 'limit_resume',
            body: '',
            dueAt: base.toUtc().toIso8601String(),
          ),
        ],
      );
      h.api.scheduleTool = (method, path, body) => {
        'message': scheduledData(
          's2',
          kind: 'limit_resume',
          body: '',
          dueAt: body!['dueAt'] as String,
        ),
      };
      await tester.tap(find.byKey(const Key('scheduled-edit:s2')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('scheduled-edit-text')), findsNothing);
      await tester.tap(find.byKey(const Key('scheduled-edit-time')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.text('${base.day < 28 ? base.day + 1 : base.day - 1}'),
      );
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      final sent = h.api.bodies['PATCH /scheduled-messages/s2']!;
      expect(sent.keys, ['dueAt']);
    });

    testWidgets('an open usage limit asks, and Schedule resume answers', (
      tester,
    ) async {
      final h = await pump(tester, [_limitComment(limitResumeData())]);
      expect(find.textContaining('Usage limit resets'), findsOneWidget);
      h.api.scheduleTool = (method, path, body) => {
        'comment': _limitComment(
          limitResumeData(state: 'scheduled', decidedBy: ada),
        )['comment'],
      };
      await tester.tap(find.text('Schedule resume'));
      await tester.pumpAndSettle();
      expect(h.api.bodies['POST /comments/limit-1/limit-resume'], {
        'schedule': true,
      });
      expect(find.text('Resume scheduled by Ada'), findsOneWidget);
      expect(find.text('Schedule resume'), findsNothing);
    });

    testWidgets('a limit answered meanwhile shows who answered', (
      tester,
    ) async {
      final h = await pump(tester, [_limitComment(limitResumeData())]);
      h.api.scheduleTool = (method, path, body) {
        h.api.items = [
          commentData('comment-1', 'Hello'),
          _limitComment(limitResumeData(state: 'declined', decidedBy: mia)),
        ];
        throw const ApiException(409, 'conflict', 'Mia already answered');
      };
      await tester.tap(find.text('No'));
      await tester.pumpAndSettle();
      expect(find.text('Declined by Mia'), findsOneWidget);
      expect(find.text('No'), findsNothing);
    });

    for (final (state, who, text) in [
      ('scheduled', null, 'Resume scheduled automatically'),
      ('declined', ada, 'Declined by Ada'),
      ('unneeded', null, 'No longer needed'),
    ]) {
      testWidgets('a $state usage limit reads "$text"', (tester) async {
        await pump(tester, [
          _limitComment(limitResumeData(state: state, decidedBy: who)),
        ]);
        expect(find.text(text), findsOneWidget);
        expect(find.widgetWithText(AppButton, 'Schedule resume'), findsNothing);
      });
    }

    testWidgets('the Task menu toggles Automatic resume at limit', (
      tester,
    ) async {
      final h = await pump(tester, []);
      await tester.tap(find.byTooltip('Task actions'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Automatic resume at limit'));
      await tester.pumpAndSettle();
      expect(h.api.bodies['PUT /tasks/task-1/auto-resume'], {'enabled': true});
      await tester.tap(find.byTooltip('Task actions'));
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.check_box_rounded), findsOneWidget);
    });
  });
}
