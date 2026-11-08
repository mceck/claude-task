import { describe, expect, it } from 'vitest';
import { createUser } from './helpers/fixtures';
import { createHash } from 'node:crypto';
import { useTestApp } from './helpers/app';

describe('Hosts', () => {
  const app = useTestApp();
  it('lists the connected Local Host and its Workers for every User', async () => {
    const admin = await app.admin();
    const response = await admin.get('/hosts');
    expect(response.status).toBe(200);
    expect(response.body.hosts).toEqual([expect.objectContaining({ name: 'Local', kind: 'local', state: 'connected', workers: [{ id: app.workerId, name: 'Test worker' }], error: null })]);
    const host = response.body.hosts[0];
    expect((await admin.get(`/hosts/${host.id}`)).body.host).toEqual(host);
    expect((await admin.get(`/workers/${app.workerId}`)).body.worker.host).toEqual({ id: host.id, name: 'Local', state: 'connected' });
  });
  it('creates a Remote Host, reveals its token once, edits it, rotates and deletes it', async () => {
    const admin = await app.admin();
    const created = await admin.post('/hosts', { name: '  ARM box  ', description: 'Build machine', backendUrlOverride: 'https://backend.example/path///', network: 'agents-1' });
    expect(created.status).toBe(201);
    const { host, token, commands } = created.body;
    expect(host).toMatchObject({ name: 'ARM box', state: 'disconnected', backendUrlOverride: 'https://backend.example/path', network: 'agents-1' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(commands).toHaveLength(3);
    expect(commands[1]).toContain(token);
    expect(commands[1]).not.toContain('ALLOW_INSECURE');
    const stored = (await app.server.ctx.db.$client.query('SELECT token_hash FROM hosts WHERE id = $1', [host.id])).rows[0];
    expect(stored.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify((await admin.get('/hosts')).body)).not.toContain(token);
    expect((await admin.patch(`/hosts/${host.id}`, { network: 'vpn' })).body.host.network).toBe('vpn');
    const regenerated = await admin.post(`/hosts/${host.id}/token`);
    expect(regenerated.body.token).not.toBe(token);
    expect((await admin.delete(`/hosts/${host.id}`)).status).toBe(204);
    expect((await admin.get(`/hosts/${host.id}`)).status).toBe(404);
  });

  it.each([
    { name: '' }, { name: 'x'.repeat(101) }, { name: 'Box', description: 'x'.repeat(2001) },
    { name: 'Box', backendUrlOverride: '/relative' }, { name: 'Box', backendUrlOverride: 'ftp://example.com' },
    { name: 'Box', backendUrlOverride: 'https://example.com?a=1' }, { name: 'Box', backendUrlOverride: 'https://example.com#fragment' },
    { name: 'Box', backendUrlOverride: 'http://example.com' }, { name: 'Box', network: '-oops' }, { name: 'Box', network: 'a b' }, { name: 'Box', network: 'x'.repeat(129) },
  ])('rejects invalid Host fields: %j', async (body) => {
    expect((await (await app.admin()).post('/hosts', body)).status).toBe(400);
  });
  it('protects Local, enforces unique names and validates insecure edits against stored fields', async () => {
    const admin = await app.admin();
    const local = (await admin.get('/hosts')).body.hosts[0];
    expect((await admin.post('/hosts', { name: 'local' })).status).toBe(409);
    expect((await admin.patch(`/hosts/${local.id}`, { name: 'Renamed' })).status).toBe(409);
    expect((await admin.post(`/hosts/${local.id}/token`)).status).toBe(409);
    expect((await admin.delete(`/hosts/${local.id}`)).status).toBe(409);
    const created = await admin.post('/hosts', { name: 'Box', allowInsecure: true, backendUrlOverride: 'http://box/' });
    expect(created.status).toBe(201);
    expect(created.body.commands[1]).toContain('CLAUDE_TASK_ALLOW_INSECURE=true');
    expect((await admin.post('/hosts', { name: 'BOX' })).status).toBe(409);
    expect((await admin.patch(`/hosts/${created.body.host.id}`, { allowInsecure: false })).status).toBe(400);
    const { workers } = await import('../src/db/schema');
    await app.server.ctx.db.insert(workers).values({ name: 'Used', hostId: created.body.host.id, dockerfile: 'FROM claude-task/agent-base' });
    expect((await admin.delete(`/hosts/${created.body.host.id}`)).body.error.message).toContain('Used');
  });
  it('lets Members read Hosts and refuses every write', async () => {
    const admin = await app.admin();
    const { client } = await createUser(app, admin);
    const { host } = (await admin.post('/hosts', { name: 'Member view' })).body;
    expect((await client.get('/hosts')).status).toBe(200);
    expect((await client.get(`/hosts/${host.id}`)).status).toBe(200);
    expect((await client.post('/hosts', { name: 'Forbidden' })).status).toBe(403);
    expect((await client.patch(`/hosts/${host.id}`, { network: 'vpn' })).status).toBe(403);
    expect((await client.post(`/hosts/${host.id}/token`)).status).toBe(403);
    expect((await client.delete(`/hosts/${host.id}`)).status).toBe(403);
  });

});

describe('Local Host disabled', () => {
  const app = useTestApp({ config: { localHost: false }, defaultWorker: false });
  it('hides the Local Host when unused, but explains existing Workers', async () => {
    const admin = await app.admin();
    expect((await admin.get('/hosts')).body.hosts).toEqual([]);
    const { hosts, workers } = await import('../src/db/schema');
    const [local] = await app.server.ctx.db.select().from(hosts);
    await app.server.ctx.db.insert(workers).values({ name: 'Existing', hostId: local!.id, dockerfile: 'FROM claude-task/agent-base\nUSER agent' });
    expect((await admin.get('/hosts')).body.hosts).toEqual([expect.objectContaining({ name: 'Local', state: 'disconnected', error: 'Local Host disabled (LOCAL_HOST=false)' })]);
  });
});
