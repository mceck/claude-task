import { projectTopic } from '@claude-task/shared';
import type { Label } from '@claude-task/shared';
import { asc, eq } from 'drizzle-orm';
import type { AfterCommit } from '../../context';
import type { Executor } from '../../db/client';
import { labels } from '../../db/schema';
import { notFound } from '../../errors';

export type LabelRow = typeof labels.$inferSelect;

export function serializeLabel(l: LabelRow): Label {
  return { id: l.id, projectId: l.projectId, name: l.name, color: l.color };
}

export async function listLabels(db: Executor, projectId: string): Promise<Label[]> {
  const rows = await db.select().from(labels).where(eq(labels.projectId, projectId)).orderBy(asc(labels.name));
  return rows.map(serializeLabel);
}

export async function getLabel(db: Executor, id: string): Promise<LabelRow> {
  const [row] = await db.select().from(labels).where(eq(labels.id, id));
  if (!row) throw notFound('Label');
  return row;
}

export async function emitLabelsChanged(db: Executor, after: AfterCommit, projectId: string): Promise<void> {
  after.emit(projectTopic(projectId), { type: 'labels.changed', projectId, labels: await listLabels(db, projectId) });
}
