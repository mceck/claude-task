// Session lifecycle rules (docs/specs/agent-sessions.md): Assignment, Agent changes, unassignment, closing and
// reopening a Task, and how a User's Comment reaches the Agent. One Session per Task, whichever Agent
// works it. Lock order: project → task → worker → session → job → queue entries. The Worker's row lock
// serializes every change to its Queue and dispatch, so the dispatcher may take its entry before the Session.
import { cancelLimitResumes } from '../modules/scheduled-messages/service';
import { commandName, taskKey } from '@claude-task/shared';
import { and, asc, eq, gt, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { transactWithRetry } from '../context';
import type { AfterCommit, AppContext } from '../context';
import type { Executor } from '../db/client';
import { comments, jobs, projects, sessions, statuses, tasks } from '../db/schema';
import { conflict, notFound } from '../errors';
import { gitOwnerTask } from '../git/owner';
import { ACTIVE_JOB_STATES } from '../modules/agents/service';
import type { JobRow } from '../modules/agents/service';
import type { TaskRow } from '../modules/tasks/service';
import { getWorkerRow, workerOfTask } from '../modules/workers/service';
import { renderComments } from './messages';
import type { CommentRow } from './messages';
import { attachComments, carriesDelivery, enqueue, getEntry, removeEntry } from './queue';
import type { SessionRow } from './view';

/** Deterministic per (Project, Task), because `--resume` needs the same cwd (docs/specs/agent-sessions.md). */
export async function worktreePathFor(db: Executor, task: Pick<TaskRow, 'id' | 'projectId' | 'number'>): Promise<string> {
  const owner = await gitOwnerTask(db, task);
  const [p] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, task.projectId));
  return `worktrees/${task.projectId}/${taskKey(p!.key, owner.number)}`;
}

/** The Bare Clone a Worktree belongs to (`worktrees/<projectId>/…` → `repos/<projectId>.git`). */
export const repoPathOf = (worktreePath: string) => `repos/${worktreePath.split('/')[1]}.git`;

export async function isClosedStatus(db: Executor, statusId: string): Promise<boolean> {
  const [s] = await db.select({ category: statuses.category }).from(statuses).where(eq(statuses.id, statusId));
  return s?.category === 'closed';
}

/** Locks the Worker of the Task's Project, which serializes its Queue and dispatch. */
export async function lockTaskWorker(db: Executor, taskId: string): Promise<string> {
  // Share-lock the Project first: a concurrent Project move holds it for update while it changes
  // the Worker, so reading the Worker below cannot see the old one just before the move commits.
  const [row] = await db
    .select({ workerId: projects.workerId })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId))
    .for('share', { of: projects });
  if (!row) throw notFound('Task');
  await getWorkerRow(db, row.workerId, { lock: true });
  return row.workerId;
}

export async function lockSession(db: Executor, taskId: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.taskId, taskId)).for('update');
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

function publishSession(after: AfterCommit, taskId: string, workerId: string | null): void {
  if (workerId) {
    after.effect((ctx) => ctx.scheduler.publishQueue(workerId, [taskId]));
    after.effect((ctx) => void ctx.scheduler.reconcile(workerId));
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

  if (agentChanged) {
    // A Limit Resume survives a change of Agent: the conversation goes on with the new one.
    if (!task.agentId) await cancelLimitResumes(tx, after, task.id, 'The agent was unassigned');
    await assign(tx, after, task, closedNow);
  }
  if (!closedBefore && closedNow) await closeSession(tx, after, task);
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
    if (closedNow) await closeSession(tx, after, task);
    else await reopenSession(tx, after, task);
  }
}

/**
 * The Task's Agent changed. The Session is the Task's, so a change between two Agents keeps it as
 * it is (a running Job finishes with the previous Agent); removing the Agent pauses it, and
 * assigning one to a paused Session resumes it with what was said meanwhile.
 */
async function assign(tx: Executor, after: AfterCommit, task: TaskRow, closed: boolean): Promise<void> {
  const workerId = await lockTaskWorker(tx, task.id);
  let session = await lockSession(tx, task.id);
  if (!task.agentId) {
    if (session && session.state !== 'closed' && session.state !== 'paused') await pauseSession(tx, after, session, 'agent unassigned');
    publishSession(after, task.id, workerId);
    return;
  }
  if (!session) {
    const [created] = await tx
      .insert(sessions)
      .values({ taskId: task.id, state: closed ? 'closed' : 'pending', worktreePath: await worktreePathFor(tx, task), closedAt: closed ? new Date() : null })
      .returning();
    session = created!;
  } else if (session.state === 'paused') {
    await tx
      .update(sessions)
      .set({ state: session.started ? 'idle' : 'pending', closedAt: null, worktreeRemovalPending: false })
      .where(eq(sessions.id, session.id));
    if (session.started) {
      // Whatever was said while the Task had no Agent reaches the one assigned now.
      const since = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(
          and(
            eq(comments.taskId, task.id),
            eq(comments.internal, false),
            isNull(comments.deletedAt),
            carriesDelivery,
            // Comments a Job already read (written to it mid-Turn) are in the conversation.
            notInArray(comments.deliveryState, ['delivered', 'handled']),
            session.lastJobAt ? gt(comments.createdAt, session.lastJobAt) : undefined,
          ),
        )
        .orderBy(asc(comments.createdAt));
      if (since.length > 0) {
        const entry = await enqueue(tx, after, { workerId, taskId: task.id, sessionId: session.id, kind: 'messages' });
        await attachComments(tx, after, entry.id, since.map((c) => c.id));
      }
    }
  }
  await tx.update(tasks).set({ currentSessionId: session.id }).where(eq(tasks.id, task.id));
  publishSession(after, task.id, workerId);
}

/** Unassigned: the running Turn is interrupted and the process told to finish; nothing more is delivered. */
async function pauseSession(tx: Executor, after: AfterCommit, session: SessionRow, reason: string): Promise<void> {
  const job = await activeJob(tx, session.id, true);
  if (job && job.state !== 'finishing' && job.containerId) {
    const containerId = job.containerId;
    after.effect((ctx) => {
      ctx.runners.send(containerId, { type: 'job.interrupt', jobId: job.id });
      ctx.runners.send(containerId, { type: 'job.end', jobId: job.id });
    });
  }
  const entry = await getEntry(tx, session.taskId, true);
  if (entry) await removeEntry(tx, after, entry, reason);
  await tx.update(sessions).set({ state: 'paused' }).where(eq(sessions.id, session.id));
}

/** Closed: cancel any Job, drop undelivered Messages, close the Session and remove the Worktree. */
async function closeSession(tx: Executor, after: AfterCommit, task: TaskRow): Promise<void> {
  await cancelLimitResumes(tx, after, task.id, 'The task was closed');
  const workerId = await lockTaskWorker(tx, task.id);
  const session = await lockSession(tx, task.id);
  if (!session || session.state === 'closed') return;
  const job = await activeJob(tx, session.id, true);
  if (job) {
    await tx.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, job.id));
    if (job.containerId) {
      const containerId = job.containerId;
      after.effect((ctx) => ctx.runners.send(containerId, { type: 'job.cancel', jobId: job.id }));
    }
  }
  const entry = await getEntry(tx, task.id, true);
  if (entry) await removeEntry(tx, after, entry, 'task closed');
  await tx.update(sessions).set({ state: 'closed', closedAt: new Date(), worktreeRemovalPending: true, worktreeStatus: null }).where(eq(sessions.id, session.id));
  after.effect((ctx) => ctx.scheduler.removeWorktree(session.id));
  publishSession(after, task.id, workerId);
}

/** Tasks being deleted (with their Sessions): a Runner of their Worker removes the Worktrees once committed. */
export async function removeDeletedWorktrees(tx: Executor, after: AfterCommit, taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const kept = await tx
    .select({ workerId: projects.workerId, worktreePath: sessions.worktreePath, slot: sessions.lastSlot })
    .from(sessions)
    .innerJoin(tasks, eq(tasks.id, sessions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(inArray(sessions.taskId, taskIds), sql`(${sessions.state} <> 'closed' or ${sessions.worktreeRemovalPending})`));
  after.effect((ctx) => {
    for (const s of kept) ctx.scheduler.sendToWorker(s.workerId, { type: 'worktree.remove', worktreePath: s.worktreePath, repoPath: repoPathOf(s.worktreePath) }, s.slot);
  });
}

/** Reopened: the same Session waits for the next Comment (or Notify agent). */
async function reopenSession(tx: Executor, after: AfterCommit, task: TaskRow): Promise<void> {
  if (!task.currentSessionId) return;
  const workerId = await lockTaskWorker(tx, task.id);
  const session = await lockSession(tx, task.id);
  if (!session || session.state !== 'closed') return;
  const state = !task.agentId ? 'paused' : session.started ? 'idle' : 'pending';
  await tx.update(sessions).set({ state, closedAt: null, worktreeRemovalPending: false }).where(eq(sessions.id, session.id));
  publishSession(after, task.id, workerId);
}

/**
 * A User's Comment (or a Notify agent notice) on a Task: written to the running process right
 * away when the Task's Agent is working on this Task, otherwise queued, merging into the Task's entry.
 * Interrupt and send also interrupts the running Turn first, so the Comment is read at once.
 */
export async function deliverComment(
  tx: Executor,
  after: AfterCommit,
  taskRef: Pick<TaskRow, 'id'>,
  comment: CommentRow,
  opts: { interrupt?: boolean } = {},
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
  const workerId = await lockTaskWorker(tx, task.id);
  const session = await lockSession(tx, task.id);
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
  const waiting = await getEntry(tx, task.id);
  // Only a Turn that is actually running can take more input. A Job that was told to
  // end or cancel keeps running while its stdin is already closed, so writing to it
  // would lose the Comment; those go through the Queue instead. A Job of the previous
  // Agent finishes its Turn alone: what is written now is for the Task's Agent.
  const canInject =
    job &&
    job.containerId &&
    job.agentId === task.agentId &&
    !job.discardOutput &&
    !job.cancelRequested &&
    job.state === 'running' &&
    session.state === 'running' &&
    !waiting &&
    !commandName(comment.body) &&
    after.ctx.runners.isReady(job.containerId);
  // Interrupt and send: the interrupt goes ahead of the Message, so `claude` ends the Turn and the
  // Message opens a new one in the same process. A queued Comment runs once the Job ends.
  const interrupt = opts.interrupt === true && job !== null && job.containerId !== null &&
    job.state === 'running' && !job.cancelRequested && !job.discardOutput;
  if (interrupt) {
    const containerId = job.containerId!;
    after.effect((ctx) => ctx.runners.send(containerId, { type: 'job.interrupt', jobId: job.id }));
  }
  if (canInject) {
    const containerId = job.containerId!;
    const parts = await renderComments(after.ctx, tx, [comment]);
    await setDelivery('delivered', null, job.id);
    if (comment.noticeTaskVersion !== null) {
      await tx
        .update(sessions)
        .set({ lastSeenTaskVersion: sql`greatest(${sessions.lastSeenTaskVersion}, ${comment.noticeTaskVersion})` })
        .where(eq(sessions.id, session.id));
      publishSession(after, task.id, null);
    }
    after.effect((ctx) => {
      if (!ctx.runners.send(containerId, { type: 'job.input', jobId: job.id, message: parts.blocks, attachmentsToFetch: parts.fetch }))
        void requeueUnsentComment(ctx, comment.id, job.id).catch((err) => ctx.log.error({ err, commentId: comment.id }, 'could not requeue an unsent Comment'));
    });
    return 'delivered';
  }

  // A new Comment is also how a held entry (after a failed Job) gets going again. When a Job
  // runs on this very Task, the entry goes to the front: the Task has priority over the other
  // Tasks waiting in the Queue, so it continues as soon as this Job ends.
  const entry = await enqueue(tx, after, {
    workerId,
    taskId: task.id,
    sessionId: session.id,
    kind: session.started ? 'messages' : 'start',
    held: false,
    front: job !== null,
  });
  await attachComments(tx, after, entry.id, [comment.id]);
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
    const workerId = await lockTaskWorker(tx, task.id);
    const session = await lockSession(tx, task.id);
    const [comment] = await tx.select().from(comments).where(eq(comments.id, commentId)).for('update');
    // A Turn ending before this ran may have marked it handled, though it never reached the process.
    if (!comment || comment.deletedAt || !['delivered', 'handled'].includes(comment.deliveryState) || comment.deliveredInJobId !== jobId) return;
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
    const job = await activeJob(tx, session.id);
    const entry = await enqueue(tx, after, {
      workerId,
      taskId: task.id,
      sessionId: session.id,
      kind: session.started ? 'messages' : 'start',
      // The Comment was meant for the Task being worked on: keep it ahead of other Tasks.
      front: job !== null,
    });
    await attachComments(tx, after, entry.id, [commentId]);
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
  const { session } = await currentSession(tx, taskId);
  if (!session) throw conflict('No agent is working on this task');
  await lockTaskWorker(tx, taskId);
  const job = await activeJob(tx, session.id, true);
  if (!job || job.state === 'finishing' || !job.containerId) throw conflict('The agent is not running a turn on this task');
  const containerId = job.containerId;
  after.effect((ctx) => ctx.runners.send(containerId, { type: 'job.interrupt', jobId: job.id }));
}

/** Retry after a failed Job: releases the held Queue Entry. */
export async function retrySession(tx: Executor, after: AfterCommit, taskId: string): Promise<void> {
  const { task, session } = await currentSession(tx, taskId);
  if (!session || !task.agentId) throw conflict('No agent is assigned to this task');
  const workerId = await lockTaskWorker(tx, taskId);
  const entry = await getEntry(tx, taskId, true);
  if (!entry?.held) throw conflict('Nothing is waiting for a retry');
  await enqueue(tx, after, { workerId, taskId, sessionId: entry.sessionId, kind: entry.kind, held: false });
  publishSession(after, taskId, null);
}

/** Every Session of the Project that `claude` has started and that is still open, with its Task. */
export async function startedOpenSessions(db: Executor, projectId: string): Promise<{ taskId: string; number: number }[]> {
  return db
    .select({ taskId: tasks.id, number: tasks.number })
    .from(sessions)
    .innerJoin(tasks, eq(tasks.id, sessions.taskId))
    .where(and(eq(tasks.projectId, projectId), eq(sessions.started, true), ne(sessions.state, 'closed')))
    .orderBy(asc(tasks.number));
}
