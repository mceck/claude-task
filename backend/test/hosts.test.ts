import { describe, expect, it } from 'vitest';
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
