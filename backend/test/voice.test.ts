import { afterEach, expect, it, describe } from 'vitest';
import { useTestApp } from './helpers/app';
import { createProject, createTask, createUser } from './helpers/fixtures';
import { WsTestClient } from './helpers/ws';
import type { VoiceServerMessage } from '@claude-task/shared';
import { randomUUID } from 'node:crypto';

describe('Task Voice Rooms', () => {
  const app = useTestApp({ config: { voiceStunUrls: [] } });
  const sockets: WsTestClient[] = [];
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map(async (socket) => { socket.close(); await socket.closed; }));
  });

  async function connect(cookie: string | null) {
    const socket = await WsTestClient.connect(app.url, cookie);
    sockets.push(socket);
    return socket;
  }
  async function join(socket: WsTestClient, taskId: string, replace?: string) {
    const requestId = randomUUID();
    const response = socket.message((m) => (m.type === 'voice.joined' || m.type === 'voice.error') && m.requestId === requestId);
    socket.send({ type: 'voice.join', taskId, requestId, ...(replace ? { replace } : {}) });
    return await response as Extract<VoiceServerMessage, { type: 'voice.joined' | 'voice.error' }>;
  }
  async function admitted(socket: WsTestClient, taskId: string, replace?: string) {
    const response = await join(socket, taskId, replace);
    if (response.type !== 'voice.joined') throw new Error(response.message);
    return response;
  }

  it('shows an empty room and broadcasts joined Users to Task observers', async () => {
    const admin = await app.admin();
    const { user, client } = await createUser(app, admin, { displayName: 'Bea' });
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    const initial = await client.get(`/tasks/${task.id}/voice`);
    expect(initial.status).toBe(200);
    expect(initial.body.room).toEqual({ taskId: task.id, taskKey: task.key, participants: [] });
    const observer = await WsTestClient.connect(app.url, admin.cookie);
    const speaker = await WsTestClient.connect(app.url, client.cookie);
    sockets.push(observer, speaker);
    await observer.subscribe(`task:${task.id}`);
    const joined = speaker.message((m) => m.type === ('voice.joined' as string));
    speaker.send({ type: 'voice.join', requestId: 'join-1', taskId: task.id });
    expect(await joined).toMatchObject({
      type: 'voice.joined', requestId: 'join-1', iceServers: [],
      room: { taskId: task.id, participants: [{ user: { id: user.id, displayName: 'Bea' }, muted: false }] },
    });
    const presence = await observer.next('voice.room');
    expect(presence.event).toMatchObject({ room: { participants: [{ user: { id: user.id } }] } });
    expect((await client.get(`/tasks/${task.id}/voice`)).body.room.participants).toHaveLength(1);
  });

  it('requires an exact transfer confirmation and rejects stale commands from the old device', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const a = await createTask(admin, project.id), b = await createTask(admin, project.id);
    const old = await connect(admin.cookie), next = await connect(admin.cookie);
    const original = await admitted(old, a.id);
    expect(await join(next, b.id)).toMatchObject({ type: 'voice.error', code: 'already_joined', current: { participantId: original.participantId } });
    const left = old.message((m) => m.type === 'voice.left');
    const transferred = await admitted(next, b.id, original.participantId);
    expect(await left).toMatchObject({ reason: 'transferred' });
    expect((await admin.get(`/tasks/${a.id}/voice`)).body.room.participants).toEqual([]);
    expect(await join(old, a.id, original.participantId)).toMatchObject({ code: 'already_joined', current: { participantId: transferred.participantId } });
    const stale = old.message((m) => m.type === 'voice.error');
    old.send({ type: 'voice.leave', participantId: original.participantId });
    expect(await stale).toMatchObject({ code: 'stale' });
    expect((await admin.get(`/tasks/${b.id}/voice`)).body.room.participants).toHaveLength(1);
  });

  it('admits six Users and preserves the old room when transfer targets a full room', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const full = await createTask(admin, project.id), other = await createTask(admin, project.id);
    for (let i = 0; i < 6; i++) {
      const { client } = await createUser(app, admin);
      await admitted(await connect(client.cookie), full.id);
    }
    const speaker = await connect(admin.cookie);
    const original = await admitted(speaker, other.id);
    expect(await join(speaker, full.id, original.participantId)).toMatchObject({ code: 'full' });
    expect((await admin.get(`/tasks/${full.id}/voice`)).body.room.participants).toHaveLength(6);
    expect((await admin.get(`/tasks/${other.id}/voice`)).body.room.participants[0].id).toBe(original.participantId);
  });

  it('forwards signals privately within a room and rejects forged identity, malformed and relay candidates', async () => {
    const admin = await app.admin();
    const { client } = await createUser(app, admin);
    const outsider = (await createUser(app, admin)).client;
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id), other = await createTask(admin, project.id);
    const a = await connect(admin.cookie), b = await connect(client.cookie), c = await connect(outsider.cookie);
    const aa = await admitted(a, task.id), bb = await admitted(b, task.id), cc = await admitted(c, other.id);
    const signal = { type: 'offer', exchangeId: randomUUID(), sdp: 'v=0\r\n' };
    const received = b.message((m) => m.type === 'voice.signal');
    a.send({ type: 'voice.signal', participantId: aa.participantId, targetId: bb.participantId, signal });
    expect(await received).toMatchObject({ fromId: aa.participantId, toId: bb.participantId, signal });
    for (const command of [
      { type: 'voice.signal', participantId: aa.participantId, targetId: cc.participantId, signal },
      { type: 'voice.signal', participantId: bb.participantId, targetId: cc.participantId, signal },
      { type: 'voice.signal', participantId: aa.participantId, targetId: bb.participantId, signal: { ...signal, sdp: 'x'.repeat(17 * 1024) } },
      { type: 'voice.signal', participantId: aa.participantId, targetId: bb.participantId, signal: { type: 'candidate', exchangeId: randomUUID(), candidate: 'candidate:1 1 udp 1 1.2.3.4 1234 typ relay', sdpMid: null, sdpMLineIndex: 0 } },
    ]) {
      const error = a.message((m) => m.type === 'voice.error');
      a.send(command);
      expect(await error).toMatchObject({ type: 'voice.error' });
    }
    expect(c.messages.filter((m) => m.type === 'voice.signal')).toEqual([]);
    expect(b.messages.filter((m) => m.type === 'voice.signal')).toHaveLength(1);
  });

  it('publishes mute and leave state and ends voice when the Task is deleted', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    const socket = await connect(admin.cookie);
    let membership = await admitted(socket, task.id);
    const muted = socket.message((m) => m.type === 'voice.room' && m.room.participants[0]?.muted === true);
    socket.send({ type: 'voice.mute', participantId: membership.participantId, muted: true });
    await muted;
    expect((await admin.get(`/tasks/${task.id}/voice`)).body.room.participants[0].muted).toBe(true);
    const left = socket.message((m) => m.type === 'voice.left');
    socket.send({ type: 'voice.leave', participantId: membership.participantId });
    await left;
    expect((await admin.get(`/tasks/${task.id}/voice`)).body.room.participants).toEqual([]);
    membership = await admitted(socket, task.id);
    const deleted = socket.message((m) => m.type === 'voice.left');
    expect((await admin.delete(`/tasks/${task.id}`)).status).toBe(204);
    expect(await deleted).toMatchObject({ participantId: membership.participantId, reason: 'task_deleted' });
    expect(await join(socket, task.id)).toMatchObject({ code: 'not_found' });
  });

  it('releases participation immediately on logout and socket close', async () => {
    const admin = await app.admin();
    const { client } = await createUser(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    const socket = await connect(client.cookie);
    await admitted(socket, task.id);
    await client.post('/auth/logout');
    await socket.closed;
    expect((await admin.get(`/tasks/${task.id}/voice`)).body.room.participants).toEqual([]);
    const a = await connect(admin.cookie);
    await admitted(a, task.id);
    a.close(); await a.closed;
    expect((await admin.get(`/tasks/${task.id}/voice`)).body.room.participants).toEqual([]);
  });

  it('bounds command volume, rejects invalid joins and keeps the live connection usable', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    const socket = await connect(admin.cookie);
    const invalid = socket.message((m) => m.type === 'voice.error');
    socket.send({ type: 'voice.join', requestId: 'invalid', taskId: 'not-an-id' });
    expect(await invalid).toMatchObject({ code: 'invalid' });
    const membership = await admitted(socket, task.id);
    const limited = socket.message((m) => m.type === 'voice.error' && m.code === 'rate_limited');
    for (let i = 0; i < 125; i++) socket.send({ type: 'voice.mute', participantId: membership.participantId, muted: false });
    await limited;
    await socket.subscribe(`task:${task.id}`);
  });

  it('bounds repeated leave commands during admission and releases an overloaded leaver', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    const socket = await connect(admin.cookie);
    socket.send({ type: 'voice.join', requestId: 'pending', taskId: task.id });
    for (let i = 0; i < 130; i++) socket.send({ type: 'voice.leave', participantId: randomUUID() });
    expect((await socket.closed).code).toBe(1008);
    expect((await admin.get(`/tasks/${task.id}/voice`)).body.room.participants).toEqual([]);
  });
});
