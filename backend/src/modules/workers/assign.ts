// The Worker a Project runs on (docs/specs/workers.md, "Assigning a Worker to Projects").
import { taskKey } from '@claude-task/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AfterCommit } from '../../context';
import type { Executor } from '../../db/client';
import { jobs, projects, queueEntries, tasks, workers } from '../../db/schema';
import { badRequest, conflict } from '../../errors';
import { generateKeyBetween } from 'fractional-indexing';
import { startedOpenSessions } from '../../sessions/lifecycle';
import { ACTIVE_JOB_STATES } from '../agents/service';
import { getWorkerRow } from './service';

export async function assertWorker(db: Executor, workerId: string): Promise<void> {
  const [row] = await db.select({ id: workers.id }).from(workers).where(eq(workers.id, workerId));
  if (!row) throw badRequest('Unknown worker');
}

/**
 * Moves the Project to another Worker. Transcripts and Worktrees live in the old Worker's volume, so the
 * move is refused while a Session of the Project has started and is still open, or a Job runs; Sessions
 * that never started go along, and their Queue Entries join the end of the new Worker's Queue in order.
 */
export async function changeProjectWorker(tx: Executor, after: AfterCommit, projectId: string, workerId: string): Promise<boolean> {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
  if (!project) throw badRequest('Unknown project');
  if (project.workerId === workerId) return false;
  await assertWorker(tx, workerId);
  for (const id of [project.workerId, workerId].sort()) await getWorkerRow(tx, id, { lock: true });
  const started = await startedOpenSessions(tx, projectId);
  if (started.length > 0) {
    const keys = started.map((s) => taskKey(project.key, s.number));
    throw conflict(`These tasks still have a conversation on the current worker: ${keys.join(', ')}. Close them first${project.kind === 'wiki' ? ' (delete the chats of a wiki)' : ''}.`);
  }
  const [running] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(tasks.projectId, projectId), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
  if (running) throw conflict('An agent is still running a job of this project; try again when it ends.');
  await tx.update(projects).set({ workerId, updatedAt: new Date() }).where(eq(projects.id, projectId));
  const moving = await tx
    .select({ id: queueEntries.id, taskId: queueEntries.taskId })
    .from(queueEntries)
    .innerJoin(tasks, eq(tasks.id, queueEntries.taskId))
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(queueEntries.position), asc(queueEntries.id));
  if (moving.length > 0) {
    const [last] = await tx
      .select({ position: queueEntries.position })
      .from(queueEntries)
      .where(eq(queueEntries.workerId, workerId))
      .orderBy(asc(queueEntries.position))
      .then((rows) => rows.slice(-1));
    let position = last?.position ?? null;
    for (const entry of moving) {
      position = generateKeyBetween(position, null);
      await tx.update(queueEntries).set({ workerId, position }).where(eq(queueEntries.id, entry.id));
    }
  }
  const previous = project.workerId;
  after.effect((ctx) => {
    ctx.scheduler.publishQueue(previous, moving.map((e) => e.taskId));
    ctx.scheduler.publishQueue(workerId, moving.map((e) => e.taskId));
    ctx.scheduler.publishWorker(previous);
    ctx.scheduler.publishWorker(workerId);
    ctx.scheduler.kick(workerId);
  });
  return true;
}
