import { projectTopic, taskTopic } from '@claude-task/shared';
import type { ProjectBundle } from '@claude-task/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from './helpers/client';
import { useTestApp } from './helpers/app';
import { createLabel, createProject, createTask, createUser, statusByName } from './helpers/fixtures';
import { WsTestClient } from './helpers/ws';

/** Long enough for a stray event to arrive over loopback. */
const QUIET_MS = 150;
const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));

describe('realtime', () => {
  const app = useTestApp();
  let admin: ApiClient;
  let viewer: ApiClient;
  let bundle: ProjectBundle;
  let ws: WsTestClient;

  beforeEach(async () => {
    admin = await app.admin();
    viewer = (await createUser(app, admin)).client;
    bundle = await createProject(admin, { key: 'LIVE' });
    ws = await WsTestClient.connect(app.url, viewer.cookie);
  });

  afterEach(() => ws.close());

  describe('connecting', () => {
    it('refuses connections without a session', async () => {
      await expect(WsTestClient.connect(app.url, null)).rejects.toThrow(/401/);
    });

    it('refuses connections from another origin', async () => {
      await expect(WsTestClient.connect(app.url, viewer.cookie, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
      const same = await WsTestClient.connect(app.url, viewer.cookie, { origin: app.url });
      same.close();
    });
  });

  describe('board topic', () => {
    beforeEach(() => ws.subscribe(projectTopic(bundle.project.id)));

    it('delivers task.created once committed, with the card projection', async () => {
      const task = await createTask(admin, bundle.project.id, { title: 'Live one' });
      const { event } = await ws.next('task.created');
      expect(event.task).toMatchObject({ id: task.id, key: 'LIVE-1', title: 'Live one', commentCount: 0 });
      // When the event arrives, the change is already readable.
      expect((await viewer.get(`/tasks/${event.task.id}`)).status).toBe(200);
    });

    it('delivers moves and updates of cards', async () => {
      const task = await createTask(admin, bundle.project.id);
      const done = statusByName(bundle, 'Done');
      await admin.post(`/tasks/${task.id}/move`, { statusId: done.id });
      expect((await ws.next('task.moved')).event.task).toMatchObject({ id: task.id, statusId: done.id });

      await admin.patch(`/tasks/${task.id}`, { version: 2, priority: 'urgent' });
      expect((await ws.next('task.updated', (e) => e.task.priority === 'urgent')).event.task.id).toBe(task.id);
    });

    it('updates the card’s comment count when comments come and go', async () => {
      const task = await createTask(admin, bundle.project.id);
      const c = (await admin.post(`/tasks/${task.id}/comments`, { body: 'hi' })).body.comment;
      await ws.next('task.updated', (e) => e.task.id === task.id && e.task.commentCount === 1);
      await admin.delete(`/comments/${c.id}`);
      await ws.next('task.updated', (e) => e.task.id === task.id && e.task.commentCount === 0);
    });

    it('delivers task deletion', async () => {
      const task = await createTask(admin, bundle.project.id);
      await admin.delete(`/tasks/${task.id}`);
      expect((await ws.next('task.deleted')).event).toEqual({ type: 'task.deleted', projectId: bundle.project.id, taskId: task.id });
    });

    it('delivers status and label list changes', async () => {
      await admin.post(`/projects/${bundle.project.id}/statuses`, { name: 'QA', color: '#123456', category: 'review' });
      const { event } = await ws.next('statuses.changed');
      expect(event.statuses.map((s) => s.name)).toContain('QA');

      await createLabel(admin, bundle.project.id, 'bug');
      expect((await ws.next('labels.changed')).event.labels.map((l) => l.name)).toEqual(['bug']);
    });

    it('delivers project edits', async () => {
      await admin.patch(`/projects/${bundle.project.id}`, { name: 'Renamed' });
      expect((await ws.next('project.updated')).event.project.name).toBe('Renamed');
    });

    it('sends nothing for a rolled-back change', async () => {
      // The number is taken, then the bad assignee fails the transaction.
      const failed = await admin.post(`/projects/${bundle.project.id}/tasks`, {
        title: 'never',
        assigneeIds: ['00000000-0000-4000-8000-000000000000'],
      });
      expect(failed.status).toBe(400);

      const task = await createTask(admin, bundle.project.id, { title: 'real' });
      await admin.patch(`/tasks/${task.id}`, { version: 1, title: 'first edit' });
      // A stale patch is a 409 and must not leak an update either.
      expect((await admin.patch(`/tasks/${task.id}`, { version: 1, title: 'stale edit' })).status).toBe(409);
      await quiet();

      expect(ws.events('task.created').map((e) => e.task.title)).toEqual(['real']);
      expect(ws.events('task.updated').map((e) => e.task.title)).toEqual(['first edit']);
    });

    it('sends nothing for other projects', async () => {
      const other = await createProject(admin);
      await createTask(admin, other.project.id);
      await quiet();
      expect(ws.received).toEqual([]);
    });

    it('stops after unsubscribing', async () => {
      ws.unsubscribe(projectTopic(bundle.project.id));
      await ws.subscribe(projectTopic('00000000-0000-4000-8000-000000000000')); // round-trip after the unsubscribe
      await createTask(admin, bundle.project.id);
      await quiet();
      expect(ws.received).toEqual([]);
    });
  });

  describe('task topic', () => {
    it('delivers comments, edits, deletions and revisions for the task', async () => {
      const task = await createTask(admin, bundle.project.id, { title: 'Watched' });
      await ws.subscribe(taskTopic(task.id));

      const c = (await admin.post(`/tasks/${task.id}/comments`, { body: 'hello', internal: true })).body.comment;
      expect((await ws.next('comment.created')).event.comment).toMatchObject({ id: c.id, body: 'hello', internal: true });

      await admin.patch(`/comments/${c.id}`, { body: 'hello again' });
      expect((await ws.next('comment.updated')).event.comment.body).toBe('hello again');

      await admin.delete(`/comments/${c.id}`);
      expect((await ws.next('comment.deleted')).event.comment).toMatchObject({ id: c.id, body: '' });

      await admin.patch(`/tasks/${task.id}`, { version: 1, description: 'details' });
      const { event } = await ws.next('revision.created');
      expect(event.revision).toMatchObject({ taskId: task.id, version: 2, changes: [{ field: 'description', before: '', after: 'details' }] });
      expect((await ws.next('task.changed')).event.task.description).toBe('details');
    });

    it('delivers task removal', async () => {
      const task = await createTask(admin, bundle.project.id);
      await ws.subscribe(taskTopic(task.id));
      await admin.delete(`/tasks/${task.id}`);
      expect((await ws.next('task.removed')).event.taskId).toBe(task.id);
    });

    it('sends nothing about other tasks', async () => {
      const watched = await createTask(admin, bundle.project.id);
      const other = await createTask(admin, bundle.project.id);
      await ws.subscribe(taskTopic(watched.id));
      await admin.post(`/tasks/${other.id}/comments`, { body: 'elsewhere' });
      await quiet();
      expect(ws.received).toEqual([]);
    });
  });

  it('delivers to every subscriber', async () => {
    const second = await WsTestClient.connect(app.url, admin.cookie);
    await Promise.all([ws.subscribe(projectTopic(bundle.project.id)), second.subscribe(projectTopic(bundle.project.id))]);
    await createTask(admin, bundle.project.id);
    await Promise.all([ws.next('task.created'), second.next('task.created')]);
    second.close();
  });
});
