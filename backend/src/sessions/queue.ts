// An Agent's Queue: one entry per Task, ordered by fractional position. Callers hold the
// Agent's row lock, which serializes every change to its Queue.
import type { QueueEntry, QueueEntryKind } from '@claude-task/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { AfterCommit } from '../context';
import type { Executor } from '../db/client';
import { comments, queueEntries } from '../db/schema';
import { taskRefs } from '../modules/agents/service';

export type EntryRow = typeof queueEntries.$inferSelect;

/** `resume_interrupted` and `start` outrank `messages` when entries merge. */
const KIND_RANK: Record<QueueEntryKind, number> = { messages: 0, resume_interrupted: 1, start: 2 };

export async function getEntry(db: Executor, agentId: string, taskId: string, lock = false): Promise<EntryRow | null> {
  const query = db
    .select()
    .from(queueEntries)
    .where(and(eq(queueEntries.agentId, agentId), eq(queueEntries.taskId, taskId)));
  const [row] = await (lock ? query.for('update') : query);
  return row ?? null;
}

async function edgePosition(db: Executor, agentId: string, edge: 'first' | 'last'): Promise<string | null> {
  const [row] = await db
    .select({ position: queueEntries.position })
    .from(queueEntries)
    .where(eq(queueEntries.agentId, agentId))
    .orderBy(edge === 'first' ? asc(queueEntries.position) : sql`${queueEntries.position} desc`)
    .limit(1);
  return row?.position ?? null;
}

/**
 * Adds the Task to the Agent's Queue, or merges into its existing entry, which keeps its
 * position unless `front` asks to move it to the front.
 */
export async function enqueue(
  tx: Executor,
  after: AfterCommit,
  input: { agentId: string; taskId: string; sessionId: string; kind: QueueEntryKind; front?: boolean; held?: boolean },
): Promise<EntryRow> {
  const existing = await getEntry(tx, input.agentId, input.taskId, true);
  after.effect((ctx) => {
    ctx.scheduler.publishQueue(input.agentId, [input.taskId]);
    ctx.scheduler.kick(input.agentId);
  });
  if (existing) {
    const kind = KIND_RANK[input.kind] > KIND_RANK[existing.kind] ? input.kind : existing.kind;
    const position = input.front ? generateKeyBetween(null, await edgePosition(tx, input.agentId, 'first')) : existing.position;
    const [row] = await tx
      .update(queueEntries)
      .set({ kind, position, held: input.held ?? existing.held })
      .where(eq(queueEntries.id, existing.id))
      .returning();
    return row!;
  }
  const position = input.front
    ? generateKeyBetween(null, await edgePosition(tx, input.agentId, 'first'))
    : generateKeyBetween(await edgePosition(tx, input.agentId, 'last'), null);
  const [row] = await tx
    .insert(queueEntries)
    .values({ agentId: input.agentId, taskId: input.taskId, sessionId: input.sessionId, kind: input.kind, position, held: input.held ?? false })
    .returning();
  return row!;
}

/** Links Comments to the entry; Users' Comments (and notices) become `queued`. */
export async function attachComments(tx: Executor, after: AfterCommit, entryId: string, commentIds: string[]): Promise<void> {
  if (commentIds.length === 0) return;
  await tx
    .update(comments)
    .set({
      queueEntryId: entryId,
      deliveryState: sql`case when ${comments.kind} = 'user' or ${comments.noticeMessage} is not null then 'queued'::delivery_state else ${comments.deliveryState} end`,
      deliveryReason: null,
      deliveredInJobId: null,
    })
    .where(inArray(comments.id, commentIds));
  after.effect((ctx) => ctx.scheduler.publishComments(commentIds));
}

/** Drops the entry; its undelivered Comments become `not_delivered` with the reason. */
export async function removeEntry(tx: Executor, after: AfterCommit, entry: EntryRow, reason: string): Promise<void> {
  await markNotDelivered(tx, after, entry.id, reason);
  await tx.delete(queueEntries).where(eq(queueEntries.id, entry.id));
  after.effect((ctx) => ctx.scheduler.publishQueue(entry.agentId, [entry.taskId]));
}

async function markNotDelivered(tx: Executor, after: AfterCommit, entryId: string, reason: string): Promise<void> {
  const changed = await tx
    .update(comments)
    .set({
      queueEntryId: null,
      deliveryState: sql`case when ${comments.deliveryState} = 'queued' then 'not_delivered'::delivery_state else ${comments.deliveryState} end`,
      deliveryReason: sql`case when ${comments.deliveryState} = 'queued' then ${reason} else ${comments.deliveryReason} end`,
    })
    .where(eq(comments.queueEntryId, entryId))
    .returning({ id: comments.id });
  if (changed.length > 0) after.effect((ctx) => ctx.scheduler.publishComments(changed.map((c) => c.id)));
}

/** The Agent's Queue in order, with pending Message counts. */
export async function loadQueue(db: Executor, agentId: string): Promise<QueueEntry[]> {
  const rows = await db
    .select({
      entry: queueEntries,
      pending: sql<number>`(select count(*)::int from comments c where c.queue_entry_id = queue_entries.id and c.deleted_at is null)`,
    })
    .from(queueEntries)
    .where(eq(queueEntries.agentId, agentId))
    .orderBy(asc(queueEntries.position), asc(queueEntries.id));
  const refs = await taskRefs(db, rows.map((r) => r.entry.taskId));
  return rows.map(({ entry, pending }) => ({
    id: entry.id,
    agentId: entry.agentId,
    task: refs.get(entry.taskId)!,
    kind: entry.kind,
    position: entry.position,
    held: entry.held,
    pendingMessages: pending,
    enqueuedAt: entry.enqueuedAt.toISOString(),
  }));
}

/** Moves an entry below `afterEntryId` or above `beforeEntryId`; neither means the end. */
export async function moveEntry(
  tx: Executor,
  after: AfterCommit,
  entry: EntryRow,
  input: { afterEntryId?: string | null; beforeEntryId?: string | null },
): Promise<void> {
  const others = (
    await tx
      .select({ id: queueEntries.id, position: queueEntries.position })
      .from(queueEntries)
      .where(eq(queueEntries.agentId, entry.agentId))
      .orderBy(asc(queueEntries.position), asc(queueEntries.id))
  ).filter((e) => e.id !== entry.id);
  let slot = others.length;
  const afterIdx = input.afterEntryId ? others.findIndex((e) => e.id === input.afterEntryId) : -1;
  const beforeIdx = input.beforeEntryId ? others.findIndex((e) => e.id === input.beforeEntryId) : -1;
  if (afterIdx >= 0) slot = afterIdx + 1;
  else if (beforeIdx >= 0) slot = beforeIdx;
  else if (input.afterEntryId === null && input.beforeEntryId === undefined) slot = 0;
  const lower = others[slot - 1]?.position ?? null;
  const upper = others[slot]?.position ?? null;
  let position: string;
  if (lower !== null && upper !== null && lower >= upper) {
    // Equal keys leave no room: respace the whole Queue.
    const keys = generateNKeysBetween(null, null, others.length + 1);
    for (const [i, e] of others.entries()) {
      await tx.update(queueEntries).set({ position: keys[i < slot ? i : i + 1]! }).where(eq(queueEntries.id, e.id));
    }
    position = keys[slot]!;
  } else {
    position = generateKeyBetween(lower, upper);
  }
  await tx.update(queueEntries).set({ position }).where(eq(queueEntries.id, entry.id));
  after.effect((ctx) => ctx.scheduler.publishQueue(entry.agentId, []));
}
