import 'package:claude_task_mobile/src/models.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  group('parsing', () {
    test('a Worker names its Host and preserves host_offline', () {
      final worker = Worker.fromJson({
        ...workerData(),
        'host': {'id': 'host-1', 'name': 'ARM box', 'state': 'disconnected'},
        'state': 'host_offline',
      });
      expect(worker.hostName, 'ARM box');
      expect(worker.state, 'host_offline');
    });
    test('an Agent carries its Jobs and per-Worker sync errors', () {
      final agent = Agent.fromJson({
        'id': 'agent-1',
        'name': 'Ada Bot',
        'avatarEmoji': '🤖',
        'avatarImageUrl': null,
        'enabled': true,
        'state': 'working',
        'activeJobs': 2,
        'activeTasks': [
          {
            'id': 'task-1',
            'key': 'API-1',
            'title': 'Fix login',
            'projectId': 'project-1',
          },
        ],
        'extensionsPending': false,
        'extensionsError': 'Marketplace unavailable',
        'extensionErrors': [
          {
            'workerId': 'worker-1',
            'workerName': 'Default worker',
            'error': 'Marketplace unavailable',
          },
        ],
        'skillCommands': <Json>[],
      });
      expect(agent.state, 'working');
      expect(agent.activeJobs, 2);
      expect(agent.activeTasks.single.key, 'API-1');
      expect(agent.extensionErrors.single.id, 'worker-1');
      expect(agent.extensionErrors.single.name, 'Default worker');
    });

    test('an Agent cached before Workers still parses', () {
      final agent = Agent.fromJson({
        'id': 'agent-1',
        'name': 'Ada Bot',
        'enabled': true,
        'state': 'building',
        'dockerfile': 'FROM claude-task/agent-base',
        'containerState': 'running',
        'runnerConnected': true,
        'recreatePending': false,
        'queueLength': 2,
        'currentTask': null,
      });
      expect(agent.activeJobs, 0);
      expect(agent.activeTasks, isEmpty);
      expect(agent.extensionErrors, isEmpty);
    });

    test('a Worker carries its slots, counts and profile errors', () {
      final worker = Worker.fromJson(
        workerData(
          profileErrors: [
            {'agentId': 'agent-1', 'agentName': 'Ada Bot', 'error': 'Boom'},
          ],
        ),
      );
      expect(worker.name, 'Default worker');
      expect((worker.minimum, worker.cap), (1, 2));
      expect((worker.busy, worker.running, worker.queueLength), (1, 1, 3));
      expect(worker.projects.single['name'], 'Payments');
      expect(worker.profileErrors.single.name, 'Ada Bot');
      final [busy, free] = worker.containers;
      expect(busy.slot, 1);
      expect(busy.state, 'working');
      expect(busy.runnerConnected, isTrue);
      expect(busy.jobId, 'job-1');
      expect(busy.task!.key, 'API-1');
      expect(busy.agent!['name'], 'Ada Bot');
      expect(free.state, 'stopped');
      expect(free.containerState, 'missing');
      expect(free.task, isNull);
      expect(free.agent, isNull);
    });

    test("a Worker Slot's Job may have lost its Agent", () {
      final slot = WorkerContainer.fromJson({
        ...workerSlotData(1, state: 'working', task: true),
        'job': {
          'id': 'job-1',
          'task': {'id': 'task-1', 'key': 'API-1', 'title': 'Fix login'},
          'agent': null,
        },
      });
      expect(slot.task!.title, 'Fix login');
      expect(slot.agent, isNull);
    });

    test('Projects, Wikis and Schedules name their Worker', () {
      expect(
        Project.fromJson({...projectData, 'workerId': 'worker-1'}).workerId,
        'worker-1',
      );
      expect(Project.fromJson(projectData).workerId, isNull);
      final wiki = Wiki.fromJson({
        'id': 'wiki-1',
        'name': 'Docs',
        'taskId': 'task-1',
        'agentId': null,
        'workerId': 'worker-1',
        'repository': {'owner': 'acme', 'name': 'wiki'},
      });
      expect(wiki.workerId, 'worker-1');
      expect(wiki.agentId, isNull);
      final schedule = Schedule.fromJson({
        'id': 'schedule-1',
        'name': 'Nightly',
        'agentId': null,
        'workerId': 'worker-1',
      });
      expect(schedule.workerId, 'worker-1');
      final chat = WikiChat.fromJson({'id': 'task-1', 'agentId': null});
      expect(chat.agentId, isNull);
    });
  });

  group('controller', () {
    test('the refresh loads, caches and subscribes to Workers', () async {
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      expect(h.controller.workers.single.name, 'Default worker');
      expect(h.storage.read('global')!['workers'], hasLength(1));
      expect(h.live.topics, contains('workers'));
      expect(h.live.topics.where((t) => t.startsWith('worker:')), isEmpty);
      h.controller.watchWorker('worker-1');
      expect(h.live.topics, contains('worker:worker-1'));
      h.controller.watchWorker(null);
      expect(h.live.topics, isNot(contains('worker:worker-1')));
    });

    test('Worker events apply without a refresh', () async {
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      final before = h.api.calls.length;
      h.live.eventController.add({
        'type': 'worker.updated',
        'worker': workerData(id: 'worker-0', name: 'Alpha', state: 'building'),
      });
      expect(h.controller.workers.map((w) => w.name), [
        'Alpha',
        'Default worker',
      ]);
      h.live.eventController.add({
        'type': 'worker.updated',
        'worker': workerData(state: 'working'),
      });
      expect(h.controller.workers.byId('worker-1')!.state, 'working');
      h.live.eventController.add({
        'type': 'worker.deleted',
        'workerId': 'worker-0',
      });
      h.live.eventController.add({
        'type': 'queue.changed',
        'workerId': 'worker-1',
        'entries': <Json>[],
      });
      expect(h.controller.workers.map((w) => w.id), ['worker-1']);
      expect(
        (h.storage.read('global')!['workers'] as List).single['state'],
        'working',
      );
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(h.api.calls.length, before);
    });
  });
}
