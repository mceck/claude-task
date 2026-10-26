// Notify agent: tells the Agent which fields Users changed since it last read its Task.
import type { Actor } from '@claude-task/shared';
import { createTwoFilesPatch } from 'diff';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { AfterCommit } from '../context';
import type { Executor } from '../db/client';
import { comments, tags, sessions, taskRevisions } from '../db/schema';
import { conflict } from '../errors';
import { actorResolver } from '../modules/actors';
import { getTaskRow } from '../modules/tasks/service';
import { deliverComment } from './lifecycle';
import { NOTIFIABLE_FIELDS } from './view';

const FIELD_NAMES: Record<string, string> = { title: 'Title', description: 'Description', priority: 'Priority', tagIds: 'Tags' };

/** Field-by-field changes made by Users after `sinceVersion` (first `before`, last `after`), or null. */
export async function describeUnseenChanges(db: Executor, taskId: string, sinceVersion: number): Promise<{ text: string; version: number } | null> {
  const revisions = await db
    .select()
    .from(taskRevisions)
    .where(and(eq(taskRevisions.taskId, taskId), gt(taskRevisions.version, sinceVersion)))
    .orderBy(asc(taskRevisions.version));
  const fields = new Map<string, { before: unknown; after: unknown }>();
  const editors = new Set<string>();
  for (const r of revisions) {
    if (r.actorType !== 'user') continue;
    for (const c of r.changes) {
      if (!(NOTIFIABLE_FIELDS as readonly string[]).includes(c.field)) continue;
      const seen = fields.get(c.field);
      fields.set(c.field, { before: seen ? seen.before : c.before, after: c.after });
      if (r.actorId) editors.add(r.actorId);
    }
  }
  const changed = [...fields].filter(([, v]) => JSON.stringify(v.before) !== JSON.stringify(v.after));
  if (changed.length === 0) return null;

  const resolve = await actorResolver(db, [...editors].map((id) => ({ type: 'user' as const, id })));
  const tagIds = changed.filter(([f]) => f === 'tagIds').flatMap(([, v]) => [...(v.before as string[]), ...(v.after as string[])]);
  const tagRows = tagIds.length ? await db.select().from(tags).where(inArray(tags.id, tagIds)) : [];
  const tagName = (id: string) => tagRows.find((l) => l.id === id)?.name ?? '(deleted tag)';

  const lines = [`[Task changes by ${[...editors].map((id) => resolve({ type: 'user', id }).displayName).join(', ')} since you last read the task]`];
  for (const [field, { before, after }] of changed) {
    if (field === 'description') {
      const patch = createTwoFilesPatch('description', 'description', String(before), String(after), 'before', 'after', { context: 3 });
      lines.push('Description:', '```diff', patch.split('\n').slice(2).join('\n').trimEnd(), '```');
    } else if (field === 'tagIds') {
      const b = before as string[];
      const a = after as string[];
      const added = a.filter((x) => !b.includes(x)).map(tagName);
      const removed = b.filter((x) => !a.includes(x)).map(tagName);
      lines.push(`Tags: ${[added.length && `added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean).join('; ')}`);
    } else {
      lines.push(`${FIELD_NAMES[field]}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
  }
  const version = revisions[revisions.length - 1]!.version;
  return { text: lines.join('\n'), version };
}

/** Posts the "Agent notified" system Comment and delivers its change list like a Comment. */
export async function notifyAgent(tx: Executor, after: AfterCommit, taskId: string, by: Actor): Promise<void> {
  const task = await getTaskRow(tx, taskId);
  if (!task.agentId || !task.currentSessionId) throw conflict('No agent is assigned to this task');
  const [session] = await tx.select().from(sessions).where(eq(sessions.id, task.currentSessionId));
  if (!session || !['idle', 'running'].includes(session.state)) throw conflict('The agent has nothing to be notified about yet');
  const changes = await describeUnseenChanges(tx, task.id, session.lastSeenTaskVersion);
  if (!changes) throw conflict('The agent has already seen every change');
  const [row] = await tx
    .insert(comments)
    .values({
      taskId: task.id,
      kind: 'system',
      authorType: 'system',
      authorId: null,
      body: `${by.displayName} notified the agent of task changes.`,
      noticeMessage: changes.text,
      noticeTaskVersion: changes.version,
      createdAt: sql`clock_timestamp()`,
    })
    .returning();
  await deliverComment(tx, after, { id: task.id }, row!);
  after.effect((ctx) => ctx.scheduler.publishComments([row!.id], 'created'));
}

