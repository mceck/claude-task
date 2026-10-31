import { API_PREFIX, CATEGORIES } from '@claude-task/shared';
import type { Category, CategoryCounts, Project, ProjectActivity, ProjectSummary } from '@claude-task/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { projects, statuses } from '../../db/schema';
import { forbidden, notFound } from '../../errors';
import { UUID } from '../../ids';
import { latestUnreadPosition } from '../../notifications/preferences';

export type ProjectRow = typeof projects.$inferSelect;

export const DEFAULT_STATUSES: { name: string; color: string; category: Category }[] = [
  { name: 'Backlog', color: '#94a3b8', category: 'backlog' },
  { name: 'Todo', color: '#64748b', category: 'open' },
  { name: 'In Progress', color: '#3b82f6', category: 'active' },
  { name: 'Ready for Review', color: '#a855f7', category: 'review' },
  { name: 'Done', color: '#22c55e', category: 'done' },
  { name: 'Closed', color: '#6b7280', category: 'closed' },
];

export function serializeProject(p: ProjectRow): Project {
  return {
    id: p.id,
    logoUrl: p.logoBlobId ? `${API_PREFIX}/projects/${p.id}/logo?v=${p.logoBlobId}` : null,
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

/** A Project as the Project, Status, Tag and Repository routes see it: Wiki and Schedule Projects are reached through their own APIs only. */
export async function getBoardProject(db: Executor, idOrKey: string, opts: { lock?: boolean } = {}): Promise<ProjectRow> {
  const row = await getProject(db, idOrKey, opts);
  if (row.kind !== 'project') throw notFound('Project');
  return row;
}

/** A Wiki's Backing Task changes only through the Wiki API (its name, description and Agent). */
export async function assertBoardTask(db: Executor, projectId: string): Promise<void> {
  const project = await getProject(db, projectId);
  if (project.kind === 'wiki') throw forbidden('This Task belongs to a Wiki: change it from the Wiki', 'wiki_task');
  if (project.kind === 'schedule') throw forbidden('This Task is a scheduled run: the scheduler manages it', 'schedule_task');
}

export async function createProject(
  db: Executor,
  input: Pick<ProjectRow, 'key' | 'name' | 'description'> & Partial<Pick<ProjectRow, 'repository' | 'defaultAgentId'>>,
): Promise<ProjectRow> {
  const [project] = await db.insert(projects).values(input).returning();
  await db
    .insert(statuses)
    .values(DEFAULT_STATUSES.map((s, position) => ({ ...s, position, projectId: project!.id })));
  return project!;
}

export async function listProjects(db: Executor, userId: string, archived: boolean): Promise<ProjectSummary[]> {
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
  const activity = await db.execute<{ project_id: string; running: number; unread: number }>(sql`
    select t.project_id,
      (select count(*)::int from sessions se where se.task_id = t.id and se.state = 'running') as running,
      (coalesce(a.latest, 0) > coalesce(p.read_position, 0) and not coalesce(p.muted, false) and s.category <> 'closed') as unread
    from tasks t join statuses s on s.id = t.status_id
    left join task_preferences p on p.task_id = t.id and p.user_id = ${userId}::uuid
    left join lateral (select ${latestUnreadPosition(userId)} as latest) a on true`);
  const activityByProject = new Map<string, ProjectActivity>();
  for (const r of activity.rows) {
    let entry = activityByProject.get(r.project_id);
    if (!entry) activityByProject.set(r.project_id, (entry = { runningAgents: 0, unreadTasks: 0 }));
    entry.runningAgents += r.running;
    if (r.unread) entry.unreadTasks += 1;
  }
  return rows.map((p) => ({
    ...serializeProject(p),
    taskCounts: byProject.get(p.id) ?? emptyCounts(),
    activity: activityByProject.get(p.id) ?? { runningAgents: 0, unreadTasks: 0 },
  }));
}

function emptyCounts(): CategoryCounts {
  return Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as CategoryCounts;
}
