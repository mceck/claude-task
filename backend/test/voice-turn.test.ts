import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import { createProject, createTask, createUser } from './helpers/fixtures';
import { WsTestClient } from './helpers/ws';

const secret = 'voice-turn-integration-test-secret-0000000000000000';

describe('Voice Room TURN access', () => {
  const app = useTestApp({ config: { voiceStunUrls: [], voiceTurn: { host: 'relay.example.test', port: 3478, tlsPort: 443, secret, ttlSeconds: 600 } } });
  const sockets: WsTestClient[] = [];
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map(async (socket) => { socket.close(); await socket.closed; }));
  });
  async function connect(cookie: string | null) {
    const socket = await WsTestClient.connect(app.url, cookie); sockets.push(socket); return socket;
  }

  it('issues expiring User credentials compatible with coturn REST authentication', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    const socket = await connect(admin.cookie);
    const joined = socket.message((m) => m.type === 'voice.joined');
    socket.send({ type: 'voice.join', requestId: randomUUID(), taskId: task.id });
    const response = await joined;
    if (response.type !== 'voice.joined') throw new Error('Expected admission');
    expect(response.iceServers).toHaveLength(1);
    const turn = response.iceServers[0]!;
    expect(turn.urls).toEqual(['turn:relay.example.test:3478?transport=udp', 'turn:relay.example.test:3478?transport=tcp', 'turns:relay.example.test:443?transport=tcp']);
    expect(turn.username).toMatch(/^\d+:.*:.+$/);
    expect(turn.credential).toBe(createHmac('sha1', secret).update(turn.username!).digest('base64'));
    const expires = Number(turn.username!.split(':')[0]);
    expect(expires).toBeGreaterThan(Date.now() / 1000 + 590);
    expect(expires).toBeLessThanOrEqual(Date.now() / 1000 + 600);
    expect(Date.parse(response.iceExpiresAt!)).toBe(expires * 1000);
    expect(JSON.stringify(socket.messages)).not.toContain(secret);
  });
  it('refreshes only the current participation and isolates User credentials and relay signaling', async () => {
    const admin = await app.admin();
    const { client, user } = await createUser(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    const a = await connect(admin.cookie), b = await connect(client.cookie);
    const admit = async (socket: WsTestClient) => {
      const response = socket.message((m) => m.type === 'voice.joined');
      socket.send({ type: 'voice.join', requestId: randomUUID(), taskId: task.id });
      const value = await response;
      if (value.type !== 'voice.joined') throw new Error('Expected admission');
      return value;
    };
    const aa = await admit(a), bb = await admit(b);
    expect(bb.iceServers[0]!.username).toContain(`:${user.id}:`);
    expect(aa.iceServers[0]!.username).not.toBe(bb.iceServers[0]!.username);
    const refreshed = a.message((m) => m.type === 'voice.ice');
    a.send({ type: 'voice.ice', participantId: aa.participantId });
    const next = await refreshed;
    if (next.type !== 'voice.ice') throw new Error('Expected ICE configuration');
    expect(next.iceServers[0]!.username).not.toBe(aa.iceServers[0]!.username);
    expect(next.iceServers[0]!.credential).toBe(createHmac('sha1', secret).update(next.iceServers[0]!.username!).digest('base64'));
    const stale = b.message((m) => m.type === 'voice.error');
    b.send({ type: 'voice.ice', participantId: aa.participantId });
    expect(await stale).toMatchObject({ code: 'stale' });
    const relay = { type: 'candidate', exchangeId: randomUUID(), candidate: 'candidate:1 1 udp 1 203.0.113.5 49160 typ relay', sdpMid: '0', sdpMLineIndex: 0 };
    const forwarded = b.message((m) => m.type === 'voice.signal');
    a.send({ type: 'voice.signal', participantId: aa.participantId, targetId: bb.participantId, signal: relay });
    expect(await forwarded).toMatchObject({ fromId: aa.participantId, signal: relay });
    expect(JSON.stringify([...a.messages, ...b.messages])).not.toContain(secret);
  });

});
