import 'package:claude_task_mobile/src/api.dart' as api_;
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' hide ConnectionState;

import 'support.dart';

Json scheduleData({
  String id = 'schedule-1',
  String name = 'Nightly review',
  String cron = '0 3 * * *',
  String timeZone = 'Europe/Rome',
  String? agentId = 'agent-1',
  Json? repository,
  bool readOnly = false,
  bool enabled = true,
  String? nextRunAt = '2026-11-01T02:00:00.000Z',
  int consecutiveSkips = 0,
  Json? lastRun,
}) => {
  'id': id,
  'projectId': 'project-$id',
  'name': name,
  'agentId': agentId,
  'cron': cron,
  'timeZone': timeZone,
  'prompt': 'Review the repository and report.',
  'repository': repository,
  'readOnly': readOnly,
  'enabled': enabled,
  'nextRunAt': nextRunAt,
  'consecutiveSkips': consecutiveSkips,
  'createdBy': {'id': 'user-1', 'displayName': 'Ada'},
  'lastRun': lastRun,
  'createdAt': at('1'),
  'updatedAt': at('1'),
};

Json scheduleRunData({
  String id = 'run-1',
  String state = 'succeeded',
  bool manual = false,
  String dueAt = '2026-10-31T02:00:00.000Z',
  String? taskId = 'task-1',
  String? taskKey = 'API-1',
  String? skipReason,
  String startedAt = '2026-10-31T02:00:01.000Z',
  String? finishedAt = '2026-10-31T02:04:01.000Z',
}) => {
  'id': id,
  'scheduleId': 'schedule-1',
  'state': state,
  'manual': manual,
  'dueAt': dueAt,
  'taskId': taskId,
  'taskKey': taskKey,
  'skipReason': skipReason,
  'startedAt': startedAt,
  'finishedAt': finishedAt,
};

class ScheduleApi extends FakeApi {
  ScheduleApi({bool empty = false}) {
    if (empty) {
      schedules = [];
      return;
    }
    schedules = [
      scheduleData(lastRun: scheduleRunData()),
      scheduleData(
        id: 'schedule-2',
        name: 'Morning triage',
        cron: '0 8 * * 1-5',
        enabled: false,
        nextRunAt: null,
        repository: {
          'connectionId': 'git-1',
          'providerRepoId': '9',
          'owner': 'acme',
          'name': 'app',
          'defaultBranch': 'main',
        },
        readOnly: true,
        lastRun: scheduleRunData(
          id: 'run-0',
          state: 'skipped',
          taskId: null,
          taskKey: null,
          skipReason: 'previous run still active',
          finishedAt: null,
        ),
      ),
    ];
    history['schedule-1'] = [
      scheduleRunData(),
      scheduleRunData(
        id: 'run-2',
        state: 'running',
        taskId: 'task-2',
        taskKey: 'API-2',
        startedAt: '2026-10-30T02:00:00.000Z',
        finishedAt: null,
      ),
    ];
    history['schedule-2'] = [
      scheduleRunData(
        id: 'run-0',
        state: 'skipped',
        taskId: null,
        taskKey: null,
        skipReason: 'previous run still active',
        finishedAt: null,
      ),
    ];
  }
  List<Json> schedules = [];
  final history = <String, List<Json>>{};
  int created = 0;

  Json _find(String id) => schedules.firstWhere(
    (s) => s['id'] == id,
    orElse: () =>
        throw api_.ApiException(404, 'not_found', 'Schedule not found'),
  );

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    // Let the base fake answer its own routes and its offline/expiry switches.
    if (offline || expire) {
      return super.request(method, path, body: body, files: files);
    }
    calls.add('$method $path');
    bodies['$method $path'] = body;
    if (path == '/schedules' && method == 'GET') {
      // The backend lists Schedules by name.
      final sorted = [...schedules]
        ..sort(
          (a, b) => '${a['name']}'.toLowerCase().compareTo(
            '${b['name']}'.toLowerCase(),
          ),
        );
      return {'schedules': sorted};
    }
    if (path == '/schedules' && method == 'POST') {
      created++;
      final createdSchedule = {
        ...scheduleData(id: 'schedule-new', name: body!['name'] as String),
        ...body,
        'projectId': 'project-schedule-new',
        'lastRun': null,
      };
      schedules = [...schedules, createdSchedule];
      history['schedule-new'] = [];
      return {'schedule': createdSchedule};
    }
    final runsMatch = RegExp(r'^/schedules/([^/]+)/runs$').firstMatch(path);
    if (runsMatch != null && method == 'GET') {
      _find(runsMatch.group(1)!);
      return {'runs': history[runsMatch.group(1)!] ?? []};
    }
    final runMatch = RegExp(r'^/schedules/([^/]+)/run$').firstMatch(path);
    if (runMatch != null && method == 'POST') {
      final id = runMatch.group(1)!;
      final schedule = _find(id);
      final run = scheduleRunData(
        id: 'run-manual',
        state: 'running',
        manual: true,
        startedAt: '2026-10-31T12:00:00.000Z',
        finishedAt: null,
      );
      history[id] = [run, ...history[id] ?? []];
      schedules = [
        for (final s in schedules)
          if (s['id'] == id) {...schedule, 'lastRun': run} else s,
      ];
      return {'run': run};
    }
    final one = RegExp(r'^/schedules/([^/]+)$').firstMatch(path);
    if (one != null) {
      final id = one.group(1)!;
      final schedule = _find(id);
      if (method == 'GET') return {'schedule': schedule};
      if (method == 'PATCH') {
        final updated = {...schedule, ...body!, 'updatedAt': at('2')};
        schedules = [
          for (final s in schedules)
            if (s['id'] == id) updated else s,
        ];
        return {'schedule': updated};
      }
      if (method == 'DELETE') {
        schedules = schedules.where((s) => s['id'] != id).toList();
        history.remove(id);
        return {};
      }
    }
    if (path == '/git/repositories') {
      return {
        'groups': [
          {
            'repositories': [
              {
                'connectionId': 'git-1',
                'providerRepoId': '9',
                'owner': 'acme',
                'name': 'app',
                'defaultBranch': 'main',
              },
            ],
          },
        ],
      };
    }
    return super.request(method, path, body: body, files: files);
  }
}

Future<Harness> _login({ScheduleApi? api, bool admin = false}) async {
  final h = Harness(api: api ?? ScheduleApi());
  if (admin) h.api.user = {...userData, 'role': 'admin'};
  await h.login();
  return h;
}

Future<void> _settle() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  group('Schedules in the controller', () {
    test('the refresh loads and caches the list', () async {
      final h = await _login();
      addTearDown(h.dispose);
      expect(h.controller.schedules.map((s) => s.name), [
        'Morning triage',
        'Nightly review',
      ]);
      expect((h.storage.read('schedules')!['schedules'] as List).length, 2);
      expect(h.controller.schedules.first.readOnly, isTrue);
      expect(h.controller.schedules.first.lastRun!.state, 'skipped');
      expect(h.controller.schedules.last.lastRun!.state, 'succeeded');
    });

    test('the section subscribes to the schedules topic', () async {
      final h = await _login();
      addTearDown(h.dispose);
      await h.controller.selectProject(h.controller.projects.first);
      expect(h.live.topics, isNot(contains('schedules')));
      h.controller.showSchedules();
      expect(h.controller.scheduleSection, isTrue);
      expect(h.controller.project, isNull);
      expect(h.controller.wikiSection, isFalse);
      expect(h.live.topics, contains('schedules'));
    });

    test(
      'opening a Schedule loads its configuration and run history',
      () async {
        final h = await _login();
        addTearDown(h.dispose);
        h.controller.showSchedules();
        await h.controller.selectSchedule(h.controller.schedules.last);
        expect(h.controller.schedule!.name, 'Nightly review');
        expect(h.controller.scheduleRuns.map((r) => r.id), ['run-1', 'run-2']);
        expect(h.controller.scheduleRuns.last.running, isTrue);
        expect(
          (h.storage.read('schedule:schedule-1')!['runs'] as List).length,
          2,
        );
        expect(h.live.topics, contains('schedules'));
      },
    );

    test('an offline reopen reads the cached history', () async {
      final h = await _login();
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await h.controller.selectSchedule(h.controller.schedules.last);
      h.controller.backToSchedules();
      h.api.offline = true;
      h.controller.connection = api_.ConnectionState.offline;
      await h.controller.selectSchedule(
        h.controller.schedules.firstWhere((s) => s.id == 'schedule-1'),
      );
      expect(h.controller.scheduleRuns.map((r) => r.id), ['run-1', 'run-2']);
    });

    test('Run now starts a run without moving the next run time', () async {
      final h = await _login(admin: true);
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await h.controller.selectSchedule(h.controller.schedules.last);
      final next = h.controller.schedule!.nextRunAt;
      await h.controller.runScheduleNow();
      expect(h.api.calls, contains('POST /schedules/schedule-1/run'));
      expect(h.controller.scheduleRuns.first.manual, isTrue);
      expect(h.controller.scheduleRuns.first.running, isTrue);
      expect(h.controller.schedule!.nextRunAt, next);
    });

    test('pause and resume patch the enabled flag', () async {
      final h = await _login(admin: true);
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await h.controller.selectSchedule(h.controller.schedules.last);
      await h.controller.setScheduleEnabled(h.controller.schedule!, false);
      expect(h.api.bodies['PATCH /schedules/schedule-1'], {'enabled': false});
      expect(h.controller.schedule!.enabled, isFalse);
      expect(
        h.controller.schedules.firstWhere((s) => s.id == 'schedule-1').enabled,
        isFalse,
      );
    });

    test('creating a Schedule opens it', () async {
      final h = await _login(admin: true);
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await h.controller.saveSchedule({
        'name': 'Weekly report',
        'agentId': 'agent-1',
        'cron': '0 9 * * 1',
        'timeZone': 'UTC',
        'prompt': 'Summarise the week.',
        'readOnly': false,
        'repository': null,
      });
      expect((h.api as ScheduleApi).created, 1);
      expect(h.controller.schedule!.name, 'Weekly report');
      expect(
        h.controller.schedules.map((s) => s.name),
        contains('Weekly report'),
      );
    });

    test('editing keeps the open Schedule in step', () async {
      final h = await _login(admin: true);
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await h.controller.selectSchedule(h.controller.schedules.last);
      await h.controller.saveSchedule({
        'name': 'Renamed review',
        'cron': '0 4 * * *',
      }, existing: h.controller.schedule);
      expect(h.controller.schedule!.name, 'Renamed review');
      expect(h.controller.schedule!.cron, '0 4 * * *');
      expect(
        h.controller.schedules.firstWhere((s) => s.id == 'schedule-1').name,
        'Renamed review',
      );
    });

    test(
      'deleting a Schedule returns to the list and drops its cache',
      () async {
        final h = await _login(admin: true);
        addTearDown(h.dispose);
        h.controller.showSchedules();
        await h.controller.selectSchedule(h.controller.schedules.last);
        await h.controller.deleteSchedule();
        expect(h.api.calls, contains('DELETE /schedules/schedule-1'));
        expect(h.controller.schedule, isNull);
        expect(h.controller.scheduleSection, isTrue);
        expect(h.controller.schedules.map((s) => s.id), ['schedule-2']);
        expect(h.storage.read('schedule:schedule-1'), isEmpty);
      },
    );

    test(
      'a schedule.changed event refetches the list and the open Schedule',
      () async {
        final h = await _login();
        addTearDown(h.dispose);
        h.controller.showSchedules();
        await h.controller.selectSchedule(h.controller.schedules.last);
        (h.api as ScheduleApi).schedules = [
          for (final s in (h.api as ScheduleApi).schedules)
            if (s['id'] == 'schedule-1')
              {...s, 'name': 'Renamed elsewhere'}
            else
              s,
        ];
        h.live.eventController.add({
          'type': 'schedule.changed',
          'scheduleId': 'schedule-1',
        });
        await _settle();
        expect(h.controller.schedule!.name, 'Renamed elsewhere');
        expect(
          h.controller.schedules.firstWhere((s) => s.id == 'schedule-1').name,
          'Renamed elsewhere',
        );
      },
    );

    test(
      'a skipped run has no Task; a started one opens its conversation',
      () async {
        final h = await _login();
        addTearDown(h.dispose);
        h.controller.showSchedules();
        await h.controller.selectSchedule(h.controller.schedules.last);
        final skipped = ScheduleRun.fromJson(
          scheduleRunData(
            id: 'run-skip',
            state: 'skipped',
            taskId: null,
            taskKey: null,
            skipReason: 'agent unavailable',
            finishedAt: null,
          ),
        );
        await h.controller.openScheduleRun(skipped);
        expect(h.controller.task, isNull);
        await h.controller.openScheduleRun(h.controller.scheduleRuns.first);
        expect(h.controller.task!.id, 'task-1');
        expect(h.controller.scheduleRunOpen, isTrue);
        expect(h.live.topics, contains('task:task-1'));
        expect(h.live.topics, contains('schedules'));
      },
    );

    test('a notification opens a run within its Schedule', () async {
      final h = await _login();
      addTearDown(h.dispose);
      h.api.task2 = {...h.api.task2, 'projectId': 'project-schedule-1'};
      await h.controller.openNotification('task-2');
      expect(h.controller.scheduleSection, isTrue);
      expect(h.controller.schedule!.id, 'schedule-1');
      expect(h.controller.task!.id, 'task-2');
      expect(h.controller.scheduleRunOpen, isTrue);
    });

    test('a closed run is read-only; a running one accepts Comments', () async {
      final h = await _login();
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await h.controller.selectSchedule(h.controller.schedules.last);
      h.api.session = {'state': 'running'};
      await h.controller.openScheduleRun(h.controller.scheduleRuns.last);
      expect(h.controller.scheduleRunReadOnlyReason, isNull);
      h.api.session = {'state': 'closed'};
      await h.controller.openScheduleRun(h.controller.scheduleRuns.last);
      expect(
        h.controller.scheduleRunReadOnlyReason,
        'This run is closed: its conversation is read-only.',
      );
      await h.controller.setDraft(const Draft(text: 'Hello'));
      await h.controller.send();
      expect(h.api.sendCount, 0);
    });
  });

  group('Schedules on screen', () {
    testWidgets('the list opens a Schedule and its run history', (
      tester,
    ) async {
      final h = await _login();
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      expect(find.text('Schedules'), findsOneWidget);
      expect(find.text('Nightly review'), findsOneWidget);
      expect(find.text('Morning triage'), findsOneWidget);
      // The cadence is shown in words, with the scope and the pause state.
      expect(find.textContaining('Every day at 03:00'), findsOneWidget);
      expect(find.textContaining('Paused'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('schedule-row:schedule-1')));
      await tester.pumpAndSettle();
      expect(find.text('Nightly review'), findsOneWidget);
      expect(find.byType(SelectableText), findsOneWidget);
      expect(
        tester.widget<SelectableText>(find.byType(SelectableText)).data,
        'Review the repository and report.',
      );
      expect(find.byKey(const ValueKey('schedule-run:run-1')), findsOneWidget);
      expect(find.byKey(const ValueKey('schedule-run:run-2')), findsOneWidget);

      await tester.ensureVisible(
        find.byKey(const ValueKey('schedule-run:run-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('schedule-run:run-1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('comment-composer')), findsOneWidget);
    });

    testWidgets('a Member sees no admin controls', (tester) async {
      final h = await _login();
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      expect(find.byTooltip('New schedule'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('schedule-row:schedule-1')));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Run now'), findsNothing);
      expect(find.byTooltip('Schedule actions'), findsNothing);
    });

    testWidgets('an Admin sees the actions and the form previews the cron', (
      tester,
    ) async {
      final h = await _login(admin: true);
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      expect(find.byTooltip('New schedule'), findsOneWidget);
      await tester.tap(find.byTooltip('New schedule'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('schedule-name')), findsOneWidget);
      expect(find.text('Monday to Friday at 09:00'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('schedule-cron')), 'bad');
      await tester.pumpAndSettle();
      expect(find.text('not valid'), findsOneWidget);
    });

    testWidgets('an Admin opens, pauses and runs a Schedule', (tester) async {
      final h = await _login(admin: true);
      addTearDown(h.dispose);
      h.controller.showSchedules();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('schedule-row:schedule-1')));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Run now'), findsOneWidget);
      await tester.tap(find.byTooltip('Run now'));
      await tester.pumpAndSettle();
      expect(h.api.calls, contains('POST /schedules/schedule-1/run'));
      expect(
        find.byKey(const ValueKey('schedule-run:run-manual')),
        findsOneWidget,
      );
    });
  });
}
