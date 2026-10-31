// Scheduled Messages and the Limit Resume (docs/specs/conversation.md, docs/specs/agent-sessions.md).
import { SCHEDULED_MESSAGE_HISTORY, SCHEDULED_MESSAGE_MAX_DAYS, taskTopic } from '@claude-task/shared';
import type { Actor, ScheduledMessage } from '@claude-task/shared';
import { and, asc, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { transact } from '../../context';
import type { AfterCommit, AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { attachments, comments, limitResumeOffers, scheduledMessages, users } from '../../db/schema';
import { badRequest, conflict, notFound } from '../../errors';
import { deliverComment, isClosedStatus } from '../../sessions/lifecycle';
import { actorResolver } from '../actors';
import { createUserComment, loadComment, serializeAttachment } from '../comments/service';
import type { NewAttachment } from '../comments/service';
import { getTaskRow } from '../tasks/service';

type Row = typeof scheduledMessages.$inferSelect;

/** What the Agent receives when a Limit Resume is published. */
export const LIMIT_RESUME_NOTICE = 'The usage limit has been reset. Continue from where you stopped.';
/** The Limit Resume is due this long after the reset, so the limit has surely lifted. */
export const RESUME_MARGIN_MS = 60_000;
const MIN_LEAD_MS = 60_000;

/** A due time must be between one minute and `SCHEDULED_MESSAGE_MAX_DAYS` days ahead. */
export function assertDueAt(value: string, now = new Date()): Date {
  const dueAt = new Date(value);
  if (Number.isNaN(dueAt.getTime())) throw badRequest('Invalid date');
  const lead = dueAt.getTime() - now.getTime();
  if (lead < MIN_LEAD_MS) throw badRequest('Choose a time at least one minute from now');
  if (lead > SCHEDULED_MESSAGE_MAX_DAYS * 24 * 3600_000) throw badRequest(`Choose a time within the next ${SCHEDULED_MESSAGE_MAX_DAYS} days`);
  return dueAt;
}

export async function serializeMessages(db: Executor, rows: Row[]): Promise<ScheduledMessage[]> {
  if (rows.length === 0) return [];
  const files = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.scheduledMessageId, rows.map((r) => r.id)))
    .orderBy(asc(attachments.position));
  const resolve = await actorResolver(db, rows.map((r) => (r.authorId ? { type: 'user' as const, id: r.authorId } : { type: 'system' as const, id: null })));
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    kind: r.kind,
    author: r.authorId ? resolve({ type: 'user', id: r.authorId }) : resolve({ type: 'system', id: null }),
    body: r.body,
    internal: r.internal,
    attachments: files.filter((f) => f.scheduledMessageId === r.id).map(serializeAttachment),
    dueAt: r.dueAt.toISOString(),
    state: r.state,
    cancelReason: r.cancelReason,
    commentId: r.commentId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function loadMessage(db: Executor, id: string): Promise<ScheduledMessage> {
  const [row] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id));
  if (!row) throw notFound('Scheduled message');
  return (await serializeMessages(db, [row]))[0]!;
}

function emitMessage(db: Executor, after: AfterCommit, id: string): Promise<ScheduledMessage> {
  return loadMessage(db, id).then((message) => {
    after.emit(taskTopic(message.taskId), { type: 'scheduled_message.updated', message });
    return message;
  });
}

/** Pending messages by due time, then the most recent finished ones. */
export async function listMessages(db: Executor, taskId: string): Promise<ScheduledMessage[]> {
  const pending = await db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.state, 'pending')))
    .orderBy(asc(scheduledMessages.dueAt), asc(scheduledMessages.createdAt));
  const finished = await db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, taskId), ne(scheduledMessages.state, 'pending')))
    .orderBy(desc(scheduledMessages.updatedAt))
    .limit(SCHEDULED_MESSAGE_HISTORY);
  return serializeMessages(db, [...pending, ...finished]);
}

export async function createMessage(
  tx: Executor,
  after: AfterCommit,
  taskId: string,
  input: { body: string; internal: boolean; dueAt: string; attachments: NewAttachment[] },
  author: Actor,
): Promise<ScheduledMessage> {
  if (input.body.trim() === '' && input.attachments.length === 0) throw badRequest('A message needs a body or an attachment');
  const dueAt = assertDueAt(input.dueAt);
  await getTaskRow(tx, taskId, { lock: true });
  const [row] = await tx
    .insert(scheduledMessages)
    .values({ taskId, kind: 'user', authorId: author.id, body: input.body, internal: input.internal, dueAt })
    .returning();
  if (input.attachments.length > 0) {
    await tx.insert(attachments).values(input.attachments.map((a, position) => ({ ...a, position, scheduledMessageId: row!.id })));
  }
  return emitMessage(tx, after, row!.id);
}

/** Locks the message, after its Task: the lifecycle takes locks in that order too. */
async function lockPending(tx: Executor, id: string): Promise<Row> {
  const [peek] = await tx.select({ taskId: scheduledMessages.taskId }).from(scheduledMessages).where(eq(scheduledMessages.id, id));
  if (!peek) throw notFound('Scheduled message');
  await getTaskRow(tx, peek.taskId, { lock: true });
  const [row] = await tx.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)).for('update');
  if (!row) throw notFound('Scheduled message');
  if (row.state !== 'pending') throw conflict('This message is no longer scheduled');
  return row;
}

export async function updateMessage(
  tx: Executor,
  after: AfterCommit,
  id: string,
  patch: { body?: string; dueAt?: string },
): Promise<ScheduledMessage> {
  const row = await lockPending(tx, id);
  const set: Partial<Row> = { updatedAt: new Date() };
  if (patch.body !== undefined) {
    if (row.kind === 'limit_resume') throw badRequest('The text of an automatic resume cannot be changed');
    if (patch.body.trim() === '') {
      const [file] = await tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.scheduledMessageId, id)).limit(1);
      if (!file) throw badRequest('A message needs a body or an attachment');
    }
    set.body = patch.body;
  }
  if (patch.dueAt !== undefined) set.dueAt = assertDueAt(patch.dueAt);
  await tx.update(scheduledMessages).set(set).where(eq(scheduledMessages.id, id));
  return emitMessage(tx, after, id);
}

/** Cancels a pending message, removes its files and tells whoever watches the Task. */
async function cancelRow(tx: Executor, after: AfterCommit, row: Row, reason: string): Promise<void> {
  await tx
    .update(scheduledMessages)
    .set({ state: 'cancelled', cancelReason: reason, updatedAt: new Date() })
    .where(eq(scheduledMessages.id, row.id));
  if (row.kind === 'limit_resume') {
    const offers = await tx
      .update(limitResumeOffers)
      .set({ state: 'unneeded', decidedAt: new Date() })
      .where(and(eq(limitResumeOffers.scheduledMessageId, row.id), eq(limitResumeOffers.state, 'scheduled')))
      .returning({ id: limitResumeOffers.commentId });
    if (offers.length > 0) after.effect((ctx) => ctx.scheduler.publishComments(offers.map((o) => o.id)));
  }
  const removed = await tx.delete(attachments).where(eq(attachments.scheduledMessageId, row.id)).returning();
  for (const a of removed) after.run(() => after.ctx.blobs.delete(a.blobId));
  await emitMessage(tx, after, row.id);
}

export async function cancelMessage(tx: Executor, after: AfterCommit, id: string, reason: string): Promise<ScheduledMessage> {
  const row = await lockPending(tx, id);
  await cancelRow(tx, after, row, reason);
  return loadMessage(tx, id);
}

/** Publishes a pending message as a Comment now; `row` is locked by the caller. */
async function publishRow(tx: Executor, after: AfterCommit, row: Row): Promise<void> {
  const task = await getTaskRow(tx, row.taskId, { lock: true });
  let commentId: string;
  if (row.kind === 'limit_resume') {
    // An automatic resume for a Task nobody works on would only add noise.
    if (!task.agentId) return cancelRow(tx, after, row, 'No agent is assigned');
    if (await isClosedStatus(tx, task.statusId)) return cancelRow(tx, after, row, 'The task is closed');
    const [comment] = await tx
      .insert(comments)
      .values({
        taskId: task.id,
        kind: 'system',
        authorType: 'system',
        authorId: null,
        body: 'The usage limit was reset; resuming the work.',
        noticeMessage: LIMIT_RESUME_NOTICE,
        createdAt: sql`clock_timestamp()`,
      })
      .returning();
    await deliverComment(tx, after, { id: task.id }, comment!);
    after.effect((ctx) => ctx.scheduler.publishComments([comment!.id], 'created'));
    commentId = comment!.id;
  } else {
    const [author] = row.authorId ? await tx.select().from(users).where(eq(users.id, row.authorId)) : [];
    if (!author) return cancelRow(tx, after, row, 'The author no longer exists');
    const files = await tx.select().from(attachments).where(eq(attachments.scheduledMessageId, row.id)).orderBy(asc(attachments.position));
    // The files change owner: they move to the Comment, keeping their blobs.
    await tx.delete(attachments).where(eq(attachments.scheduledMessageId, row.id));
    const moved: NewAttachment[] = files.map((f) => ({ blobId: f.blobId, filename: f.filename, contentType: f.contentType, size: f.size }));
    const comment = await createUserComment(
      tx,
      after,
      task,
      { body: row.body, internal: row.internal, attachments: moved },
      { type: 'user', id: author.id, displayName: author.displayName },
    );
    commentId = comment.id;
  }
  await tx.update(scheduledMessages).set({ state: 'sent', commentId, updatedAt: new Date() }).where(eq(scheduledMessages.id, row.id));
  await emitMessage(tx, after, row.id);
}

export async function sendMessageNow(tx: Executor, after: AfterCommit, id: string): Promise<ScheduledMessage> {
  const row = await lockPending(tx, id);
  await publishRow(tx, after, row);
  return loadMessage(tx, id);
}

/** Publishes every message due at `now`, each in its own transaction. */
export async function runDueMessages(ctx: AppContext, now: Date): Promise<void> {
  const due = await ctx.db
    .select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.state, 'pending'), lte(scheduledMessages.dueAt, now)))
    .orderBy(asc(scheduledMessages.dueAt));
  for (const { id } of due) {
    try {
      await transact(ctx, async (tx, after) => {
        const [peek] = await tx.select({ taskId: scheduledMessages.taskId }).from(scheduledMessages).where(eq(scheduledMessages.id, id));
        if (!peek) return;
        await getTaskRow(tx, peek.taskId, { lock: true });
        const [row] = await tx.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)).for('update');
        if (row?.state === 'pending') await publishRow(tx, after, row);
      });
    } catch (err) {
      ctx.log.error({ err, scheduledMessageId: id }, 'scheduled message failed to publish');
    }
  }
  await closeExpiredOffers(ctx, now);
}

// ---- Limit Resume

/** The Task's Limit Resume is no longer needed: cancels the pending one and closes the open offers. */
export async function cancelLimitResumes(tx: Executor, after: AfterCommit, taskId: string, reason: string): Promise<void> {
  await cancelPendingResumes(tx, after, taskId, reason);
  await closeOpenOffers(tx, after, taskId);
}

async function cancelPendingResumes(tx: Executor, after: AfterCommit, taskId: string, reason: string): Promise<void> {
  const rows = await tx
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.kind, 'limit_resume'), eq(scheduledMessages.state, 'pending')))
    .for('update');
  for (const row of rows) await cancelRow(tx, after, row, reason);
}

/** Closes the open offers of the Task as no longer needed. */
async function closeOpenOffers(tx: Executor, after: AfterCommit, taskId: string): Promise<void> {
  const open = await tx
    .update(limitResumeOffers)
    .set({ state: 'unneeded', decidedAt: new Date() })
    .where(and(eq(limitResumeOffers.taskId, taskId), eq(limitResumeOffers.state, 'open')))
    .returning({ id: limitResumeOffers.commentId });
  if (open.length > 0) after.effect((ctx) => ctx.scheduler.publishComments(open.map((o) => o.id)));
}

async function closeExpiredOffers(ctx: AppContext, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RESUME_MARGIN_MS);
  const expired = await ctx.db
    .select({ id: limitResumeOffers.commentId })
    .from(limitResumeOffers)
    .where(and(eq(limitResumeOffers.state, 'open'), lte(limitResumeOffers.resetsAt, cutoff)));
  if (expired.length === 0) return;
  await ctx.db
    .update(limitResumeOffers)
    .set({ state: 'unneeded', decidedAt: now })
    .where(and(inArray(limitResumeOffers.commentId, expired.map((e) => e.id)), eq(limitResumeOffers.state, 'open')));
  await ctx.scheduler.publishComments(expired.map((e) => e.id));
}

/** A Limit Resume for the Task, replacing the pending one. */
async function createLimitResume(tx: Executor, after: AfterCommit, taskId: string, resetsAt: Date): Promise<string> {
  await cancelPendingResumes(tx, after, taskId, 'Replaced by a newer usage limit');
  const [row] = await tx
    .insert(scheduledMessages)
    .values({ taskId, kind: 'limit_resume', authorId: null, body: LIMIT_RESUME_NOTICE, internal: false, dueAt: new Date(resetsAt.getTime() + RESUME_MARGIN_MS) })
    .returning();
  await emitMessage(tx, after, row!.id);
  return row!.id;
}

/**
 * A Turn stopped at a usage limit that says when it resets: `commentId` is the System Comment that
 * reports it. Offers the resume, or schedules it right away when the Task resumes automatically.
 */
export async function offerLimitResume(tx: Executor, after: AfterCommit, taskId: string, commentId: string, resetsAt: Date): Promise<void> {
  // Called from a Job's event transaction: the Task row is read, not locked, to keep the lock order.
  const task = await getTaskRow(tx, taskId);
  await cancelLimitResumes(tx, after, taskId, 'Replaced by a newer usage limit');
  await tx.insert(limitResumeOffers).values({ commentId, taskId, resetsAt });
  if (task.autoResume && task.agentId && !(await isClosedStatus(tx, task.statusId))) {
    const scheduledMessageId = await createLimitResume(tx, after, taskId, resetsAt);
    await tx
      .update(limitResumeOffers)
      .set({ state: 'scheduled', decidedAt: new Date(), scheduledMessageId })
      .where(eq(limitResumeOffers.commentId, commentId));
  }
}

/** A Turn of the Task ended without error: a pending resume and any open offer are no longer needed. */
export async function onTurnWorked(tx: Executor, after: AfterCommit, taskId: string): Promise<void> {
  await cancelLimitResumes(tx, after, taskId, 'The agent worked again');
}

/** The first User to answer the offer decides for everyone. */
export async function answerLimitResume(tx: Executor, after: AfterCommit, commentId: string, schedule: boolean, by: Actor): Promise<void> {
  const [peek] = await tx.select({ taskId: limitResumeOffers.taskId }).from(limitResumeOffers).where(eq(limitResumeOffers.commentId, commentId));
  if (!peek) throw notFound('Usage limit offer');
  const task = await getTaskRow(tx, peek.taskId, { lock: true });
  const [offer] = await tx.select().from(limitResumeOffers).where(eq(limitResumeOffers.commentId, commentId)).for('update');
  if (!offer) throw notFound('Usage limit offer');
  if (offer.state === 'unneeded') throw conflict('This offer is no longer needed');
  if (offer.state !== 'open') {
    const [who] = offer.decidedBy ? await tx.select({ name: users.displayName }).from(users).where(eq(users.id, offer.decidedBy)) : [];
    throw conflict(who ? `${who.name} already answered` : 'This offer was already answered', { comment: await loadComment(tx, commentId) });
  }
  if (Date.now() >= offer.resetsAt.getTime() + RESUME_MARGIN_MS) {
    await tx.update(limitResumeOffers).set({ state: 'unneeded', decidedAt: new Date() }).where(eq(limitResumeOffers.commentId, commentId));
    after.effect((ctx) => ctx.scheduler.publishComments([commentId]));
    throw conflict('This offer is no longer needed');
  }
  let scheduledMessageId: string | null = null;
  if (schedule) {
    if (!task.agentId) throw conflict('No agent is assigned to this task');
    if (await isClosedStatus(tx, task.statusId)) throw conflict('The task is closed');
    scheduledMessageId = await createLimitResume(tx, after, task.id, offer.resetsAt);
  }
  await tx
    .update(limitResumeOffers)
    .set({ state: schedule ? 'scheduled' : 'declined', decidedBy: by.id, decidedAt: new Date(), scheduledMessageId })
    .where(eq(limitResumeOffers.commentId, commentId));
  after.effect((ctx) => ctx.scheduler.publishComments([commentId]));
}
