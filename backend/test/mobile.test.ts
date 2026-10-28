import { randomUUID } from 'node:crypto';
import { userTopic } from '@claude-task/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PushTransportError } from '../src/notifications/transport';
import type { PushMessage, PushTransport } from '../src/notifications/transport';
import { useTestApp } from './helpers/app';
import { assignAgent, assignAndStart, comment, createAgent, createProject, createTask, createUser } from './helpers/fixtures';
import { Stream } from './helpers/stream';
import { WsTestClient } from './helpers/ws';

class RecordingPush implements PushTransport {
  configured = true;
  messages: PushMessage[] = [];
  outcome: 'sent' | 'invalid' | 'fail' = 'sent';
  async send(message: PushMessage): Promise<'sent' | 'invalid'> {
    if (this.outcome === 'fail') throw new PushTransportError(true);
    this.messages.push(message);
    return this.outcome;
  }
}
const push = new RecordingPush();
const app = useTestApp({ push });

async function setup() {
  app.server.ctx.pushDispatcher.stop();
  await app.server.ctx.pushDispatcher.settle();
  push.messages = []; push.outcome = 'sent';
  const admin = await app.admin();
  const { project } = await createProject(admin);
  const task = await createTask(admin, project.id);
  const member = await createUser(app, admin);
  return { admin, project, task, member };
}
async function register(client: Awaited<ReturnType<typeof app.admin>>, token: string = randomUUID(), deviceId: string = randomUUID()) {
  const res = await client.put('/notifications/devices', { deviceId, platform: 'ios', token });
  expect(res.status).toBe(204);
  return deviceId;
}

describe('Project activity', () => {
  const unread = async (client: Awaited<ReturnType<typeof app.admin>>, key: string) =>
    (await client.get('/projects')).body.projects.find((p: { id: string }) => p.id === key).activity;

  it('counts unread open Tasks per User, skipping muted and closed ones', async () => {
    const { admin, project, task, member } = await setup();
    const last = await comment(admin, task.id, 'Hello');
    expect(await unread(member.client, project.id)).toEqual({ runningAgents: 0, unreadTasks: 1 });
    await member.client.put(`/tasks/${task.id}/read-position`, { itemId: last.id });
    expect((await unread(member.client, project.id)).unreadTasks).toBe(0);
    expect((await unread(admin, project.id)).unreadTasks).toBe(1);

    await comment(admin, task.id, 'Again');
    expect((await unread(member.client, project.id)).unreadTasks).toBe(1);
    await member.client.patch(`/tasks/${task.id}/preferences`, { muted: true });
    expect((await unread(member.client, project.id)).unreadTasks).toBe(0);
  });
});

describe('Task preferences and read positions', () => {
  it('auto-follows creators, User assignees and participants including Internal Notes; explicit choices win', async () => {
    const { admin, task, member } = await setup();
    expect((await admin.get(`/tasks/${task.id}/preferences`)).body.preference.following).toBe(true);
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.following).toBe(false);
    await admin.patch(`/tasks/${task.id}`, { version: task.version, assigneeIds: [member.user.id] });
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.following).toBe(true);
    await member.client.patch(`/tasks/${task.id}/preferences`, { following: false, muted: true });
    await comment(member.client, task.id, 'Internal discussion', true);
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference).toMatchObject({ following: false, muted: true });
    const other = await createUser(app, admin);
    await comment(other.client, task.id, 'Participating', true);
    expect((await other.client.get(`/tasks/${task.id}/preferences`)).body.preference.following).toBe(true);
  });
  it('advances only for persisted Task entries, monotonically, without following on reads', async () => {
    const { admin, project, task, member } = await setup();
    const first = await comment(admin, task.id, 'First');
    const last = await comment(admin, task.id, 'Last');
    const initial = (await member.client.get(`/projects/${project.id}/task-preferences`)).body.preferences[0];
    expect(initial).toMatchObject({ unread: true, readPosition: '0', following: false, unreadComments: 2 });
    await member.client.get(`/tasks/${task.id}/timeline`);
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.readPosition).toBe('0');
    const read = await member.client.put(`/tasks/${task.id}/read-position`, { itemId: last.id });
    expect(read.body.preference).toMatchObject({ unread: false, unreadComments: 0 });
    const older = await member.client.put(`/tasks/${task.id}/read-position`, { itemId: first.id });
    expect(older.body.preference.readPosition).toBe(read.body.preference.readPosition);
    expect(older.body.preference.following).toBe(false);
    const other = await createTask(admin, project.id);
    const foreign = await comment(admin, other.id, 'Other Task');
    expect((await member.client.put(`/tasks/${task.id}/read-position`, { itemId: foreign.id })).status).toBe(400);
    await comment(member.client, task.id, 'Now participating');
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.following).toBe(true);
  });
  it('counts unread Comments for the badge, leaving deleted Comments out', async () => {
    const { admin, project, task, member } = await setup();
    const pref = async () => (await member.client.get(`/tasks/${task.id}/preferences`)).body.preference;
    await comment(admin, task.id, 'First');
    const second = await comment(admin, task.id, 'Second');
    expect(await pref()).toMatchObject({ unread: true, unreadComments: 2 });
    await member.client.put(`/tasks/${task.id}/read-position`, { itemId: second.id });
    expect(await pref()).toMatchObject({ unread: false, unreadComments: 0 });

    const third = await comment(admin, task.id, 'Third');
    expect(await pref()).toMatchObject({ unread: true, unreadComments: 1 });
    await admin.delete(`/comments/${third.id}`);
    expect(await pref()).toMatchObject({ unread: true, unreadComments: 0 });

    // The member's own Comment counts too, and internal notes are still Comments.
    await comment(member.client, task.id, 'Internal note', true);
    expect(await pref()).toMatchObject({ unread: true, unreadComments: 1 });
    const [row] = (await member.client.get(`/projects/${project.id}/task-preferences`)).body.preferences;
    expect(row.unreadComments).toBe(1);
    await member.client.patch(`/tasks/${task.id}/preferences`, { following: false, muted: true });
    expect(await pref()).toMatchObject({ unread: true, unreadComments: 1, following: false, muted: true });
    // Reading on another User's Login leaves this User's count unchanged.
    expect((await admin.get(`/tasks/${task.id}/preferences`)).body.preference.unreadComments).toBe(3);
  });
  it('counts Agent and System Comments while Revisions and Agent Items only affect unread state', async () => {
    const { admin, task, member } = await setup();
    const { agent, runner } = await createAgent(app, admin);
    await assignAndStart(admin, task.id, agent.id);
    const stream = new Stream();
    await runner.runJob([stream.init(), stream.thinking('Checking'), stream.text('Ready'), stream.result()]);
    await app.settle();
    const current = (await admin.get(`/tasks/${task.id}`)).body.task;
    await admin.patch(`/tasks/${task.id}`, { version: current.version, title: 'Updated title' });
    expect((await admin.post(`/tasks/${task.id}/session/notify`)).status).toBe(200);

    const items = (await member.client.get(`/tasks/${task.id}/timeline`)).body.items;
    const comments = items.filter((i: { type: string }) => i.type === 'comment');
    expect(comments.map((i: { comment: { kind: string } }) => i.comment.kind).sort()).toEqual(['agent', 'system', 'user']);
    expect(items.length).toBeGreaterThan(comments.length);
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.unreadComments).toBe(3);
    const notice = comments.find((i: { comment: { kind: string } }) => i.comment.kind === 'system');
    await member.client.put(`/tasks/${task.id}/read-position`, { itemId: notice.id });
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.unreadComments).toBe(0);
  });
  it('keeps preferences private across authenticated WebSocket instances', async () => {
    const { admin, task, member } = await setup();
    const me = (await admin.get('/auth/me')).body.user;
    const own = await WsTestClient.connect(app.url, admin.cookie);
    const other = await WsTestClient.connect(app.url, member.client.cookie);
    try {
      await own.subscribe(userTopic(me.id));
      await other.subscribe(userTopic(me.id), userTopic(member.user.id));
      const changed = await admin.patch(`/tasks/${task.id}/preferences`, { muted: true });
      expect(changed.status).toBe(200);
      expect((await own.next('task.preference')).event.preference.muted).toBe(true);
      // A following subscribe acknowledgement acts as a socket-order barrier.
      await other.subscribe(userTopic(member.user.id));
      expect(other.events('task.preference')).toHaveLength(0);
      expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.muted).toBe(false);
    } finally { own.close(); other.close(); }
  });
  it('requires authentication, CSRF and valid request bodies', async () => {
    const { admin, task } = await setup();
    expect((await app.client().get(`/tasks/${task.id}/preferences`)).status).toBe(401);
    expect((await admin.patch(`/tasks/${task.id}/preferences`, { muted: true }, { csrf: false })).status).toBe(403);
    expect((await admin.patch(`/tasks/${task.id}/preferences`, {})).status).toBe(400);
    expect((await admin.put('/notifications/devices', { deviceId: 'bad', platform: 'linux', token: 'bad' })).status).toBe(400);
  });
});

describe('durable phone notifications', () => {
  it('alerts once per completed Turn and device, never for fragments or prose asking for help', async () => {
    const { admin, task, member } = await setup();
    await register(admin);
    await register(member.client);
    const { agent, runner } = await createAgent(app, admin);
    await assignAndStart(admin, task.id, agent.id);
    const stream = new Stream();
    await runner.runJob([stream.init(), stream.delta('Please help'), stream.text('Please help'), stream.text('Done'), stream.result()]);
    await app.settle();
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]).toMatchObject({ taskId: task.id, kind: 'turn.completed' });
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toHaveLength(1);
  });
  it('rechecks mute/unfollow/deactivation and expired Logins before dispatch', async () => {
    const { admin, task, member } = await setup();
    await register(admin);
    await comment(member.client, task.id, 'Following');
    await register(member.client);
    const { agent, runner } = await createAgent(app, admin);
    await assignAndStart(admin, task.id, agent.id);
    const stream = new Stream();
    // Stop the timer to control the dispatch boundary precisely.
    app.server.ctx.pushDispatcher.stop();
    await runner.runJob([stream.init(), stream.result({ isError: true, subtype: 'error_during_execution' })]);
    await app.settle();
    await admin.patch(`/tasks/${task.id}/preferences`, { muted: true });
    await admin.patch(`/users/${member.user.id}`, { active: false });
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toHaveLength(0);
  });
  it('removes devices on logout, binds ownership, and replaces tokens without leaking them', async () => {
    const { admin, member } = await setup();
    const deviceId = await register(admin, 'first-private-token');
    expect((await member.client.put('/notifications/devices', { deviceId, platform: 'android', token: 'stolen-device-token' })).status).toBe(403);
    await register(admin, 'rotated-private-token', deviceId);
    const stored = await app.server.ctx.db.execute(sql`select * from push_devices`);
    expect(JSON.stringify(stored.rows)).not.toContain('private-token');
    await admin.post('/auth/logout');
    expect((await app.server.ctx.db.execute(sql`select * from push_devices`)).rows).toHaveLength(0);
  });
  it('lets another User take over a registration left by an expired Login', async () => {
    const { admin, member } = await setup();
    const deviceId = await register(admin, 'shared-phone-token');
    await app.server.ctx.db.execute(sql`update logins set expires_at = now() - interval '1 minute' where id in (select login_id from push_devices)`);
    expect((await member.client.put('/notifications/devices', { deviceId: randomUUID(), platform: 'android', token: 'shared-phone-token' })).status).toBe(204);
    const owners = await app.server.ctx.db.execute<{ user_id: string }>(sql`select user_id from push_devices`);
    expect(owners.rows.map((r) => r.user_id)).toEqual([member.user.id]);
  });
  it('discards invalid tokens and durably retries transport failures', async () => {
    const { admin, task } = await setup();
    await register(admin);
    app.server.ctx.pushDispatcher.stop();
    const { agent, runner } = await createAgent(app, admin);
    await assignAndStart(admin, task.id, agent.id);
    const stream = new Stream();
    await runner.runJob([stream.init(), stream.result()]);
    await app.settle();
    push.outcome = 'fail';
    await app.server.ctx.pushDispatcher.dispatch();
    expect((await app.server.ctx.db.execute<{ attempts: number }>(sql`select attempts from push_deliveries`)).rows[0]?.attempts).toBe(1);
    await app.server.ctx.db.execute(sql`update push_deliveries set next_attempt_at = now()`);
    push.outcome = 'invalid';
    await app.server.ctx.pushDispatcher.dispatch();
    expect((await app.server.ctx.db.execute(sql`select * from push_devices`)).rows).toHaveLength(0);
  });
});

describe('User mentions', () => {
  it('alerts the mentioned User once per device, including Internal Notes and explicit unfollow', async () => {
    const { admin, task, member } = await setup();
    await register(admin, 'author-phone-token-123456');
    await register(member.client, 'mentioned-phone-token-123456');
    await register(member.client, 'second-mentioned-phone');
    const other = await createUser(app, admin);
    await register(other.client, 'unmentioned-phone-token-123456');
    await member.client.patch(`/tasks/${task.id}/preferences`, { following: false });
    const me = (await admin.get('/auth/me')).body.user;
    const mention = `[@${member.user.displayName}](/users/${member.user.id})`;
    const body = `${mention} please review ${mention} [@Me](/users/${me.id})`;
    const posted = await comment(admin, task.id, body, true);
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages.map(m => m.token).sort()).toEqual(['mentioned-phone-token-123456', 'second-mentioned-phone']);
    expect(push.messages.every(m => m.kind === 'comment.mentioned' && m.taskId === task.id && m.eventId === `mention:${posted.id}`)).toBe(true);
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toHaveLength(2);
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.following).toBe(false);
    await admin.patch(`/comments/${posted.id}`, { body: `${body} edited [@Other](/users/${other.user.id})` });
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toHaveLength(2);
  });

  it('keeps ordinary @ text, emails, code, escaped links and images inert', async () => {
    const { admin, task, member } = await setup();
    await register(member.client);
    const link = `[@${member.user.displayName}](/users/${member.user.id})`;
    await comment(admin, task.id, `@${member.user.displayName} ${member.user.email}\n\n\`${link}\`\n\n\`\`\`md\n${link}\n\`\`\`\n\n!${link}\n\n\\${link}`);
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toEqual([]);
  });

  it('respects mute, deactivation and deletion both at send and before dispatch', async () => {
    const { admin, task, member } = await setup();
    await register(member.client);
    const body = `[@User](/users/${member.user.id})`;
    await member.client.patch(`/tasks/${task.id}/preferences`, { muted: true });
    await comment(admin, task.id, body);
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toEqual([]);
    await member.client.patch(`/tasks/${task.id}/preferences`, { muted: false });
    await comment(admin, task.id, body);
    await member.client.patch(`/tasks/${task.id}/preferences`, { muted: true });
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toEqual([]);
    await member.client.patch(`/tasks/${task.id}/preferences`, { muted: false });
    const removed = await comment(admin, task.id, body);
    await admin.delete(`/comments/${removed.id}`);
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toEqual([]);
    await comment(admin, task.id, body);
    await admin.patch(`/users/${member.user.id}`, { active: false });
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toEqual([]);
    await comment(admin, task.id, `${body} [@Missing](/users/${randomUUID()})`);
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toEqual([]);
  });

  it('alerts for multipart Comments and ignores Agent output', async () => {
    const { admin, task, member } = await setup();
    await register(member.client);
    const body = `[@User](/users/${member.user.id})`;
    const { agent, runner } = await createAgent(app, admin);
    await assignAndStart(admin, task.id, agent.id);
    const stream = new Stream();
    await runner.runJob([stream.init(), stream.text(body), stream.result()]);
    await app.settle();
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toEqual([]);
    const form = new FormData();
    form.set('body', body);
    form.set('internal', 'true');
    form.append('files', new Blob(['review']), 'review.txt');
    const response = await fetch(`${app.url}/api/v1/tasks/${task.id}/comments`, { method: 'POST', headers: { cookie: admin.cookie!, 'x-claude-task': '1' }, body: form });
    expect(response.status).toBe(201);
    await app.server.ctx.pushDispatcher.dispatch();
    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]!.kind).toBe('comment.mentioned');
  });
});
