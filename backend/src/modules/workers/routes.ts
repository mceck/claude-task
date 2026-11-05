import { WORKER_CAP_MAX, checkAgentDockerfile, createWorkerBody, duplicateWorkerBody, moveQueueEntryBody, updateWorkerBody } from '@claude-task/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { copyName } from '../copy-name';
import type { Executor } from '../../db/client';
import { projects, queueEntries, workerBuilds, workerContainers, workers } from '../../db/schema';
import { badRequest, conflict, notFound, parse } from '../../errors';
import { loadQueue, moveEntry, removeEntry } from '../../sessions/queue';
import { loadJobs } from '../agents/service';
import { currentUser } from '../../auth/guard';
import { loadCleanup } from './cleanup';
import { getWorkerRow, isUp, loadBuilds, loadWorker, loadWorkers, serializeBuild } from './service';

const params = z.object({ id: z.uuid() });
const slotParams = z.object({ id: z.uuid(), slot: z.coerce.number().int().min(1).max(WORKER_CAP_MAX) });
const entryParams = z.object({ id: z.uuid(), entryId: z.uuid() });
const buildParams = z.object({ id: z.uuid(), buildId: z.uuid() });
const logsQuery = z.object({ tail: z.coerce.number().int().min(1).max(5000).default(500) });

function assertDockerfile(dockerfile: string): void {
  const check = checkAgentDockerfile(dockerfile);
  if (!check.ok) throw badRequest(check.error);
}

async function assertUniqueName(db: Executor, name: string, except?: string): Promise<void> {
  const [row] = await db.select({ id: workers.id }).from(workers).where(sql`lower(${workers.name}) = lower(${name})`);
  if (row && row.id !== except) throw conflict('A worker with this name already exists');
}

async function getContainerRow(db: Executor, workerId: string, slot: number) {
  const [row] = await db.select().from(workerContainers).where(and(eq(workerContainers.workerId, workerId), eq(workerContainers.slot, slot)));
  return row ?? null;
}

async function getQueueEntry(db: Executor, workerId: string, entryId: string) {
  const [entry] = await db.select().from(queueEntries).where(and(eq(queueEntries.id, entryId), eq(queueEntries.workerId, workerId)));
  if (!entry) throw notFound('Queue entry');
  return entry;
}

export function workerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { config: { auth: 'admin' as const } };
  const ready = (id: string) => ctx.runners.isReady(id);

  app.get('/workers', async () => ({ workers: await loadWorkers(ctx.db, ready) }));

  app.get('/workers/:id', async (request) => {
    const { id } = parse(params, request.params);
    return { worker: await loadWorker(ctx.db, ready, id) };
  });

  app.post('/workers', admin, async (request, reply) => {
    const body = parse(createWorkerBody, request.body);
    assertDockerfile(body.dockerfile);
    await assertUniqueName(ctx.db, body.name);
    const [row] = await ctx.db.insert(workers).values(body).returning();
    ctx.scheduler.build(row!.id);
    return reply.status(201).send({ worker: await loadWorker(ctx.db, ready, row!.id) });
  });

  app.patch('/workers/:id', admin, async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateWorkerBody, request.body);
    if (body.dockerfile !== undefined) assertDockerfile(body.dockerfile);
    if (body.name !== undefined) await assertUniqueName(ctx.db, body.name, id);
    const before = await ctx.db.transaction(async (tx) => {
      const row = await getWorkerRow(tx, id, { lock: true });
      if ((body.minimum ?? row.minimum) > (body.cap ?? row.cap)) throw badRequest('The minimum cannot exceed the cap');
      await tx.update(workers).set({ ...body, updatedAt: new Date() }).where(eq(workers.id, id));
      return row;
    });
    if (
      (body.dockerfile !== undefined && body.dockerfile !== before.dockerfile) ||
      (body.services !== undefined && JSON.stringify(body.services) !== JSON.stringify(before.services))
    )
      ctx.scheduler.build(id);
    else await ctx.scheduler.reconcile(id);
    ctx.scheduler.kick(id);
    ctx.scheduler.publishWorker(id);
    return { worker: await loadWorker(ctx.db, ready, id) };
  });

  app.delete('/workers/:id', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    const containers = await ctx.db.transaction(async (tx) => {
      await getWorkerRow(tx, id, { lock: true });
      const used = await tx.select({ name: projects.name }).from(projects).where(eq(projects.workerId, id));
      if (used.length > 0) throw conflict(`The worker runs these projects: ${used.map((p) => p.name).join(', ')}. Give them another worker first.`);
      const rows = await tx.select({ id: workerContainers.id }).from(workerContainers).where(eq(workerContainers.workerId, id));
      await tx.delete(workers).where(eq(workers.id, id));
      return rows;
    });
    for (const c of containers) ctx.runners.disconnect(c.id, 4003, 'worker deleted');
    void ctx.runtime.removeWorker(id).catch((err) => ctx.log.warn({ err, workerId: id }, 'could not remove the worker containers'));
    ctx.scheduler.publishWorker(id);
    return reply.status(204).send();
  });

  app.post('/workers/:id/duplicate', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    const { name } = parse(duplicateWorkerBody, request.body ?? {});
    const source = await getWorkerRow(ctx.db, id);
    if (name !== undefined) await assertUniqueName(ctx.db, name);
    const [row] = await ctx.db
      .insert(workers)
      .values({
        name: name ?? copyName(source.name, (await ctx.db.select({ name: workers.name }).from(workers)).map((r) => r.name)),
        description: source.description,
        dockerfile: source.dockerfile,
        services: source.services,
        cpuLimit: source.cpuLimit,
        memoryMb: source.memoryMb,
        minimum: source.minimum,
        cap: source.cap,
        enabled: source.enabled,
      })
      .returning();
    ctx.scheduler.build(row!.id);
    return reply.status(201).send({ worker: await loadWorker(ctx.db, ready, row!.id) });
  });

  app.post('/workers/:id/rebuild', admin, async (request) => {
    const { id } = parse(params, request.params);
    await getWorkerRow(ctx.db, id);
    ctx.scheduler.build(id);
    return { worker: await loadWorker(ctx.db, ready, id) };
  });

  /** Every Worker Container is recreated with the current image and limits as soon as it is free. */
  app.post('/workers/:id/recreate', admin, async (request) => {
    const { id } = parse(params, request.params);
    const worker = await getWorkerRow(ctx.db, id);
    if (!worker.imageTag) throw conflict('The worker has no image yet');
    await ctx.db.update(workerContainers).set({ containerSpec: 'recreate' }).where(eq(workerContainers.workerId, id));
    await ctx.scheduler.reconcile(id);
    return { worker: await loadWorker(ctx.db, ready, id) };
  });

  app.post('/workers/:id/containers/:slot/restart', admin, async (request) => {
    const { id, slot } = parse(slotParams, request.params);
    await getWorkerRow(ctx.db, id);
    const row = await getContainerRow(ctx.db, id, slot);
    if (!row || row.containerState === 'missing') throw conflict('This worker container does not exist yet');
    if (!isUp(row.containerState)) throw conflict('This worker container is stopped; it starts when work arrives');
    await ctx.runtime.restartContainer(id, slot).catch((err) => {
      throw conflict(`Could not restart the container: ${(err as Error).message}`);
    });
    // A restart starts a fresh Runner and gives the container a fresh idle window; without this
    // an idle container above the minimum is stopped again by the reconcile below.
    await ctx.db
      .update(workerContainers)
      .set({ idleSince: new Date(), runnerDisconnectedAt: new Date() })
      .where(eq(workerContainers.id, row.id));
    await ctx.scheduler.reconcile(id);
    return { worker: await loadWorker(ctx.db, ready, id) };
  });

  /** Recreates one container now, interrupting its Job; the Job resumes after the new Runner connects. */
  app.post('/workers/:id/containers/:slot/force-recreate', admin, async (request) => {
    const { id, slot } = parse(slotParams, request.params);
    const worker = await getWorkerRow(ctx.db, id);
    if (!worker.imageTag) throw conflict('The worker has no image yet');
    const row = await getContainerRow(ctx.db, id, slot);
    if (!row) throw conflict('This worker container does not exist yet');
    await ctx.db.update(workerContainers).set({ containerSpec: 'recreate', forceRecreate: true }).where(eq(workerContainers.id, row.id));
    await ctx.scheduler.reconcile(id);
    return { worker: await loadWorker(ctx.db, ready, id) };
  });

  app.get('/workers/:id/containers/:slot/logs', admin, async (request) => {
    const { id, slot } = parse(slotParams, request.params);
    const { tail } = parse(logsQuery, request.query);
    await getWorkerRow(ctx.db, id);
    return { logs: await ctx.runtime.logs(id, slot, tail).catch(() => '') };
  });

  app.get('/workers/:id/builds', async (request) => {
    const { id } = parse(params, request.params);
    await getWorkerRow(ctx.db, id);
    const builds = await loadBuilds(ctx.db, id);
    // Only the latest log comes with the list; older ones on request.
    return { builds: builds.map((b, i) => (i === 0 ? b : { ...b, log: '' })) };
  });

  app.get('/workers/:id/builds/:buildId', async (request) => {
    const { id, buildId } = parse(buildParams, request.params);
    const [row] = await ctx.db.select().from(workerBuilds).where(and(eq(workerBuilds.id, buildId), eq(workerBuilds.workerId, id)));
    if (!row) throw notFound('Build');
    return { build: serializeBuild(row) };
  });

  app.get('/workers/:id/jobs', async (request) => {
    const { id } = parse(params, request.params);
    await getWorkerRow(ctx.db, id);
    return { jobs: await loadJobs(ctx.db, { workerId: id, limit: 30 }) };
  });

  // Cleanup (docs/specs/workers.md, "Cleanup")

  app.get('/cleanup', admin, async () => ({ cleanup: await loadCleanup(ctx.db) }));

  /** Starts a Cleanup, or joins the running one; it goes on in the background. */
  app.post('/cleanup', admin, async (request, reply) => {
    const id = await ctx.scheduler.cleanup('manual', currentUser(request).id);
    return reply.status(202).send({ cleanup: await loadCleanup(ctx.db, id) });
  });

  // Queue (every User may reorder and remove entries)

  app.get('/workers/:id/queue', async (request) => {
    const { id } = parse(params, request.params);
    await getWorkerRow(ctx.db, id);
    return { entries: await loadQueue(ctx.db, id) };
  });

  app.post('/workers/:id/queue/:entryId/move', async (request) => {
    const { id, entryId } = parse(entryParams, request.params);
    const body = parse(moveQueueEntryBody, request.body);
    await transact(ctx, async (tx, after) => {
      await getWorkerRow(tx, id, { lock: true });
      const entry = await getQueueEntry(tx, id, entryId);
      await moveEntry(tx, after, entry, body);
    });
    ctx.scheduler.kick(id);
    return { entries: await loadQueue(ctx.db, id) };
  });

  app.delete('/workers/:id/queue/:entryId', async (request, reply) => {
    const { id, entryId } = parse(entryParams, request.params);
    await transact(ctx, async (tx, after) => {
      await getWorkerRow(tx, id, { lock: true });
      const entry = await getQueueEntry(tx, id, entryId);
      if (entry.kind === 'start') throw badRequest("A session start can't be removed from the queue; unassign the agent instead");
      await removeEntry(tx, after, entry, 'removed from queue');
    });
    return reply.status(204).send();
  });
}
