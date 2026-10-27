import { autoFollow } from '../../notifications/preferences';
import { projectTopic, taskKey, taskTopic } from '@claude-task/shared';
import type {
  Actor,
  BoardFilter,
  Priority,
  Revision,
  RevisionChange,
  RevisionField,
  SessionState,
  Task,
  TaskCard,
} from '@claude-task/shared';
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { AfterCommit } from '../../context';
import type { Executor } from '../../db/client';
import { agents, jobs, tags, projects, statuses, taskAssignees, taskTags, taskRevisions, tasks, users } from '../../db/schema';
import { onTaskChanged, removeDeletedWorktrees } from '../../sessions/lifecycle';
import { badRequest, conflict, notFound } from '../../errors';
import { actorResolver } from '../actors';
import { UUID } from '../../ids';
import { ACTIVE_JOB_STATES } from '../agents/service';

export type TaskRow = typeof tasks.$inferSelect;

const TASK_KEY = /^([A-Za-z]{2,6})-(\d{1,9})$/;

// Reading

interface CardRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  project_key: string;
  number: number;
  title: string;
  status_id: string;
  priority: Priority;
  position: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  tag_ids: string[];
  assignee_ids: string[];
  comment_count: number;
  chat_generation: number;
  agent_id: string | null;
  session_agent_id: string | null;
  session_state: SessionState | null;
  queue_position: number | null;
  branch_name: string | null;
  branch_url: string | null;
  pull_request: TaskCard['pullRequest'];
}

export interface CardQuery {
  projectId?: string;
  taskIds?: string[];
  filter?: BoardFilter;
  includeClosed?: boolean;
}

/** The Board projection of Tasks, in Board order (status, then position). */
export async function loadCards(db: Executor, q: CardQuery): Promise<TaskCard[]> {
  const where: SQL[] = [];
  if (q.taskIds) {
    if (q.taskIds.length === 0) return [];
    where.push(sql`t.id in (${sql.join(q.taskIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  if (q.projectId) where.push(sql`t.project_id = ${q.projectId}`);
  if (q.includeClosed === false) where.push(sql`s.category <> 'closed'`);
  const f = q.filter;
  if (f) {
    if (f.assignees.length > 0) {
      const ids = f.assignees.filter((a) => a !== 'none');
      const any: SQL[] = [];
      if (ids.length > 0) {
        any.push(sql`exists (select 1 from task_assignees ta where ta.task_id = t.id
          and ta.user_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}))`);
      }
      if (f.assignees.includes('none')) {
        any.push(sql`not exists (select 1 from task_assignees ta where ta.task_id = t.id)`);
      }
      where.push(sql`(${sql.join(any, sql` or `)})`);
    }
    if (f.tags.length > 0) {
      where.push(sql`exists (select 1 from task_tags tl where tl.task_id = t.id
        and tl.tag_id in (${sql.join(f.tags.map((id) => sql`${id}::uuid`), sql`, `)}))`);
    }
    if (f.priorities.length > 0) {
      where.push(sql`t.priority in (${sql.join(f.priorities.map((p) => sql`${p}::priority`), sql`, `)})`);
    }
    const text = f.text.trim();
    if (text !== '') {
      const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(sql`(t.title ilike ${pattern} or (p.key || '-' || t.number) ilike ${pattern})`);
    }
  }

  const result = await db.execute<CardRow>(sql`
    select t.id, t.project_id, p.key as project_key, t.number, t.title, t.status_id, t.priority,
      t.position, t.version, t.chat_generation, t.created_at, t.updated_at,
      coalesce((select array_agg(tl.tag_id::text order by l.name, l.id)
        from task_tags tl join tags l on l.id = tl.tag_id where tl.task_id = t.id), '{}') as tag_ids,
      coalesce((select array_agg(ta.user_id::text order by ta.user_id)
        from task_assignees ta where ta.task_id = t.id), '{}') as assignee_ids,
      (select count(*)::int from comments c where c.task_id = t.id and c.deleted_at is null) as comment_count,
      t.branch_name, t.branch_url, t.pull_request, t.agent_id, ss.agent_id as session_agent_id, ss.state as session_state,
      (select count(*)::int from queue_entries q join queue_entries q2 on q2.agent_id = q.agent_id and q2.position <= q.position
        where q.task_id = t.id and q.agent_id = ss.agent_id) as queue_position
    from tasks t
    join projects p on p.id = t.project_id
    join statuses s on s.id = t.status_id
    left join sessions ss on ss.id = t.current_session_id
    ${where.length > 0 ? sql`where ${sql.join(where, sql` and `)}` : sql``}
    order by s.position, t.position, t.id`);

  return result.rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    key: taskKey(r.project_key, r.number),
    number: r.number,
    title: r.title,
    statusId: r.status_id,
    priority: r.priority,
    position: r.position,
    tagIds: r.tag_ids,
    assigneeIds: r.assignee_ids,
    commentCount: r.comment_count,
    chatGeneration: r.chat_generation,
    branchName: r.branch_name,
    branchUrl: r.branch_url,
    pullRequest: r.pull_request,
    agentId: r.agent_id,
    session:
      r.agent_id && r.session_agent_id === r.agent_id && r.session_state
        ? { agentId: r.agent_id, state: r.session_state, queuePosition: r.queue_position || null }
        : null,
    version: r.version,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function loadCard(db: Executor, taskId: string): Promise<TaskCard> {
  const [card] = await loadCards(db, { taskIds: [taskId] });
  if (!card) throw notFound('Task');
  return card;
}

/** Full Tasks in Board order, with one projection query and one actor lookup for the batch. */
export async function loadTasks(db: Executor, taskIds: string[]): Promise<Task[]> {
  const cards = await loadCards(db, { taskIds });
  if (cards.length === 0) return [];
  const rows = await db
    .select({ id: tasks.id, description: tasks.description, createdByType: tasks.createdByType, createdById: tasks.createdById })
    .from(tasks)
    .where(inArray(tasks.id, cards.map((c) => c.id)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolve = await actorResolver(db, rows.map((r) => ({ type: r.createdByType, id: r.createdById })));
  return cards.map((card) => {
    const r = byId.get(card.id)!;
    return { ...card, description: r.description, createdBy: resolve({ type: r.createdByType, id: r.createdById }) };
  });
}

export async function loadTask(db: Executor, taskId: string): Promise<Task> {
  const [task] = await loadTasks(db, [taskId]);
  if (!task) throw notFound('Task');
  return task;
}

/** The Board projection of a full Task. */
export function cardOf(task: Task): TaskCard {
  const { description: _d, createdBy: _c, ...card } = task;
  return card;
}

/**
 * Locks a Task for writing. The project row is locked first (shared), the same order status
 * deletion uses (exclusive), so edits wait for a status deletion instead of racing it.
 */
async function lockTaskForWrite(tx: Executor, idOrKey: string): Promise<TaskRow> {
  const found = await getTaskRow(tx, idOrKey);
  await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, found.projectId)).for('share');
  return getTaskRow(tx, found.id, { lock: true });
}

/** Tasks are addressable by id or by Task Key (`API-42`). */
export async function getTaskRow(db: Executor, idOrKey: string, opts: { lock?: boolean } = {}): Promise<TaskRow> {
  let where: SQL;
  if (UUID.test(idOrKey)) {
    where = eq(tasks.id, idOrKey);
  } else {
    const m = TASK_KEY.exec(idOrKey);
    if (!m) throw notFound('Task');
    const project = db.select({ id: projects.id }).from(projects).where(eq(projects.key, m[1]!.toUpperCase()));
    where = and(inArray(tasks.projectId, project), eq(tasks.number, Number(m[2])))!;
  }
  const query = db.select().from(tasks).where(where);
  const [row] = await (opts.lock ? query.for('update', { of: tasks }) : query);
  if (!row) throw notFound('Task');
  return row;
}

// Writing

export interface CreateTaskInput {
  title: string;
  statusId?: string;
  description: string;
  priority: Priority;
  tagIds: string[];
  assigneeIds: string[];
}

export async function createTask(
  tx: Executor,
  after: AfterCommit,
  projectId: string,
  input: CreateTaskInput,
  actor: Actor,
): Promise<Task> {
  // The row lock taken here also serializes task creation within the project.
  const [numbered] = await tx
    .update(projects)
    .set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ number: sql<number>`${projects.nextTaskNumber} - 1` });
  if (!numbered) throw notFound('Project');

  const statusId = input.statusId ?? (await firstOpenStatus(tx, projectId));
  await assertStatusInProject(tx, statusId, projectId);
  const tagIds = await validTags(tx, projectId, input.tagIds);
  const assigneeIds = await validAssignees(tx, input.assigneeIds);

  const [task] = await tx
    .insert(tasks)
    .values({
      projectId,
      number: numbered.number,
      title: input.title,
      description: input.description,
      statusId,
      priority: input.priority,
      position: await endOfColumn(tx, statusId),
      createdByType: actor.type,
      createdById: actor.id,
    })
    .returning();
  await setTags(tx, task!.id, tagIds);
  await setAssignees(tx, task!.id, assigneeIds);
  await assignDefaultAgent(tx, after, projectId, task!.id);

  await autoFollow(tx, after, task!.id, [...assigneeIds, ...(actor.type === 'user' && actor.id ? [actor.id] : [])]);
  const created = await loadTask(tx, task!.id);
  after.emit(projectTopic(projectId), { type: 'task.created', task: cardOf(created) });
  return created;
}

/** A new Task starts with the Project's default Agent when it still exists and is enabled; otherwise it has none. */
async function assignDefaultAgent(tx: Executor, after: AfterCommit, projectId: string, taskId: string): Promise<void> {
  const [project] = await tx.select({ defaultAgentId: projects.defaultAgentId }).from(projects).where(eq(projects.id, projectId));
  if (!project?.defaultAgentId) return;
  const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, project.defaultAgentId), eq(agents.enabled, true)));
  if (!agent) return;
  await tx.update(tasks).set({ agentId: agent.id }).where(eq(tasks.id, taskId));
  await onTaskChanged(tx, after, await getTaskRow(tx, taskId), { agentId: null, statusId: (await getTaskRow(tx, taskId)).statusId });
}

export interface UpdateTaskInput {
  version: number;
  title?: string;
  description?: string;
  statusId?: string;
  priority?: Priority;
  tagIds?: string[];
  assigneeIds?: string[];
  agentId?: string | null;
}

/**
 * Applies a patch made against `input.version`. If a field the patch touches has
 * changed since that version, nothing is written and the current Task comes back in a 409.
 */
export async function updateTask(
  tx: Executor,
  after: AfterCommit,
  taskId: string,
  input: UpdateTaskInput,
  actor: Actor,
): Promise<Task> {
  const row = await lockTaskForWrite(tx, taskId);
  const { version, ...patch } = input;
  const touched = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== undefined);

  if (version !== row.version) {
    const changedSince = await fieldsChangedSince(tx, row.id, version);
    if (version > row.version || touched.some((f) => changedSince.has(f))) {
      throw conflict('The task was changed by someone else', { task: await loadTask(tx, row.id) });
    }
  }

  const current = await currentFields(tx, row);
  const next: typeof current = { ...current };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.statusId !== undefined) {
    await assertStatusInProject(tx, patch.statusId, row.projectId);
    next.statusId = patch.statusId;
  }
  if (patch.tagIds !== undefined) next.tagIds = await validTags(tx, row.projectId, patch.tagIds);
  if (patch.assigneeIds !== undefined) next.assigneeIds = await validAssignees(tx, patch.assigneeIds);
  if (patch.agentId !== undefined) next.agentId = patch.agentId === null ? null : await validAgent(tx, patch.agentId);

  const changes = diff(current, next);
  if (changes.length === 0) return loadTask(tx, row.id);

  const changed = new Set(changes.map((c) => c.field));
  await tx
    .update(tasks)
    .set({
      title: next.title,
      description: next.description,
      priority: next.priority,
      statusId: next.statusId,
      agentId: next.agentId,
      ...(changed.has('statusId') ? { position: await endOfColumn(tx, next.statusId) } : {}),
      version: row.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, row.id));
  if (changed.has('tagIds')) await setTags(tx, row.id, next.tagIds);
  if (changed.has('assigneeIds')) {
    await setAssignees(tx, row.id, next.assigneeIds);
    await autoFollow(tx, after, row.id, next.assigneeIds.filter((id) => !current.assigneeIds.includes(id)));
  }
  await recordRevisions(tx, after, actor, [{ taskId: row.id, version: row.version + 1, changes }]);
  if (changed.has('agentId') || changed.has('statusId')) {
    await onTaskChanged(tx, after, await getTaskRow(tx, row.id), { agentId: row.agentId, statusId: row.statusId });
  }

  const [task] = await emitTasksChanged(tx, after, [row.id], 'task.updated');
  return task!;
}

export interface MoveTaskInput {
  statusId: string;
  /** The Task that ends up directly above. */
  afterTaskId?: string | null;
  /** The Task that ends up directly below. */
  beforeTaskId?: string | null;
}

/** Changes status and/or position. Moves never conflict: last write wins. */
export async function moveTask(
  tx: Executor,
  after: AfterCommit,
  taskId: string,
  input: MoveTaskInput,
  actor: Actor,
): Promise<Task> {
  const row = await lockTaskForWrite(tx, taskId);
  await assertStatusInProject(tx, input.statusId, row.projectId);
  const { position, respaced } = await positionBetween(tx, row.id, input);
  const statusChanged = input.statusId !== row.statusId;

  await tx
    .update(tasks)
    .set({
      statusId: input.statusId,
      position,
      ...(statusChanged ? { version: row.version + 1, updatedAt: new Date() } : {}),
    })
    .where(eq(tasks.id, row.id));

  for (const card of await loadCards(tx, { taskIds: respaced })) {
    after.emit(projectTopic(row.projectId), { type: 'task.moved', task: card });
  }
  if (!statusChanged) {
    after.emit(projectTopic(row.projectId), { type: 'task.moved', task: await loadCard(tx, row.id) });
    return loadTask(tx, row.id);
  }
  await recordRevisions(tx, after, actor, [
    { taskId: row.id, version: row.version + 1, changes: [{ field: 'statusId', before: row.statusId, after: input.statusId }] },
  ]);
  await onTaskChanged(tx, after, await getTaskRow(tx, row.id), { agentId: row.agentId, statusId: row.statusId });
  const [task] = await emitTasksChanged(tx, after, [row.id], 'task.moved');
  return task!;
}

/**
 * Tasks an Agent is working on can't be deleted: the Job's row would go while `claude` keeps
 * running with the Task's secrets, and the Runner would refuse the Agent's next Jobs. Lock the
 * Tasks first (a dispatch takes a key share lock on its Task).
 */
export async function assertNoActiveJobs(tx: Executor, where: SQL): Promise<void> {
  const [active] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(where, inArray(jobs.state, [...ACTIVE_JOB_STATES])))
    .limit(1);
  if (active) throw conflict('An agent is working on this. Stop it, or close the task, before deleting.');
}

export async function deleteTask(tx: Executor, after: AfterCommit, taskId: string): Promise<{ blobIds: string[] }> {
  const row = await getTaskRow(tx, taskId, { lock: true });
  await assertNoActiveJobs(tx, eq(tasks.id, row.id));
  await removeDeletedWorktrees(tx, after, [row.id]);
  const blobs = await tx.execute<{ blob_id: string }>(sql`
    select a.blob_id from attachments a left join comments c on c.id = a.comment_id where coalesce(a.task_id, c.task_id) = ${row.id}`);
  await tx.delete(tasks).where(eq(tasks.id, row.id));
  after.emit(projectTopic(row.projectId), { type: 'task.deleted', projectId: row.projectId, taskId: row.id });
  after.emit(taskTopic(row.id), { type: 'task.removed', taskId: row.id });
  return { blobIds: blobs.rows.map((b) => b.blob_id) };
}

/** Moves every Task of a Status being deleted to the end of another one. */
export async function relocateStatusTasks(
  tx: Executor,
  after: AfterCommit,
  input: { fromStatusId: string; toStatusId: string; actor: Actor },
): Promise<void> {
  const moving = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.statusId, input.fromStatusId))
    .orderBy(asc(tasks.position), asc(tasks.id))
    .for('update');
  if (moving.length === 0) return;
  const keys = generateNKeysBetween(await lastPosition(tx, input.toStatusId), null, moving.length);
  await tx.execute(sql`
    update tasks set status_id = ${input.toStatusId}, position = v.position, version = version + 1, updated_at = now()
    from unnest(${sql.param(moving.map((t) => t.id))}::uuid[], ${sql.param(keys)}::text[]) as v(id, position)
    where tasks.id = v.id`);
  await recordRevisions(
    tx,
    after,
    input.actor,
    moving.map((t) => ({
      taskId: t.id,
      version: t.version + 1,
      changes: [{ field: 'statusId', before: t.statusId, after: input.toStatusId }],
    })),
  );
  for (const t of moving) {
    await onTaskChanged(tx, after, { ...t, statusId: input.toStatusId }, { agentId: t.agentId, statusId: t.statusId });
  }
  await emitTasksChanged(tx, after, moving.map((t) => t.id), 'task.moved');
}

/** Takes a Tag off every Task that has it, recording a Revision on each, before the Tag is deleted. */
export async function detachTag(tx: Executor, after: AfterCommit, tag: { id: string; projectId: string }, actor: Actor): Promise<void> {
  await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, tag.projectId)).for('share');
  const tagged = await tx
    .select()
    .from(tasks)
    .where(inArray(tasks.id, tx.select({ id: taskTags.taskId }).from(taskTags).where(eq(taskTags.tagId, tag.id))))
    .orderBy(asc(tasks.id))
    .for('update', { of: tasks });
  if (tagged.length === 0) return;
  const ids = tagged.map((t) => t.id);
  const current = await tx.select().from(taskTags).where(inArray(taskTags.taskId, ids));
  const tagsOf = (taskId: string) => current.filter((c) => c.taskId === taskId).map((c) => c.tagId).sort();

  await tx.delete(taskTags).where(eq(taskTags.tagId, tag.id));
  await tx.update(tasks).set({ version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(inArray(tasks.id, ids));
  await recordRevisions(
    tx,
    after,
    actor,
    tagged.map((t) => {
      const before = tagsOf(t.id);
      return { taskId: t.id, version: t.version + 1, changes: [{ field: 'tagIds', before, after: before.filter((l) => l !== tag.id) }] };
    }),
  );
  await emitTasksChanged(tx, after, ids, 'task.updated');
}

// Revisions

export function serializeRevision(
  r: typeof taskRevisions.$inferSelect,
  actor: Actor,
): Revision {
  return {
    id: r.id,
    taskId: r.taskId,
    version: r.version,
    actor,
    changes: r.changes,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * An Agent being deleted leaves its (closed) Tasks unassigned, recorded like any edit. Locks the
 * Tasks, so it runs before the Agent's row is locked (lock order: task → agent).
 */
export async function unassignDeletedAgent(tx: Executor, after: AfterCommit, agentId: string, actor: Actor): Promise<void> {
  const assigned = await tx.select().from(tasks).where(eq(tasks.agentId, agentId)).orderBy(asc(tasks.id)).for('update');
  if (assigned.length === 0) return;
  const ids = assigned.map((t) => t.id);
  await tx
    .update(tasks)
    .set({ agentId: null, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
    .where(inArray(tasks.id, ids));
  await recordRevisions(
    tx,
    after,
    actor,
    assigned.map((t) => ({ taskId: t.id, version: t.version + 1, changes: [{ field: 'agentId' as const, before: agentId, after: null }] })),
  );
  await emitTasksChanged(tx, after, ids, 'task.updated');
}

async function recordRevisions(
  tx: Executor,
  after: AfterCommit,
  actor: Actor,
  entries: { taskId: string; version: number; changes: RevisionChange[] }[],
): Promise<void> {
  if (entries.length === 0) return;
  const inserted = await tx
    .insert(taskRevisions)
    .values(entries.map((e) => ({ ...e, actorType: actor.type, actorId: actor.id })))
    .returning();
  for (const revision of inserted) {
    after.emit(taskTopic(revision.taskId), { type: 'revision.created', revision: serializeRevision(revision, actor) });
  }
}

async function fieldsChangedSince(tx: Executor, taskId: string, version: number): Promise<Set<RevisionField>> {
  const rows = await tx
    .select({ changes: taskRevisions.changes })
    .from(taskRevisions)
    .where(and(eq(taskRevisions.taskId, taskId), gt(taskRevisions.version, version)));
  return new Set(rows.flatMap((r) => r.changes.map((c) => c.field)));
}

export async function emitTasksChanged(
  tx: Executor,
  after: AfterCommit,
  taskIds: string[],
  boardEvent: 'task.updated' | 'task.moved',
): Promise<Task[]> {
  const loaded = await loadTasks(tx, taskIds);
  for (const task of loaded) {
    after.emit(projectTopic(task.projectId), { type: boardEvent, task: cardOf(task) });
    after.emit(taskTopic(task.id), { type: 'task.changed', task });
  }
  return loaded;
}

// Fields

interface Fields {
  title: string;
  description: string;
  statusId: string;
  priority: Priority;
  tagIds: string[];
  assigneeIds: string[];
  agentId: string | null;
}

async function currentFields(tx: Executor, row: TaskRow): Promise<Fields> {
  const [l, a] = await Promise.all([
    tx.select({ id: taskTags.tagId }).from(taskTags).where(eq(taskTags.taskId, row.id)),
    tx.select({ id: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, row.id)),
  ]);
  return {
    title: row.title,
    description: row.description,
    statusId: row.statusId,
    priority: row.priority,
    tagIds: l.map((x) => x.id).sort(),
    assigneeIds: a.map((x) => x.id).sort(),
    agentId: row.agentId,
  };
}

function diff(before: Fields, after: Fields): RevisionChange[] {
  const changes: RevisionChange[] = [];
  for (const field of Object.keys(before) as (keyof Fields)[]) {
    const b = before[field];
    const a = after[field];
    const same = Array.isArray(b) && Array.isArray(a) ? b.join() === a.join() : b === a;
    if (!same) changes.push({ field, before: b, after: a });
  }
  return changes;
}

async function setTags(tx: Executor, taskId: string, tagIds: string[]) {
  await tx.delete(taskTags).where(eq(taskTags.taskId, taskId));
  if (tagIds.length > 0) await tx.insert(taskTags).values(tagIds.map((tagId) => ({ taskId, tagId })));
}

async function setAssignees(tx: Executor, taskId: string, userIds: string[]) {
  await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
  if (userIds.length > 0) await tx.insert(taskAssignees).values(userIds.map((userId) => ({ taskId, userId })));
}

/** Deduplicated, sorted, and all belonging to the project. */
async function validTags(tx: Executor, projectId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return [];
  const found = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.projectId, projectId), inArray(tags.id, unique)));
  if (found.length !== unique.length) throw badRequest('Unknown tag for this project');
  return unique;
}

async function validAssignees(tx: Executor, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return [];
  const found = await tx.select({ id: users.id }).from(users).where(inArray(users.id, unique));
  if (found.length !== unique.length) throw badRequest('Unknown user');
  return unique;
}

async function validAgent(tx: Executor, id: string): Promise<string> {
  const [found] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, id));
  if (!found) throw badRequest('Unknown agent');
  return found.id;
}

async function assertStatusInProject(tx: Executor, statusId: string, projectId: string) {
  const [s] = await tx
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.id, statusId), eq(statuses.projectId, projectId)));
  if (!s) throw badRequest('Unknown status for this project');
}

async function firstOpenStatus(tx: Executor, projectId: string): Promise<string> {
  const [s] = await tx
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.category, 'open')))
    .orderBy(asc(statuses.position))
    .limit(1);
  if (!s) throw badRequest('The project has no open status');
  return s.id;
}

// Ordering within a column (fractional index keys)

async function lastPosition(tx: Executor, statusId: string, exclude?: string): Promise<string | null> {
  const [row] = await tx
    .select({ position: tasks.position })
    .from(tasks)
    .where(exclude ? and(eq(tasks.statusId, statusId), ne(tasks.id, exclude)) : eq(tasks.statusId, statusId))
    .orderBy(desc(tasks.position))
    .limit(1);
  return row?.position ?? null;
}

async function endOfColumn(tx: Executor, statusId: string): Promise<string> {
  return generateKeyBetween(await lastPosition(tx, statusId), null);
}

/** The key for the requested slot, plus the Tasks whose keys had to change to make room. */
async function positionBetween(
  tx: Executor,
  taskId: string,
  input: MoveTaskInput,
): Promise<{ position: string; respaced: string[] }> {
  const column = await tx
    .select({ id: tasks.id, position: tasks.position })
    .from(tasks)
    .where(and(eq(tasks.statusId, input.statusId), ne(tasks.id, taskId)))
    .orderBy(asc(tasks.position), asc(tasks.id));

  // Resolve the slot as an index into the column: the moving Task goes before column[slot].
  // Neighbors win over edges; `afterTaskId: null` alone means the top, nothing means the end.
  let slot = column.length;
  const afterIdx = input.afterTaskId ? column.findIndex((t) => t.id === input.afterTaskId) : -1;
  const beforeIdx = input.beforeTaskId ? column.findIndex((t) => t.id === input.beforeTaskId) : -1;
  if (afterIdx >= 0) slot = afterIdx + 1;
  else if (beforeIdx >= 0) slot = beforeIdx;
  else if (input.afterTaskId === null && input.beforeTaskId === undefined) slot = 0;

  const lower = column[slot - 1]?.position ?? null;
  const upper = column[slot]?.position ?? null;
  if (lower === null || upper === null || lower < upper) {
    return { position: generateKeyBetween(lower, upper), respaced: [] };
  }

  // Duplicate keys (from concurrent moves) leave no room in between: respace the column.
  const keys = generateNKeysBetween(null, null, column.length + 1);
  for (const [i, t] of column.entries()) {
    const key = keys[i < slot ? i : i + 1]!;
    await tx.update(tasks).set({ position: key }).where(eq(tasks.id, t.id));
  }
  return { position: keys[slot]!, respaced: column.map((t) => t.id) };
}
