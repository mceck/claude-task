import { randomUUID } from 'node:crypto';
import { taskTopic } from '@claude-task/shared';
import type { Wiki } from '@claude-task/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import type { AfterCommit } from '../../context';
import {
  agentItems,
  attachments,
  comments,
  jobs,
  projects,
  queueEntries,
  sessionEvents,
  sessions,
  taskActivity,
  taskPreferences,
  taskRevisions,
  tasks,
  turns,
} from '../../db/schema';
import { notFound } from '../../errors';
import { ACTIVE_JOB_STATES, lockAgents } from '../agents/service';
import { emitTasksChanged } from '../tasks/service';

export async function listWikis(db: Executor, id?: string): Promise<Wiki[]> {
  const rows = await db
    .select({ project: projects, task: tasks })
    .from(projects)
    .innerJoin(tasks, and(eq(tasks.projectId, projects.id), eq(tasks.number, 1)))
    .where(and(eq(projects.kind, 'wiki'), id ? eq(projects.id, id) : undefined))
    .orderBy(asc(projects.name));
  return rows.map(({ project: p, task: t }) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    repository: p.repository!,
    taskId: t.id,
    agentId: t.agentId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}

export async function getWiki(db: Executor, id: string, lock = false): Promise<Wiki> {
  if (lock)
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.kind, 'wiki')))
      .for('update');
  const [wiki] = await listWikis(db, id);
  if (!wiki) throw notFound('Wiki');
  return wiki;
}

/** Preserve the checkout and Git branch. Rotate Claude's identity even for paused Agents. */
export async function resetWiki(tx: Executor, after: AfterCommit, wiki: Wiki): Promise<void> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, wiki.taskId)).for('update');
  const allSessions = await tx.select().from(sessions).where(eq(sessions.taskId, wiki.taskId));
  await lockAgents(
    tx,
    allSessions.map((s) => s.agentId),
  );
  const active = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.taskId, wiki.taskId), inArray(jobs.state, [...ACTIVE_JOB_STATES])))
    .for('update');
  // Active Jobs keep occupying their Agent until cancellation is acknowledged.
  // Their remaining output is discarded, including on reconnect and recovery.
  await tx
    .update(jobs)
    .set({ cancelRequested: true, discardOutput: true, projection: null, stderr: '', setupOutput: '' })
    .where(eq(jobs.taskId, wiki.taskId));
  for (const job of active) after.effect((c) => c.runners.send(job.agentId, { type: 'job.cancel', jobId: job.id }));
  await tx.delete(queueEntries).where(eq(queueEntries.taskId, wiki.taskId));
  const blobs = await tx
    .select({ blobId: attachments.blobId })
    .from(attachments)
    .innerJoin(comments, eq(comments.id, attachments.commentId))
    .where(eq(comments.taskId, wiki.taskId));
  await tx.delete(comments).where(eq(comments.taskId, wiki.taskId));
  await tx.delete(agentItems).where(eq(agentItems.taskId, wiki.taskId));
  await tx.delete(taskRevisions).where(eq(taskRevisions.taskId, wiki.taskId));
  await tx.delete(taskActivity).where(eq(taskActivity.taskId, wiki.taskId));
  const jobIds = tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.taskId, wiki.taskId));
  await tx.delete(sessionEvents).where(inArray(sessionEvents.jobId, jobIds));
  await tx.delete(turns).where(eq(turns.taskId, wiki.taskId));
  await tx.update(taskPreferences).set({ readPosition: 0n }).where(eq(taskPreferences.taskId, wiki.taskId));
  for (const s of allSessions) {
    await tx
      .update(sessions)
      .set({
        claudeSessionId: randomUUID(),
        started: false,
        state: s.agentId === task!.agentId ? 'pending' : 'paused',
        lastSeenTaskVersion: 0,
        lastJobAt: null,
        closedAt: null,
        worktreeRemovalPending: false,
      })
      .where(eq(sessions.id, s.id));
  }
  await tx
    .update(tasks)
    .set({ version: sql`${tasks.version} + 1`, chatGeneration: sql`${tasks.chatGeneration} + 1`, updatedAt: new Date() })
    .where(eq(tasks.id, wiki.taskId));
  after.emit(taskTopic(wiki.taskId), { type: 'timeline.reset', taskId: wiki.taskId });
  await emitTasksChanged(tx, after, [wiki.taskId], 'task.updated');
  after.effect((c) => {
    c.scheduler.publishTask(wiki.taskId);
    for (const s of allSessions) c.scheduler.publishQueue(s.agentId, [wiki.taskId]);
  });
  for (const b of blobs) after.run(() => after.ctx.blobs.delete(b.blobId));
}
