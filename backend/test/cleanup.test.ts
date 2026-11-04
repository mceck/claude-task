import { WORKERS_TOPIC } from '@claude-task/shared';
import type { Cleanup, Worker } from '@claude-task/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { workerContainers, workers } from '../src/db/schema';
import { useTestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { createAgent, createProject, createUser, createWorker } from './helpers/fixtures';
import { FakeRunner } from './helpers/runner';
import { WsTestClient } from './helpers/ws';

const DAY = 24 * 60 * 60_000;

/** Starts a manual Cleanup and waits for it to finish. */
async function cleanUp(app: ReturnType<typeof useTestApp>, admin: ApiClient): Promise<Cleanup> {
  const res = await admin.post('/cleanup', {});
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await app.settle();
  return (await admin.get('/cleanup')).body.cleanup as Cleanup;
}

describe('Cleanup', () => {
  const app = useTestApp({ agents: { cleanup: true } });

  it('runs one at backend start', () => {
    expect(app.runtime.cleanups.length).toBeGreaterThan(0);
  });

  it('runs for Admins on request, with every Worker of the Installation, and reports what it removed', async () => {
    const admin = await app.admin();
    expect((await admin.get('/cleanup')).body).toEqual({ cleanup: null });
    const ws = await WsTestClient.connect(app.url, admin.cookie);
    await ws.subscribe(WORKERS_TOPIC);
    app.runtime.cleanupReport = {
      removed: { baseImages: 2, workerImages: 1, danglingImages: 3, orphanContainers: 0, orphanVolumes: 1, orphanImages: 0 },
      reclaimedBytes: 5_000_000_000,
      errors: ['image claude-task/worker-x:1: conflict'],
    };
    const before = app.runtime.cleanups.length;

    const cleanup = await cleanUp(app, admin);
    expect(app.runtime.cleanups.slice(before)).toEqual([{ anyBuilding: false, workers: [{ id: app.workerId, imageTag: expect.any(String), building: false }] }]);
    expect(cleanup).toMatchObject({
      trigger: 'manual',
      requestedBy: { name: 'Ada Admin' },
      finishedAt: expect.any(String),
      removed: { baseImages: 2, workerImages: 1, danglingImages: 3, orphanVolumes: 1, slots: 0, bareClones: 0, agentProfiles: 0 },
      reclaimedBytes: 5_000_000_000,
      errors: ['image claude-task/worker-x:1: conflict'],
    });
    const { event } = await ws.next('cleanup.updated', (e) => e.cleanup.id === cleanup.id && e.cleanup.finishedAt !== null);
    expect(event.cleanup.removed.baseImages).toBe(2);
    ws.close();
    app.runtime.cleanupReport = null;
  });

  it('is for Admins only', async () => {
    const admin = await app.admin();
    const { client } = await createUser(app, admin);
    expect((await client.post('/cleanup', {})).status).toBe(403);
    expect((await client.get('/cleanup')).status).toBe(403);
  });

  it('joins the running Cleanup instead of starting another', async () => {
    const admin = await app.admin();
    let release!: () => void;
    app.runtime.cleanupHold = new Promise<void>((r) => (release = r));
    const first = await admin.post('/cleanup', {});
    const second = await admin.post('/cleanup', {});
    expect(second.status).toBe(202);
    expect(second.body.cleanup.id).toBe(first.body.cleanup.id);
    expect(first.body.cleanup.finishedAt).toBeNull();
    release();
    app.runtime.cleanupHold = null;
    await app.settle();
    expect((await admin.get('/cleanup')).body.cleanup).toMatchObject({ id: first.body.cleanup.id, finishedAt: expect.any(String) });
  });

  /** A Worker whose slot 2 is stopped above a lowered cap, idle for `idleDays`. */
  async function slotAboveCap(admin: ApiClient, idleDays: number): Promise<Worker> {
    const worker = await createWorker(app, admin, { minimum: 2, cap: 2 });
    expect(app.runtime.runningSlots(worker.id)).toEqual([1, 2]);
    expect((await admin.patch(`/workers/${worker.id}`, { minimum: 1, cap: 1 })).status).toBe(200);
    await app.settle();
    expect(app.runtime.container(worker.id, 2)?.state).toBe('exited');
    await app.server.ctx.db
      .update(workerContainers)
      .set({ idleSince: new Date(Date.now() - idleDays * DAY) })
      .where(and(eq(workerContainers.workerId, worker.id), eq(workerContainers.slot, 2)));
    return worker;
  }

  const slotsOf = async (admin: ApiClient, id: string) => ((await admin.get(`/workers/${id}`)).body.worker as Worker).containers.map((c) => c.slot);

  it('removes a slot left above the cap once it has had no Job for 7 days', async () => {
    const admin = await app.admin();
    const recent = await slotAboveCap(admin, 6);
    const old = await slotAboveCap(admin, 8);
    await app.server.ctx.scheduler.cleanup('automatic');
    await app.settle();
    expect(app.runtime.removedSlots).toContain(`${old.id}:2`);
    expect(app.runtime.removedSlots).not.toContain(`${recent.id}:2`);
    expect(await slotsOf(admin, old.id)).toEqual([1]);
    expect(app.runtime.container(recent.id, 2)?.state).toBe('exited');
    expect((await admin.get('/cleanup')).body.cleanup.removed.slots).toBe(1);

    // Raising the cap again starts a fresh slot 2.
    expect((await admin.patch(`/workers/${old.id}`, { minimum: 2, cap: 2 })).status).toBe(200);
    await app.settle();
    expect(app.runtime.runningSlots(old.id)).toEqual([1, 2]);
  });

  it('removes slots above the cap at once when an Admin asks, but never a running one', async () => {
    const admin = await app.admin();
    const stopped = await slotAboveCap(admin, 0);
    const running = await createWorker(app, admin, { minimum: 2, cap: 2 });
    // Above the cap but still running (as if its Job had not ended yet): it stays.
    await app.server.ctx.db.update(workerContainers).set({ idleSince: new Date(Date.now() - 30 * DAY) }).where(eq(workerContainers.workerId, running.id));
    await app.server.ctx.db.execute(`update workers set cap = 1, minimum = 1 where id = '${running.id}'`);
    await cleanUp(app, admin);
    expect(app.runtime.removedSlots).toContain(`${stopped.id}:2`);
    expect(app.runtime.removedSlots).not.toContain(`${running.id}:2`);
  });

  it('asks a Runner of each Worker to drop the Bare Clones of Projects that left it and the Profiles of deleted Agents', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const staying = await createProject(admin);
    const leaving = await createProject(admin);
    const other = await createWorker(app, admin, { minimum: 1, cap: 1 });
    const moved = await admin.patch(`/projects/${leaving.project.id}/agent-settings`, { workerId: other.id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const started = (await admin.post('/cleanup', {})).body.cleanup as Cleanup;
    const request = await runner.next('volume.cleanup');
    expect(request.requestId).toBe(started.id);
    expect(request.keepProjects).toContain(staying.project.id);
    expect(request.keepProjects).not.toContain(leaving.project.id);
    expect(request.keepAgents).toContain(agent.id);
    await app.settle();
    // The other Worker's container runs but its Runner never connected: its part waits.
    expect((await admin.get('/cleanup')).body.cleanup).toMatchObject({ finishedAt: expect.any(String), volumesPending: 2 });

    runner.send({ type: 'volume.cleanup.result', requestId: started.id, bareClones: 1, agentProfiles: 2, reclaimedBytes: 1234, error: null });
    await app.settle();
    await new Promise((r) => setTimeout(r, 50));
    expect((await admin.get('/cleanup')).body.cleanup).toMatchObject({ volumesPending: 1, reclaimedBytes: 1234, removed: { bareClones: 1, agentProfiles: 2 } });

    const late = await FakeRunner.connect(app, { workerId: other.id, slot: 1 });
    const pending = await late.next('volume.cleanup');
    expect(pending).toMatchObject({ requestId: started.id, keepProjects: [leaving.project.id] });
    late.send({ type: 'volume.cleanup.result', requestId: started.id, bareClones: 0, agentProfiles: 0, reclaimedBytes: 0, error: 'permission denied' });
    await new Promise((r) => setTimeout(r, 100));
    const done = (await admin.get('/cleanup')).body.cleanup as Cleanup;
    expect(done.volumesPending).toBe(0);
    expect(done.errors).toEqual([`${other.name} volume: permission denied`]);
  });

  it('removes a stopped Worker Container still on an older image, and that image after it', async () => {
    const admin = await app.admin();
    const worker = await createWorker(app, admin, { minimum: 2, cap: 2 });
    expect((await admin.patch(`/workers/${worker.id}`, { minimum: 1, cap: 1 })).status).toBe(200);
    await app.settle();
    const oldImage = app.runtime.container(worker.id, 2)!.spec.image;
    expect(app.runtime.container(worker.id, 2)?.state).toBe('exited');
    expect((await admin.post(`/workers/${worker.id}/rebuild`, {})).status).toBe(200);
    await app.settle();
    const [{ imageTag: current }] = (await app.server.ctx.db.select({ imageTag: workers.imageTag }).from(workers).where(eq(workers.id, worker.id))) as [{ imageTag: string }];
    expect(current).not.toBe(oldImage);

    expect(app.runtime.container(worker.id, 2)).toBeUndefined();
    expect(app.runtime.container(worker.id, 1)?.spec.image).toBe(current);
    expect(app.runtime.imageRemovals).toContainEqual({ workerId: worker.id, keepTag: current });
    expect(app.runtime.oldBaseImageRemovals).toBeGreaterThan(0);
  });
});
