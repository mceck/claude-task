import { projectTopic } from '@claude-task/shared';
import type { Tag } from '@claude-task/shared';
import { asc, eq } from 'drizzle-orm';
import type { AfterCommit } from '../../context';
import type { Executor } from '../../db/client';
import { tags } from '../../db/schema';
import { notFound } from '../../errors';

export type TagRow = typeof tags.$inferSelect;

export function serializeTag(l: TagRow): Tag {
  return { id: l.id, projectId: l.projectId, name: l.name, color: l.color };
}

export async function listTags(db: Executor, projectId: string): Promise<Tag[]> {
  const rows = await db.select().from(tags).where(eq(tags.projectId, projectId)).orderBy(asc(tags.name));
  return rows.map(serializeTag);
}

export async function getTag(db: Executor, id: string): Promise<TagRow> {
  const [row] = await db.select().from(tags).where(eq(tags.id, id));
  if (!row) throw notFound('Tag');
  return row;
}

export async function emitTagsChanged(db: Executor, after: AfterCommit, projectId: string): Promise<void> {
  after.emit(projectTopic(projectId), { type: 'tags.changed', projectId, tags: await listTags(db, projectId) });
}
