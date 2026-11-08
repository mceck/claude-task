import { taskKey } from '@claude-task/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { agentProfiles, hosts, jobs, projects, tasks, workerContainers, workers } from '../../db/schema';
import { badRequest, conflict } from '../../errors';
import { startedOpenSessions } from '../../sessions/lifecycle';
import { ACTIVE_JOB_STATES } from '../agents/service';
import { addToCleanup } from '../workers/cleanup';
import type { WorkerRow } from '../workers/service';

export async function chooseHost(ctx: AppContext, db: Executor, id?: string): Promise<string> {
  const rows = await db.select().from(hosts);
  const selectable = rows.filter((h) => h.kind !== 'local' || ctx.config.localHost !== false);
  if (id) { if (!selectable.some((h) => h.id === id)) throw badRequest('Unknown host'); return id; }
  const local = selectable.find((h) => h.kind === 'local');
  if (local) return local.id;
  if (selectable.length === 1) return selectable[0]!.id;
  throw badRequest('Choose a host');
}

/** Caller holds the Worker lock, also used by dispatch to start a Session or a Job. */
export async function moveWorker(ctx: AppContext, tx: Executor, worker: WorkerRow, hostId: string): Promise<string[]> {
  await chooseHost(ctx, tx, hostId);
  const keys: string[] = []; let wiki = false;
  for (const project of await tx.select().from(projects).where(eq(projects.workerId, worker.id))) {
    const started = await startedOpenSessions(tx, project.id);
    keys.push(...started.map((s) => taskKey(project.key, s.number)));
    if (started.length && project.kind === 'wiki') wiki = true;
  }
  if (keys.length) throw conflict(`These tasks still have a conversation on the current host: ${keys.join(', ')}. Close them first${wiki ? ' (delete the chats of a wiki)' : ''}.`);
  const active = await tx.select({ key: projects.key, number: tasks.number }).from(jobs).innerJoin(tasks, eq(tasks.id, jobs.taskId)).innerJoin(projects, eq(projects.id, tasks.projectId)).where(and(eq(jobs.workerId, worker.id), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
  if (active.length) throw conflict(`An agent is still running a job of this worker: ${active.map((j) => taskKey(j.key, j.number)).join(', ')}. Try again when it ends.`);
  const containers = await tx.select({ id: workerContainers.id }).from(workerContainers).where(eq(workerContainers.workerId, worker.id));
  if (worker.volumeCleanupPending) await addToCleanup(tx, worker.volumeCleanupPending, { volumesPending: -1 });
  await tx.delete(workerContainers).where(eq(workerContainers.workerId, worker.id));
  await tx.delete(agentProfiles).where(eq(agentProfiles.workerId, worker.id));
  await tx.update(workers).set({ hostId, imageTag: null, imageState: 'none', imageBaseVersion: null, volumeCleanupPending: null }).where(eq(workers.id, worker.id));
  return containers.map((c) => c.id);
}
