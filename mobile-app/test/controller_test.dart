import 'package:flutter_test/flutter_test.dart';
import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/models.dart';

import 'support.dart';

void main() {
  test('login stores only cookie, installation and User, and expiry requires authentication', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    expect(h.controller.user!.id, 'user-1');
    expect(h.storage.login!['cookie'], 'ct_login=secret');
    expect(h.storage.login.toString(), isNot(contains('password')));
    h.api.expire = true;
    await expectLater(h.controller.refresh(), throwsA(isA<ApiException>()));
    expect(h.controller.user, isNull);
    expect(h.storage.login, isNull);
  });
  test('temporary password gates access until it is changed', () async {
    final h = Harness();
    addTearDown(h.dispose);
    h.api.user['mustChangePassword'] = true;
    await h.login();
    expect(h.controller.user!.mustChangePassword, true);
    expect(h.api.calls, isNot(contains('GET /projects')));
    await h.controller.changePassword('temporary', 'new-password');
    expect(h.controller.user!.mustChangePassword, false);
    expect(h.controller.projects, hasLength(1));
  });
  test('Create and assign keeps the Task and retries only versioned assignment after partial failure', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectProject(h.controller.projects.first);
    h.api.failAssignment = true;
    await h.controller.createTask(title: 'New Task', agentId: 'agent-1');
    expect(h.api.createCount, 1);
    expect(h.controller.task!.title, 'New Task');
    expect(h.controller.assignmentRetryId, 'agent-1');
    h.api.failAssignment = false;
    await h.controller.retryAssignment();
    expect(h.api.createCount, 1);
    expect(h.controller.task!.agentId, 'agent-1');
    expect(h.controller.assignmentRetryId, isNull);
  });
  test('merging an open Pull Request updates the Task from the API', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    h.api.currentTask = {
      ...taskData(),
      'pullRequest': {
        'provider': 'github',
        'number': 7,
        'url': 'https://github.com/acme/app/pull/7',
        'state': 'open',
        'draft': false,
      },
    };
    await h.controller.selectProject(h.controller.projects.first);
    await h.controller.selectTask(h.controller.tasks.first);
    expect(h.controller.task!.canMergePullRequest, true);
    await h.controller.mergePullRequest();
    expect(h.api.calls, contains('POST /tasks/task-1/pull-request/merge'));
    expect(h.controller.task!.pullRequest!['state'], 'merged');
    expect(h.controller.task!.canMergePullRequest, false);
  });
  test('creating without an Agent never starts a Session', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.controller.selectProject(h.controller.projects.first);
    await h.controller.createTask(title: 'Plan only');
    expect(h.api.calls.where((c) => c.startsWith('PATCH')), isEmpty);
    expect(h.api.createCount, 1);
  });
  test('pagination merges persisted entries; transient fragments never enter the offline cache', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    h.api.hasOlder = true;
    await h.openTask();
    await h.controller.loadOlder();
    expect(h.controller.timeline.first.body, 'Older page');
    expect(h.controller.nextCursor, isNull);
    h.live.eventController.add({
      'type': 'live.delta',
      'taskId': 'task-1',
      'delta': {
        'kind': 'text',
        'commentId': 'pending',
        'text': 'Secret fragment',
      },
    });
    expect(h.controller.liveText['pending'], 'Secret fragment');
    expect(h.storage.data.toString(), isNot(contains('Secret fragment')));
  });
  test('offline drafts survive navigation and never send automatically on reconnect', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();
    await h.controller.setDraft(
      const Draft(
        text: 'Offline draft',
        internal: true,
        files: [DraftFile('/tmp/local.txt', 'local.txt')],
      ),
    );
    h.api.offline = true;
    h.controller.connection = ConnectionState.offline;
    await h.controller.send();
    expect(h.api.sendCount, 0);
    expect(h.controller.draft.text, 'Offline draft');
    h.controller.backToTasks();
    await h.controller.selectTask(h.controller.tasks.first);
    expect(h.controller.draft.internal, true);
    h.api.offline = false;
    h.controller.connection = ConnectionState.connected;
    await h.controller.refresh();
    expect(h.api.sendCount, 0);
    expect(h.controller.draft.files.single.name, 'local.txt');
  });
  test('ambiguous sends retain the draft and require reconciliation and a manual send', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();
    await h.controller.setDraft(const Draft(text: 'Do not duplicate'));
    h.api.failSend = true;
    await h.controller.send();
    expect(h.api.sendCount, 1);
    expect(h.controller.draft.ambiguous, true);
    h.controller.connection = ConnectionState.connected;
    await h.controller.send();
    expect(h.api.sendCount, 1);
    h.api.failSend = false;
    await h.controller.reconcileSend();
    expect(h.api.sendCount, 1);
    await h.controller.send();
    expect(h.api.sendCount, 2);
    expect(h.controller.draft.text, '');
  });
  test('Internal Notes preserve their flag when manually posted', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();
    await h.controller.setDraft(
      const Draft(text: 'Humans only', internal: true),
    );
    await h.controller.send();
    expect(h.api.items.last['comment']['internal'], true);
    expect(h.controller.draft.text, '');
  });
  test('fetching data does not advance reads; only a visible, active conversation reaching content does', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();
    await h.controller.reachedLatest();
    expect(h.api.readCount, 0);
    h.controller.conversationVisible = true;
    h.controller.appVisible = false;
    await h.controller.reachedLatest();
    expect(h.api.readCount, 0);
    h.controller.appVisible = true;
    await h.controller.reachedLatest();
    expect(h.api.readCount, 1);
  });
  test('notification Task opening waits for authentication and resolves Project navigation', () async {
    final h = Harness();
    addTearDown(h.dispose);
    h.push.initial = 'task-1';
    await h.controller.initialize();
    expect(h.controller.task, isNull);
    await h.controller.login(
      'https://tasks.example.com',
      'ada@example.com',
      'password',
    );
    expect(h.controller.task!.id, 'task-1');
    expect(h.controller.project!.id, 'project-1');
    expect(h.controller.pendingTaskId, isNull);
  });
  test('private preference events update this device and logout clears cached conversations and drafts', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();
    h.live.eventController.add({
      'type': 'task.preference',
      'preference': preferenceData(muted: true),
    });
    expect(h.controller.preference!.muted, true);
    await h.controller.setDraft(const Draft(text: 'Private draft'));
    await h.controller.logout();
    expect(h.storage.data, isEmpty);
    expect(h.storage.login, isNull);
    expect(h.controller.user, isNull);
  });
  test('a stored agent Comment replaces its live text in the same update, never leaving a gap', () async {
    final h = Harness();
    await h.login();
    await h.openTask();
    h.live.eventController.add({
      'type': 'live.delta',
      'taskId': 'task-1',
      'delta': {'kind': 'text', 'commentId': 'agent-1', 'text': 'Done.'},
    });
    final seen = <(bool, bool)>[];
    h.controller.addListener(
      () => seen.add((
        h.controller.liveText.containsKey('agent-1'),
        h.controller.timeline.any((e) => e.id == 'agent-1'),
      )),
    );
    h.live.eventController.add({
      'type': 'comment.created',
      'comment': {
        ...commentData('agent-1', 'Done.', position: '3')['comment']
            as Map<String, dynamic>,
        'kind': 'agent',
        'author': {'id': 'agent-1', 'displayName': 'Ada Bot', 'type': 'agent'},
      },
    });
    // Every update shows the text somewhere: live, stored, or (never) both.
    expect(seen, isNotEmpty);
    expect(seen.every((s) => s.$1 != s.$2), isTrue);
    expect(h.controller.timeline.last.id, 'agent-1');
    h.controller.dispose();
  });
  test(
    'live updates edit entries in place and never pull in unloaded ones',
    () async {
      final h = Harness();
      await h.login();
      await h.openTask();
      final order = h.controller.timeline.map((e) => e.id).toList();
      h.live.eventController.add({
        'type': 'comment.updated',
        'comment': commentData('comment-1', 'Hello team, edited')['comment'],
      });
      expect(h.controller.timeline.map((e) => e.id).toList(), order);
      expect(h.controller.timeline.first.body, 'Hello team, edited');
      // An update for an entry that isn't loaded waits for the refresh.
      h.live.eventController.add({
        'type': 'comment.updated',
        'comment': commentData('not-loaded', 'Old')['comment'],
      });
      expect(h.controller.timeline.any((e) => e.id == 'not-loaded'), isFalse);
      h.controller.dispose();
    },
  );
  test('the Timeline reads oldest first even when the server has no read positions', () async {
    final h = Harness();
    // Newest first, as the API returns it, with the '0' a missing
    // task_activity row produces.
    h.api.items = [
      for (final (i, body) in ['First', 'Second', 'Third'].indexed)
        {...commentData('c$i', body, position: '$i'), 'readPosition': '0'},
    ];
    await h.login();
    await h.openTask();
    expect(h.controller.timeline.map((e) => e.body), [
      'First',
      'Second',
      'Third',
    ]);
    h.controller.dispose();
  });
}
