// The state of Btw Threads (docs/specs/agent-sessions.md#btw): how a fork's outcome becomes Comments,
// and how a thread ends when its fork cannot answer. Database only, so the lifecycle and the Runner
// handlers can use it without pulling in the Comment service.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AfterCommit } from '../context';
import type { Executor } from '../db/client';
import { btwThreads, comments, jobs, queueEntries, sessions, users } from '../db/schema';
import { ACTIVE_JOB_STATES } from '../modules/agents/service';
import { getEntry } from './queue';
import type { SessionRow } from './view';

export type ThreadRow = typeof btwThreads.$inferSelect;

/** The Claude session identity `claude` runs the Session under. */
export const sessionIdentity = (s: { id: string; claudeSessionId: string | null }): string => s.claudeSessionId ?? s.id;

/** Added to the fork's system prompt: it answers from the conversation and nothing else. */
export const BTW_SYSTEM_PROMPT =
  'This is a side question (a "btw") about the conversation so far. Answer it briefly from what the conversation already contains. You have no tools in this answer, the main work carries on independently, and nothing you say changes it.';

/** Posts a Comment of a Btw Thread. It is flagged internal, so no Agent-facing path ever sees it. */
async function postThreadComment(
  tx: Executor,
  after: AfterCommit,
  thread: ThreadRow,
  input: { role: 'answer' | 'failure'; body: string; agentId?: string | null; jobId?: string },
): Promise<string> {
  const agent = input.role === 'answer';
  const [row] = await tx
    .insert(comments)
    .values({
      taskId: thread.taskId,
      kind: agent ? 'agent' : 'system',
      authorType: agent ? 'agent' : 'system',
      authorId: agent ? (input.agentId ?? null) : null,
      jobId: input.jobId ?? null,
      body: input.body,
      internal: true,
      btwThreadId: thread.id,
      btwRole: input.role,
      createdAt: sql`clock_timestamp()`,
    })
    .returning({ id: comments.id });
  after.effect((ctx) => ctx.scheduler.publishComments([row!.id], 'created'));
  return row!.id;
}

/** The thread stops working: its question no longer shows "thinking", and a reply can continue it. */
async function stopWorking(tx: Executor, after: AfterCommit, thread: ThreadRow, extra: Partial<typeof btwThreads.$inferInsert> = {}): Promise<void> {
  await tx.update(btwThreads).set({ state: 'idle', workingCommentId: null, workingJobId: null, ...extra }).where(eq(btwThreads.id, thread.id));
  if (thread.workingCommentId) {
    const id = thread.workingCommentId;
    after.effect((ctx) => ctx.scheduler.publishComments([id]));
  }
  after.effect((ctx) => ctx.scheduler.publishTask(thread.taskId));
}

/** The fork answered: the answer is an Agent Comment of the thread. */
export async function answerBtw(
  tx: Executor,
  after: AfterCommit,
  thread: ThreadRow,
  input: { text: string; agentId: string | null; jobId: string; costUsd: number; usage: Record<string, unknown> | null; forkSessionId: string | null },
): Promise<void> {
  await postThreadComment(tx, after, thread, { role: 'answer', body: input.text, agentId: input.agentId, jobId: input.jobId });
  await stopWorking(tx, after, thread, {
    costUsd: sql`${btwThreads.costUsd} + ${input.costUsd}` as unknown as number,
    usage: input.usage,
    forkSessionId: input.forkSessionId ?? thread.forkSessionId,
  });
}

/** The fork could not answer: a System Comment in the Btw style says why; the Session is untouched. */
export async function failBtw(tx: Executor, after: AfterCommit, thread: ThreadRow, reason: string): Promise<void> {
  if (thread.state !== 'working') return;
  await postThreadComment(tx, after, thread, { role: 'failure', body: `The btw could not be answered: ${reason}` });
  await stopWorking(tx, after, thread);
}

/** The Job that ran the thread's fork ended, or its Runner could not take it: the answer will never come. */
export async function failWorkingBtws(tx: Executor, after: AfterCommit, jobId: string, reason: string): Promise<void> {
  const threads = await tx.select().from(btwThreads).where(and(eq(btwThreads.workingJobId, jobId), eq(btwThreads.state, 'working'))).for('update');
  for (const thread of threads) await failBtw(tx, after, thread, reason);
}

/** A Btw still waiting in the Queue when the Session closes or loses its Agent is dropped. */
export async function cancelQueuedBtw(tx: Executor, after: AfterCommit, taskId: string, reason: string): Promise<void> {
  const queued = await tx
    .select()
    .from(btwThreads)
    .where(and(eq(btwThreads.taskId, taskId), eq(btwThreads.state, 'working'), isNull(btwThreads.workingJobId)))
    .for('update');
  if (queued.length === 0) return;
  const removed = await tx
    .delete(queueEntries)
    .where(and(eq(queueEntries.taskId, taskId), inArray(queueEntries.btwCommentId, queued.map((t) => t.workingCommentId).filter((id): id is string => !!id))))
    .returning({ workerId: queueEntries.workerId });
  for (const thread of queued) await failBtw(tx, after, thread, reason);
  for (const { workerId } of removed) after.effect((ctx) => ctx.scheduler.publishQueue(workerId, [taskId]));
}

// Clear (docs/specs/agent-sessions.md#clear-the-conversation)

/**
 * The Clear takes effect: a new Claude conversation, the same Session, Worktree, Branch and
 * Comments. The Session waits for the next Comment as a new Session does.
 */
export async function applyClear(tx: Executor, after: AfterCommit, session: SessionRow): Promise<string> {
  const [by] = session.clearRequestedBy ? await tx.select({ name: users.displayName }).from(users).where(eq(users.id, session.clearRequestedBy)) : [];
  await tx
    .update(sessions)
    .set({
      claudeSessionId: randomUUID(),
      started: false,
      state: 'pending',
      lastSeenTaskVersion: 0,
      lastJobAt: null,
      clearRequestedBy: null,
      clearRequestedAt: null,
    })
    .where(eq(sessions.id, session.id));
  // What waits in the Queue opens the new conversation.
  const entry = await getEntry(tx, session.taskId, true);
  if (entry) await tx.update(queueEntries).set({ kind: 'start' }).where(eq(queueEntries.id, entry.id));
  const [marker] = await tx
    .insert(comments)
    .values({
      taskId: session.taskId,
      kind: 'system',
      authorType: 'system',
      authorId: null,
      body: `${by?.name ?? 'Someone'} cleared the chat`,
      clearMarker: true,
      createdAt: sql`clock_timestamp()`,
    })
    .returning({ id: comments.id });
  after.effect((ctx) => {
    ctx.scheduler.publishComments([marker!.id], 'created');
    ctx.scheduler.publishTask(session.taskId);
    if (entry) ctx.scheduler.publishQueue(entry.workerId, [session.taskId]);
  });
  return marker!.id;
}

/** A Job of the Session ended: a Clear that waited for it takes effect, unless another Job still works the Session. */
export async function applyPendingClear(tx: Executor, after: AfterCommit, sessionId: string): Promise<void> {
  const [session] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for('update');
  if (!session?.clearRequestedAt) return;
  const [active] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.sessionId, sessionId), ne(jobs.kind, 'btw'), inArray(jobs.state, [...ACTIVE_JOB_STATES])))
    .limit(1);
  if (active) return;
  await applyClear(tx, after, session);
}
