// Workers: configuration, Worker Containers and Builds (docs/specs/workers.md).
import { WORKERS_TOPIC, workerTopic } from '@claude-task/shared';
import type { AgentRef, Worker, WorkerBuild, WorkerContainer, WorkerContainerState, WorkerState } from '@claude-task/shared';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { agentProfiles, agents, jobs, projects, queueEntries, tasks, workerBuilds, workerContainers, workers } from '../../db/schema';
import { notFound } from '../../errors';
import { ACTIVE_JOB_STATES, agentRefs, taskRefs } from '../agents/service';

export type WorkerRow = typeof workers.$inferSelect;
export type WorkerContainerRow = typeof workerContainers.$inferSelect;

export async function getWorkerRow(db: Executor, id: string, opts: { lock?: boolean } = {}): Promise<WorkerRow> {
  const query = db.select().from(workers).where(eq(workers.id, id));
  const [row] = await (opts.lock ? query.for('update') : query);
  if (!row) throw notFound('Worker');
  return row;
}

/** The Worker a Task's Jobs run on: its Project's. */
export async function workerOfTask(db: Executor, taskId: string): Promise<string> {
  const [row] = await db.select({ workerId: projects.workerId }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).where(eq(tasks.id, taskId));
  if (!row) throw notFound('Task');
  return row.workerId;
}

/** What each container should be: compared with what it was created with to spot pending recreations. */
export function desiredContainerSpec(w: Pick<WorkerRow, 'imageTag' | 'cpuLimit' | 'memoryMb'>): string | null {
  return w.imageTag ? JSON.stringify({ image: w.imageTag, cpu: w.cpuLimit, mem: w.memoryMb }) : null;
}

export async function containerRows(db: Executor, workerId: string): Promise<WorkerContainerRow[]> {
  return db.select().from(workerContainers).where(eq(workerContainers.workerId, workerId)).orderBy(asc(workerContainers.slot));
}

/** The row of a Worker Slot, created on its first start. */
export async function ensureContainerRow(db: Executor, workerId: string, slot: number): Promise<WorkerContainerRow> {
  await db.insert(workerContainers).values({ workerId, slot }).onConflictDoNothing();
  const [row] = await db.select().from(workerContainers).where(and(eq(workerContainers.workerId, workerId), eq(workerContainers.slot, slot)));
  return row!;
}

const isUp = (state: string) => ['running', 'restarting'].includes(state);

export async function loadWorkers(db: Executor, isReady: (containerId: string) => boolean, ids?: string[]): Promise<Worker[]> {
  if (ids && ids.length === 0) return [];
  const rows = await db
    .select()
    .from(workers)
    .where(ids ? inArray(workers.id, ids) : undefined)
    .orderBy(asc(sql`lower(${workers.name})`));
  if (rows.length === 0) return [];
  const workerIds = rows.map((r) => r.id);
  const containers = await db.select().from(workerContainers).where(inArray(workerContainers.workerId, workerIds)).orderBy(asc(workerContainers.slot));
  const active = await db
    .select({ id: jobs.id, containerId: jobs.containerId, workerId: jobs.workerId, taskId: jobs.taskId, agentId: jobs.agentId })
    .from(jobs)
    .where(and(inArray(jobs.workerId, workerIds), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
  const tasksById = await taskRefs(db, active.map((a) => a.taskId));
  const agentsById = await agentRefs(db, active.map((a) => a.agentId).filter((id): id is string => !!id));
  const queued = await db
    .select({ workerId: queueEntries.workerId, n: sql<number>`count(*)::int` })
    .from(queueEntries)
    .where(inArray(queueEntries.workerId, workerIds))
    .groupBy(queueEntries.workerId);
  const projectRows = await db
    .select({ id: projects.id, name: projects.name, kind: projects.kind, workerId: projects.workerId })
    .from(projects)
    .where(inArray(projects.workerId, workerIds))
    .orderBy(asc(sql`lower(${projects.name})`));
  const errors = await db
    .select({ workerId: agentProfiles.workerId, agentId: agentProfiles.agentId, agentName: agents.name, error: agentProfiles.error })
    .from(agentProfiles)
    .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
    .where(and(inArray(agentProfiles.workerId, workerIds), isNotNull(agentProfiles.error)));

  return rows.map((w) => {
    const desired = desiredContainerSpec(w);
    const mine = containers.filter((c) => c.workerId === w.id);
    const highest = Math.max(w.cap, ...mine.map((c) => c.slot));
    const slots: WorkerContainer[] = [];
    for (let slot = 1; slot <= highest; slot++) {
      const c = mine.find((x) => x.slot === slot);
      const job = c ? active.find((a) => a.containerId === c.id) : undefined;
      const connected = !!c && isReady(c.id);
      const up = !!c && isUp(c.containerState);
      const state: WorkerContainerState = !up ? 'stopped' : !connected ? 'starting' : job ? 'working' : 'idle';
      slots.push({
        slot,
        state,
        containerState: c?.containerState ?? 'missing',
        runnerConnected: connected,
        recreatePending: !!c && desired !== null && c.containerSpec !== null && c.containerSpec !== desired,
        job: job ? { id: job.id, task: tasksById.get(job.taskId)!, agent: (job.agentId && agentsById.get(job.agentId)) || (null as AgentRef | null) } : null,
        runnerVersion: c?.runnerVersion ?? null,
        claudeVersion: c?.claudeVersion ?? null,
        lastActivityAt: c?.lastActivityAt?.toISOString() ?? null,
      });
    }
    const busy = slots.filter((s) => s.state === 'working').length;
    const running = slots.filter((s) => s.state !== 'stopped').length;
    const ready = slots.filter((s) => s.state === 'idle' || s.state === 'working').length;
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      dockerfile: w.dockerfile,
      services: w.services,
      cpuLimit: w.cpuLimit,
      memoryMb: w.memoryMb,
      minimum: w.minimum,
      cap: w.cap,
      enabled: w.enabled,
      imageState: w.imageState,
      state: workerState(w, ready, busy),
      containers: slots,
      busy,
      running,
      queueLength: queued.find((q) => q.workerId === w.id)?.n ?? 0,
      projects: projectRows.filter((p) => p.workerId === w.id).map(({ id, name, kind }) => ({ id, name, kind })),
      profileErrors: errors.filter((e) => e.workerId === w.id).map(({ agentId, agentName, error }) => ({ agentId, agentName, error: error! })),
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  });
}

function workerState(w: WorkerRow, ready: number, busy: number): WorkerState {
  if (!w.enabled) return 'disabled';
  if (w.imageState === 'building' || (w.imageState === 'none' && !w.imageTag)) return 'building';
  if (w.imageState === 'failed') return 'build_failed';
  if (ready === 0) return 'offline';
  return busy > 0 ? 'working' : 'idle';
}

export async function loadWorker(db: Executor, isReady: (containerId: string) => boolean, id: string): Promise<Worker> {
  const [worker] = await loadWorkers(db, isReady, [id]);
  if (!worker) throw notFound('Worker');
  return worker;
}

/** Publishes the Worker's current state on the Workers topics (loaded after commit). */
export async function publishWorker(ctx: AppContext, workerId: string): Promise<void> {
  const [worker] = await loadWorkers(ctx.db, (id) => ctx.runners.isReady(id), [workerId]);
  if (!worker) {
    ctx.hub.publish(WORKERS_TOPIC, { type: 'worker.deleted', workerId });
    ctx.hub.publish(workerTopic(workerId), { type: 'worker.deleted', workerId });
    return;
  }
  ctx.hub.publish(WORKERS_TOPIC, { type: 'worker.updated', worker });
  ctx.hub.publish(workerTopic(workerId), { type: 'worker.updated', worker });
}

export function serializeBuild(b: typeof workerBuilds.$inferSelect): WorkerBuild {
  return {
    id: b.id,
    workerId: b.workerId,
    status: b.status,
    baseVersion: b.baseVersion,
    log: b.log,
    startedAt: b.startedAt.toISOString(),
    finishedAt: b.finishedAt?.toISOString() ?? null,
  };
}

export async function loadBuilds(db: Executor, workerId: string, limit = 20): Promise<WorkerBuild[]> {
  const rows = await db.select().from(workerBuilds).where(eq(workerBuilds.workerId, workerId)).orderBy(desc(workerBuilds.startedAt)).limit(limit);
  return rows.map(serializeBuild);
}
