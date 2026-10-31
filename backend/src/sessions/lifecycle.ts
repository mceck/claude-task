// Session lifecycle rules (docs/specs/agent-sessions.md): Assignment, unassignment, reassignment, closing and
// reopening a Task, and how a User's Comment reaches the Agent. Lock order everywhere:
// project → task → agents (by id) → session → job → queue entries.
import { cancelLimitResumes } from '../modules/scheduled-messages/service';
import { commandName, taskKey } from '@claude-task/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { transactWithRetry } from '../context';
import type { AfterCommit, AppContext } from '../context';
import type { Executor } from '../db/client';
import { comments, jobs, projects, sessions, statuses, tasks } from '../db/schema';
import { conflict } from '../errors';
import { gitOwnerTask } from '../git/owner';
import { ACTIVE_JOB_STATES, lockAgents } from '../modules/agents/service';
import type { JobRow } from '../modules/agents/service';
import type { TaskRow } from '../modules/tasks/service';
import { renderComments } from './messages';
import type { CommentRow } from './messages';
import { attachComments, enqueue, getEntry, removeEntry } from './queue';
import type { SessionRow } from './view';

/** Deterministic per (Project, Task), because `--resume` needs the same cwd (docs/specs/agent-sessions.md). */
export async function worktreePathFor(db: Executor, task: Pick<TaskRow, 'id' | 'projectId' | 'number'>): Promise<string> {
  const owner = await gitOwnerTask(db, task);
  const [p] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, task.projectId));
  return `worktrees/${task.projectId}/${taskKey(p!.key, owner.number)}`;
}

export async function isClosedStatus(db: Executor, statusId: string): Promise<boolean> {
  const [s] = await db.select({ category: statuses.category }).from(statuses).where(eq(statuses.id, statusId));
  return s?.category === 'closed';
}

async function lockSession(db: Executor, taskId: string, agentId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.taskId, taskId), eq(sessions.agentId, agentId)))
    .for('update');
  return row ?? null;
}

export async function activeJob(db: Executor, sessionId: string, lock = false): Promise<JobRow | null> {
  const query = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.sessionId, sessionId), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
  const [row] = await (lock ? query.for('update') : query);
  return row ?? null;
}

function publishSession(after: AfterCommit, taskId: string, agentIds: (string | null)[]): void {
  for (const agentId of agentIds) {
    if (!agentId) continue;
    after.effect((ctx) => ctx.scheduler.publishQueue(agentId, [taskId]));
    after.effect((ctx) => ctx.scheduler.refresh(agentId));
  }
  after.effect((ctx) => ctx.scheduler.publishTask(taskId));
}

/**
 * Applies the lifecycle rules after a Task's Agent or Status changed. Runs inside the
 * transaction that changed it, with the Task row locked.
 */
export async function onTaskChanged(
  tx: Executor,
  after: AfterCommit,
  task: TaskRow,
  before: { agentId: string | null; statusId: string },
): Promise<void> {
  const agentChanged = before.agentId !== task.agentId;
  const statusChanged = before.statusId !== task.statusId;
  if (!agentChanged && !statusChanged) return;
  const closedBefore = await isClosedStatus(tx, before.statusId);
  const closedNow = statusChanged ? await isClosedStatus(tx, task.statusId) : closedBefore;

  if (agentChanged) await cancelLimitResumes(tx, after, task.id, 'The agent was unassigned or replaced');
  if (agentChanged) await reassign(tx, after, task, before.agentId, closedNow);
  if (!closedBefore && closedNow) await closeSessions(tx, after, task);
  else if (closedBefore && !closedNow) await reopenSession(tx, after, task);
}

/** A Status switched into or out of the `closed` Category: its Tasks close or reopen with it. */
export async function onStatusClosedChanged(tx: Executor, after: AfterCommit, statusId: string, closedNow: boolean): Promise<void> {
  const affected = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.statusId, statusId), sql`${tasks.currentSessionId} is not null`))
    .orderBy(asc(tasks.id))
    .for('update');
  for (const task of affected) {
    if (closedNow) await closeSessions(tx, after, task);
    else await reopenSession(tx, after, task);
  }
}

async function reassign(tx: Executor, after: AfterCommit, task: TaskRow, previous: string | null, closed: boolean): Promise<void> {
  await lockAgents(tx, [previous, task.agentId].filter((x): x is string => !!x));
  if (previous) {
    const old = await lockSession(tx, task.id, previous);
    if (old && old.state !== 'closed' && old.state !== 'paused') await pauseSession(tx, after, old, 'agent unassigned');
  }
  if (!task.agentId) {
    publishSession(after, task.id, [previous]);
    return;
  }

  let session = await lockSession(tx, task.id, task.agentId);
  if (!session) {
    const [created] = await tx
      .insert(sessions)
      .values({ taskId: task.id, agentId: task.agentId, state: closed ? 'closed' : 'pending', worktreePath: await worktreePathFor(tx, task) })
      .returning();
    session = created!;
  } else if (closed) {
    await tx.update(sessions).set({ state: 'closed', closedAt: session.closedAt ?? new Date() }).where(eq(sessions.id, session.id));
  } else if (!session.started) {
    await tx.update(sessions).set({ state: 'pending', closedAt: null }).where(eq(sessions.id, session.id));
  } else {
    // Back to an Agent that worked on it before: same Session, plus whatever was said meanwhile.
    await tx.update(sessions).set({ state: 'idle', closedAt: null, worktreeRemovalPending: false }).where(eq(sessions.id, session.id));
    const entry = await enqueue(tx, after, { agentId: task.agentId, taskId: task.id, sessionId: session.id, kind: 'messages' });
    const since = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          eq(comments.taskId, task.id),
          eq(comments.internal, false),
          isNull(comments.deletedAt),
          // Agent and User Comments, plus System notices (Survey results, Notify agent).
          or(ne(comments.kind, 'system'), isNotNull(comments.noticeMessage)),
          or(ne(comments.authorType, 'agent'), ne(comments.authorId, task.agentId)),
          session.lastJobAt ? gt(comments.createdAt, session.lastJobAt) : undefined,
        ),
      )
      .orderBy(asc(comments.createdAt));
    await attachComments(tx, after, entry.id, since.map((c) => c.id));
  }
  await tx.update(tasks).set({ currentSessionId: session.id }).where(eq(tasks.id, task.id));
  publishSession(after, task.id, [previous, task.agentId]);
}

/** Unassigned: the running Turn is interrupted and the process told to finish; nothing more is delivered. */
async function pauseSession(tx: Executor, after: AfterCommit, session: SessionRow, reason: string): Promise<void> {
  const job = await activeJob(tx, session.id, true);
  if (job && job.state !== 'finishing') {
    after.effect((ctx) => {
      ctx.runners.send(job.agentId, { type: 'job.interrupt', jobId: job.id });
      ctx.runners.send(job.agentId, { type: 'job.end', jobId: job.id });
    });
  }
  const entry = await getEntry(tx, session.agentId, session.taskId, true);
  if (entry) await removeEntry(tx, after, entry, reason);
  await tx.update(sessions).set({ state: 'paused' }).where(eq(sessions.id, session.id));
}

/** A Wiki's Chat whose Agent is no longer the Wiki's: its Session pauses, whatever it was doing. */
export async function pauseTaskSession(tx: Executor, after: AfterCommit, task: TaskRow): Promise<void> {
  if (!task.agentId) return;
  await lockAgents(tx, [task.agentId]);
  const session = await lockSession(tx, task.id, task.agentId);
  if (!session || session.state === 'paused' || session.state === 'closed') return;
  await pauseSession(tx, after, session, 'agent unassigned');
  publishSession(after, task.id, [task.agentId]);
}

/** The Wiki is back to the Agent that runs this Chat: its Session is available again. */
export async function resumeTaskSession(tx: Executor, after: AfterCommit, task: TaskRow): Promise<void> {
  if (!task.agentId) return;
  await lockAgents(tx, [task.agentId]);
  const session = await lockSession(tx, task.id, task.agentId);
  if (!session || session.state !== 'paused') return;
  await tx.update(sessions).set({ state: session.started ? 'idle' : 'pending' }).where(eq(sessions.id, session.id));
  publishSession(after, task.id, [task.agentId]);
}

/** Closed: cancel any Job, drop undelivered Messages, close every Session and remove the Worktrees. */
async function closeSessions(tx: Executor, after: AfterCommit, task: TaskRow): Promise<void> {
  await cancelLimitResumes(tx, after, task.id, 'The task was closed');
  const open = await tx
    .select({ id: sessions.id, agentId: sessions.agentId })
    .from(sessions)
    .where(and(eq(sessions.taskId, task.id), ne(sessions.state, 'closed')));
  if (open.length === 0) return;
  await lockAgents(tx, open.map((s) => s.agentId));
  for (const { agentId } of open) {
    const session = await lockSession(tx, task.id, agentId);
    if (!session || session.state === 'closed') continue;
    const job = await activeJob(tx, session.id, true);
    if (job) {
      await tx.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, job.id));
      after.effect((ctx) => ctx.runners.send(job.agentId, { type: 'job.cancel', jobId: job.id }));
    }
    const entry = await getEntry(tx, agentId, task.id, true);
    if (entry) await removeEntry(tx, after, entry, 'task closed');
    await tx
      .update(sessions)
      .set({ state: 'closed', closedAt: new Date(), worktreeRemovalPending: true })
      .where(eq(sessions.id, session.id));
    after.effect((ctx) => ctx.scheduler.removeWorktree(session.id));
  }
  publishSession(after, task.id, open.map((s) => s.agentId));
}

/** Tasks being deleted (with their Sessions): their Agents remove the Worktrees once committed. */
export async function removeDeletedWorktrees(tx: Executor, after: AfterCommit, taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const kept = await tx
    .select({ agentId: sessions.agentId, worktreePath: sessions.worktreePath })
    .from(sessions)
    .where(and(inArray(sessions.taskId, taskIds), or(ne(sessions.state, 'closed'), eq(sessions.worktreeRemovalPending, true))));
  after.effect((ctx) => {
    for (const s of kept) {
      ctx.runners.send(s.agentId, { type: 'worktree.remove', worktreePath: s.worktreePath, repoPath: `repos/${s.worktreePath.split('/')[1]}.git` });
    }
  });
}

/** Reopened: the same Session waits for the next Comment (or Notify agent). */
async function reopenSession(tx: Executor, after: AfterCommit, task: TaskRow): Promise<void> {
  if (!task.agentId || !task.currentSessionId) return;
  await lockAgents(tx, [task.agentId]);
  const session = await lockSession(tx, task.id, task.agentId);
  if (!session || session.state !== 'closed') return;
  await tx
    .update(sessions)
    .set({ state: session.started ? 'idle' : 'pending', closedAt: null, worktreeRemovalPending: false })
    .where(eq(sessions.id, session.id));
  publishSession(after, task.id, [task.agentId]);
}

/**
 * A User's Comment (or a Notify agent notice) on a Task: written to the running process right
 * away when the Agent is working on this Task, otherwise queued, merging into the Task's entry.
 */
export async function deliverComment(
  tx: Executor,
  after: AfterCommit,
  taskRef: Pick<TaskRow, 'id'>,
  comment: CommentRow,
): Promise<'delivered' | 'queued' | 'not_delivered' | 'none'> {
  if (comment.internal) return 'none';
  // Inserting the Comment key-share locked the Task, so this read is current.
  const [task] = await tx
    .select({ id: tasks.id, agentId: tasks.agentId, currentSessionId: tasks.currentSessionId })
    .from(tasks)
    .where(eq(tasks.id, taskRef.id));
  if (!task?.currentSessionId) return 'none';
  const setDelivery = async (state: 'delivered' | 'not_delivered', reason: string | null, jobId: string | null) => {
    await tx
      .update(comments)
      .set({ deliveryState: state, deliveryReason: reason, deliveredInJobId: jobId, queueEntryId: null })
      .where(eq(comments.id, comment.id));
    after.effect((ctx) => ctx.scheduler.publishComments([comment.id]));
  };
  if (!task.agentId) {
    await setDelivery('not_delivered', 'no agent assigned', null);
    return 'not_delivered';
  }
  await lockAgents(tx, [task.agentId]);
  const session = await lockSession(tx, task.id, task.agentId);
  if (!session || session.state === 'paused') {
    await setDelivery('not_delivered', 'no agent assigned', null);
    return 'not_delivered';
  }
  if (session.state === 'closed') {
    await setDelivery('not_delivered', 'task closed', null);
    return 'not_delivered';
  }

  const job = await activeJob(tx, session.id, true);
  // Native commands run at a Job boundary, after the active response has finished.
  const waiting = await getEntry(tx, task.agentId, task.id);
  // Only a Turn that is actually running can take more input. A Job that was told to
  // end or cancel keeps running while its stdin is already closed, so writing to it
  // would lose the Comment; those go through the Queue instead.
  const canInject =
    job &&
    !job.discardOutput &&
    !job.cancelRequested &&
    job.state === 'running' &&
    session.state === 'running' &&
    !waiting &&
    !commandName(comment.body) &&
    after.ctx.runners.isReady(job.agentId);
  if (canInject) {
    const parts = await renderComments(after.ctx, tx, [comment]);
    await setDelivery('delivered', null, job.id);
    if (comment.noticeTaskVersion !== null) {
      await tx
        .update(sessions)
        .set({ lastSeenTaskVersion: sql`greatest(${sessions.lastSeenTaskVersion}, ${comment.noticeTaskVersion})` })
        .where(eq(sessions.id, session.id));
      publishSession(after, task.id, []);
    }
    after.effect((ctx) => {
      if (!ctx.runners.send(job.agentId, { type: 'job.input', jobId: job.id, message: parts.blocks, attachmentsToFetch: parts.fetch }))
        void requeueUnsentComment(ctx, comment.id, job.id).catch((err) => ctx.log.error({ err, commentId: comment.id }, 'could not requeue an unsent Comment'));
    });
    return 'delivered';
  }

  // A new Comment is also how a held entry (after a failed Job) gets going again.
  const entry = await enqueue(tx, after, {
    agentId: task.agentId,
    taskId: task.id,
    sessionId: session.id,
    kind: session.started ? 'messages' : 'start',
    held: false,
  });
  await attachComments(tx, after, entry.id, [comment.id]);
  after.effect((ctx) => ctx.scheduler.kick(task.agentId!));
  return 'queued';
}

/** A mid-Turn write whose socket had already closed: put the Comment back in the Queue. */
async function requeueUnsentComment(ctx: AppContext, commentId: string, jobId: string): Promise<void> {
  await transactWithRetry(ctx, async (tx, after) => {
    const [peek] = await tx.select({ taskId: comments.taskId, projectId: tasks.projectId })
      .from(comments).innerJoin(tasks, eq(tasks.id, comments.taskId)).where(eq(comments.id, commentId));
    if (!peek) return;
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, peek.projectId)).for('share');
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, peek.taskId)).for('update');
    if (!task) return;
    if (task.agentId) await lockAgents(tx, [task.agentId]);
    const session = task.agentId ? await lockSession(tx, task.id, task.agentId) : null;
    const [comment] = await tx.select().from(comments).where(eq(comments.id, commentId)).for('update');
    if (!comment || comment.deletedAt || comment.deliveryState !== 'delivered' || comment.deliveredInJobId !== jobId) return;
    const failed = async (reason: string) => {
      await tx
        .update(comments)
        .set({ deliveryState: 'not_delivered', deliveryReason: reason, deliveredInJobId: null, queueEntryId: null })
        .where(eq(comments.id, commentId));
      after.effect((c) => c.scheduler.publishComments([commentId]));
    };
    if (!task.agentId || !task.currentSessionId) return failed('no agent assigned');
    if (!session || session.state === 'paused') return failed('no agent assigned');
    if (session.state === 'closed') return failed('task closed');
    const entry = await enqueue(tx, after, {
      agentId: task.agentId,
      taskId: task.id,
      sessionId: session.id,
      kind: session.started ? 'messages' : 'start',
    });
    await attachComments(tx, after, entry.id, [commentId]);
    after.effect((c) => c.scheduler.kick(task.agentId!));
  });
}

export async function currentSession(db: Executor, taskId: string): Promise<{ task: TaskRow; session: SessionRow | null }> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task?.currentSessionId) return { task: task!, session: null };
  const [session] = await db.select().from(sessions).where(eq(sessions.id, task.currentSessionId));
  return { task, session: session ?? null };
}

/** The Stop button: interrupts the current Turn; the Session stays valid. */
export async function stopTurn(tx: Executor, after: AfterCommit, taskId: string): Promise<void> {
  const { task, session } = await currentSession(tx, taskId);
  if (!session || !task.agentId) throw conflict('No agent is working on this task');
  await lockAgents(tx, [session.agentId]);
  const job = await activeJob(tx, session.id, true);
  if (!job || job.state === 'finishing') throw conflict('The agent is not running a turn on this task');
  after.effect((ctx) => ctx.runners.send(job.agentId, { type: 'job.interrupt', jobId: job.id }));
}

/** Retry after a failed Job: releases the held Queue Entry. */
export async function retrySession(tx: Executor, after: AfterCommit, taskId: string): Promise<void> {
  const { task, session } = await currentSession(tx, taskId);
  if (!session || !task.agentId || session.agentId !== task.agentId) throw conflict('No agent is assigned to this task');
  await lockAgents(tx, [session.agentId]);
  const entry = await getEntry(tx, session.agentId, taskId, true);
  if (!entry?.held) throw conflict('Nothing is waiting for a retry');
  await enqueue(tx, after, { agentId: entry.agentId, taskId, sessionId: entry.sessionId, kind: entry.kind, held: false });
  after.effect((ctx) => ctx.scheduler.kick(entry.agentId));
  publishSession(after, taskId, []);
}

