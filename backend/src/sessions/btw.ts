// Btw and Clear, the two commands the platform answers itself (docs/specs/conversation.md#btw).
import type { Actor, Comment } from '@claude-task/shared';
import { and, eq } from 'drizzle-orm';
import type { AfterCommit } from '../context';
import { transactWithRetry } from '../context';
import type { AppContext } from '../context';
import type { Executor } from '../db/client';
import { agents, btwThreads, jobs, sessions } from '../db/schema';
import { badRequest, conflict, notFound } from '../errors';
import { createUserComment, loadComment } from '../modules/comments/service';
import type { TaskRow } from '../modules/tasks/service';
import { ACTIVE_JOB_STATES } from '../modules/agents/service';
import { failBtw, applyClear, BTW_SYSTEM_PROMPT, sessionIdentity } from './btw-state';
import { activeJob, lockSession, lockTaskWorker } from './lifecycle';
import { enqueueBtw } from './queue';
import { btwBlocker } from './btw-rules';

export { applyPendingClear } from './btw-state';

/** `/btw <question>`: the question, or null when the body is not a Btw command. */
export function parseBtwCommand(body: string): { question: string } | 'empty' | null {
  const m = /^\s*\/btw(?:\s+([\s\S]*))?$/.exec(body);
  if (!m) return null;
  const question = (m[1] ?? '').trim();
  return question ? { question } : 'empty';
}

/** The body is the command `/clear` alone: `true`; `/clear` with more text: `'extra'`; anything else: `false`. */
export function parseClearCommand(body: string): boolean | 'extra' {
  const m = /^\s*\/clear(\s+\S[\s\S]*)?\s*$/.exec(body);
  if (!m) return false;
  return m[1] ? 'extra' : true;
}

/** Whether the Job's Runner can start a fork right now: a Turn is running and listening. */
function takesFork(after: AfterCommit, job: typeof jobs.$inferSelect): boolean {
  return job.kind !== 'btw' && job.state === 'running' && !job.cancelRequested && !job.discardOutput && job.containerId !== null && after.ctx.runners.isReady(job.containerId);
}

/**
 * A new Btw or a reply to a Btw Thread. Posts the question as a Btw Comment, then runs the fork:
 * in the Runner of the Session's running Job, or as a Btw Job through the Queue.
 */
export async function askBtw(
  tx: Executor,
  after: AfterCommit,
  task: TaskRow,
  input: { question: string; threadId?: string },
  author: Actor,
): Promise<Comment> {
  if (input.question.trim() === '') throw badRequest('A btw needs a question');
  if (!task.currentSessionId) throw conflict('There is no agent session on this task to ask a btw about');
  const workerId = await lockTaskWorker(tx, task.id);
  const session = await lockSession(tx, task.id);
  if (!session) throw conflict('There is no agent session on this task to ask a btw about');
  const [reply] = input.threadId ? await tx.select().from(btwThreads).where(eq(btwThreads.id, input.threadId)).for('update') : [];
  if (input.threadId && (!reply || reply.taskId !== task.id)) throw notFound('Btw thread');
  const [busy] = await tx.select({ id: btwThreads.id }).from(btwThreads).where(and(eq(btwThreads.sessionId, session.id), eq(btwThreads.state, 'working'))).limit(1);
  const blocked = btwBlocker({
    session,
    hasAgent: task.agentId !== null,
    working: !!busy,
    reply: reply ? { originSessionId: reply.originSessionId, forkSessionId: reply.forkSessionId } : null,
  });
  if (blocked) throw conflict(blocked);

  const identity = sessionIdentity(session);
  const [thread] = reply
    ? [reply]
    : await tx.insert(btwThreads).values({ taskId: task.id, sessionId: session.id, originSessionId: identity as string }).returning();
  const comment = await createUserComment(
    tx,
    after,
    task,
    { body: input.question, internal: true, attachments: [], btw: { threadId: thread!.id, role: 'question' } },
    author,
  );
  const spec = {
    id: thread!.id,
    question: input.question,
    mode: reply ? ('resume' as const) : ('fork' as const),
    sessionId: reply ? reply.forkSessionId! : identity,
    appendSystemPrompt: BTW_SYSTEM_PROMPT,
  };
  const job = await activeJob(tx, session.id, true);
  if (job && session.state === 'running' && takesFork(after, job)) {
    await tx.update(btwThreads).set({ state: 'working', workingCommentId: comment.id, workingJobId: job.id }).where(eq(btwThreads.id, thread!.id));
    const [agent] = job.agentId ? await tx.select({ model: agents.model }).from(agents).where(eq(agents.id, job.agentId)) : [];
    const containerId = job.containerId!;
    after.effect((ctx) => {
      if (ctx.runners.send(containerId, { type: 'job.btw', jobId: job.id, btw: { ...spec, model: agent?.model ?? null } })) return;
      void failUnsentBtw(ctx, thread!.id).catch((err) => ctx.log.error({ err, threadId: thread!.id }, 'could not fail an unsent btw'));
    });
  } else {
    await tx.update(btwThreads).set({ state: 'working', workingCommentId: comment.id, workingJobId: null }).where(eq(btwThreads.id, thread!.id));
    await enqueueBtw(tx, after, { workerId, taskId: task.id, sessionId: session.id, commentId: comment.id });
  }
  after.effect((ctx) => {
    ctx.scheduler.publishComments([comment.id]);
    ctx.scheduler.publishTask(task.id);
  });
  return loadComment(tx, comment.id);
}

/** The Runner could not take the fork: the Btw fails, and the thread can be tried again. */
async function failUnsentBtw(ctx: AppContext, threadId: string): Promise<void> {
  await transactWithRetry(ctx, async (tx, after) => {
    const [thread] = await tx.select().from(btwThreads).where(eq(btwThreads.id, threadId)).for('update');
    if (thread) await failBtw(tx, after, thread, 'the agent could not be reached');
  });
}

/**
 * `/clear`: effective at once while no Job of the Session is active, otherwise requested and applied
 * when the Job ends. Returns the Chat Cleared line's id once it is in the Timeline.
 */
export async function requestClear(tx: Executor, after: AfterCommit, task: TaskRow, author: Actor): Promise<{ markerId: string | null }> {
  if (!task.currentSessionId) throw conflict('There is no conversation to clear on this task');
  await lockTaskWorker(tx, task.id);
  const session = await lockSession(tx, task.id);
  if (!session || (session.state !== 'idle' && session.state !== 'running')) {
    throw conflict('There is no conversation to clear: the agent has not started, is not assigned or the task is closed');
  }
  if (session.clearRequestedAt) return { markerId: null };
  const job = await activeJob(tx, session.id, true);
  const holds = job && job.kind !== 'btw' && (ACTIVE_JOB_STATES as readonly string[]).includes(job.state);
  if (holds) {
    await tx.update(sessions).set({ clearRequestedAt: new Date(), clearRequestedBy: author.id }).where(eq(sessions.id, session.id));
    after.effect((ctx) => ctx.scheduler.publishTask(task.id));
    return { markerId: null };
  }
  return { markerId: await applyClear(tx, after, { ...session, clearRequestedBy: author.id }) };
}

