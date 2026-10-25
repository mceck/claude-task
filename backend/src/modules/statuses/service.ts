import { projectTopic } from '@claude-task/shared';
import type { Category, Status } from '@claude-task/shared';
import { asc, eq } from 'drizzle-orm';
import type { AfterCommit } from '../../context';
import type { Executor } from '../../db/client';
import { statuses } from '../../db/schema';
import { badRequest, notFound } from '../../errors';

export type StatusRow = typeof statuses.$inferSelect;

export function serializeStatus(s: StatusRow): Status {
  return { id: s.id, projectId: s.projectId, name: s.name, color: s.color, category: s.category, position: s.position };
}

export async function listStatuses(db: Executor, projectId: string): Promise<Status[]> {
  const rows = await db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, projectId))
    .orderBy(asc(statuses.position), asc(statuses.id));
  return rows.map(serializeStatus);
}

export async function getStatus(db: Executor, id: string): Promise<StatusRow> {
  const [row] = await db.select().from(statuses).where(eq(statuses.id, id));
  if (!row) throw notFound('Status');
  return row;
}

/** A Project always needs an entry point (`open`) and an exit (`closed`). */
export function assertEntryAndExit(categories: Category[]): void {
  for (const required of ['open', 'closed'] as const) {
    if (!categories.includes(required)) {
      throw badRequest(`A project needs at least one "${required}" status`);
    }
  }
}

export async function emitStatusesChanged(db: Executor, after: AfterCommit, projectId: string): Promise<Status[]> {
  const list = await listStatuses(db, projectId);
  after.emit(projectTopic(projectId), { type: 'statuses.changed', projectId, statuses: list });
  return list;
}
