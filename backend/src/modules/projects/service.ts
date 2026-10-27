import { CATEGORIES } from '@claude-task/shared';
import type { Category, CategoryCounts, Project, ProjectSummary } from '@claude-task/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { projects, statuses } from '../../db/schema';
import { forbidden, notFound } from '../../errors';
import { UUID } from '../../ids';

export type ProjectRow = typeof projects.$inferSelect;

export const DEFAULT_STATUSES: { name: string; color: string; category: Category }[] = [
  { name: 'Backlog', color: '#94a3b8', category: 'open' },
  { name: 'Todo', color: '#64748b', category: 'open' },
  { name: 'In Progress', color: '#3b82f6', category: 'active' },
  { name: 'Ready for Review', color: '#a855f7', category: 'review' },
  { name: 'Done', color: '#22c55e', category: 'done' },
  { name: 'Closed', color: '#6b7280', category: 'closed' },
];

export function serializeProject(p: ProjectRow): Project {
  return {
    id: p.id,
    key: p.key,
    repository: p.repository,
    name: p.name,
    description: p.description,
    archivedAt: p.archivedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}


/** Projects are addressable by id or by key (for readable URLs). */
export async function getProject(db: Executor, idOrKey: string, opts: { lock?: boolean } = {}): Promise<ProjectRow> {
  const where = UUID.test(idOrKey) ? eq(projects.id, idOrKey) : eq(projects.key, idOrKey.toUpperCase());
  const query = db.select().from(projects).where(where);
  const [row] = await (opts.lock ? query.for('update') : query);
  if (!row) throw notFound('Project');
  return row;
}

/** A Project as the Project, Status, Tag and Repository routes see it: Wiki Projects are reached through the Wiki API only. */
export async function getBoardProject(db: Executor, idOrKey: string, opts: { lock?: boolean } = {}): Promise<ProjectRow> {
  const row = await getProject(db, idOrKey, opts);
  if (row.kind === 'wiki') throw notFound('Project');
  return row;
}

/** A Wiki's Backing Task changes only through the Wiki API (its name, description and Agent). */
export async function assertBoardTask(db: Executor, projectId: string): Promise<void> {
  const project = await getProject(db, projectId);
  if (project.kind === 'wiki') throw forbidden('This Task belongs to a Wiki: change it from the Wiki', 'wiki_task');
}

export async function createProject(
  db: Executor,
  input: { key: string; name: string; description: string },
): Promise<ProjectRow> {
  const [project] = await db.insert(projects).values(input).returning();
  await db
    .insert(statuses)
    .values(DEFAULT_STATUSES.map((s, position) => ({ ...s, position, projectId: project!.id })));
  return project!;
}

export async function listProjects(db: Executor, archived: boolean): Promise<ProjectSummary[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.kind, 'project'), archived ? sql`${projects.archivedAt} is not null` : sql`${projects.archivedAt} is null`))
    .orderBy(projects.name);
  const counts = await db.execute<{ project_id: string; category: Category; n: number }>(sql`
    select t.project_id, s.category, count(*)::int as n
    from tasks t join statuses s on s.id = t.status_id
    group by t.project_id, s.category`);
  const byProject = new Map<string, CategoryCounts>();
  for (const c of counts.rows) {
    let entry = byProject.get(c.project_id);
    if (!entry) byProject.set(c.project_id, (entry = emptyCounts()));
    entry[c.category] = c.n;
  }
  return rows.map((p) => ({ ...serializeProject(p), taskCounts: byProject.get(p.id) ?? emptyCounts() }));
}

function emptyCounts(): CategoryCounts {
  return Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as CategoryCounts;
}
