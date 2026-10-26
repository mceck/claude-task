import { randomUUID } from 'node:crypto';
import { userTopic } from '@claude-task/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PushTransportError } from '../src/notifications/transport';
import type { PushMessage, PushTransport } from '../src/notifications/transport';
import { useTestApp } from './helpers/app';
import { assignAgent, comment, createAgent, createProject, createTask, createUser } from './helpers/fixtures';
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
    expect(initial).toMatchObject({ unread: true, readPosition: '0', following: false });
    await member.client.get(`/tasks/${task.id}/timeline`);
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.readPosition).toBe('0');
    const read = await member.client.put(`/tasks/${task.id}/read-position`, { itemId: last.id });
    expect(read.body.preference.unread).toBe(false);
    const older = await member.client.put(`/tasks/${task.id}/read-position`, { itemId: first.id });
    expect(older.body.preference.readPosition).toBe(read.body.preference.readPosition);
    expect(older.body.preference.following).toBe(false);
    const other = await createTask(admin, project.id);
    const foreign = await comment(admin, other.id, 'Other Task');
    expect((await member.client.put(`/tasks/${task.id}/read-position`, { itemId: foreign.id })).status).toBe(400);
    await comment(member.client, task.id, 'Now participating');
    expect((await member.client.get(`/tasks/${task.id}/preferences`)).body.preference.following).toBe(true);
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
    await assignAgent(admin, task.id, agent.id);
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
    await assignAgent(admin, task.id, agent.id);
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
    await assignAgent(admin, task.id, agent.id);
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
