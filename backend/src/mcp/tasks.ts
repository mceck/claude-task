// Task Tools that read and change Tasks: the Agent's own Task always, any Task of the Project with
// Board Write Access, and any Task of any ordinary Project for a global Schedule.
import { PRIORITIES, taskKey } from '@claude-task/shared';
import type { Category } from '@claude-task/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { transact } from '../context';
import type { AppContext } from '../context';
import type { Executor } from '../db/client';
import { comments, projects, sessions, statuses, tags, tasks, users } from '../db/schema';
import { badRequest } from '../errors';
import { actorResolver } from '../modules/actors';
import { createTask, getTaskRow, loadCards, loadTask, moveTask, updateTask } from '../modules/tasks/service';
import type { TaskRow } from '../modules/tasks/service';
import type { JobScope } from './scope';
import { categoryInput, projectKeyInput, run, statusNameInput, taskFields, taskKeyInput } from './tool';

const COMMENT_PAGE = 50;

type Priority = (typeof PRIORITIES)[number];
type TaskEdit = { title?: string; description?: string; priority?: Priority; tags?: string[] };

export function registerTaskTools(server: McpServer, ctx: AppContext, scope: JobScope, reach: { boardWrites: boolean }): void {
  const global = !!scope.schedule?.global;

  server.registerTool(
    'get_task',
    {
      description:
        "Read a task: its fields (status, priority, tags, user assignees, creator, branch, pull request), the statuses of its project with their category, the project's tags, and the newest 50 comments, oldest first (internal notes are never included). Without `key` it reads your own task and marks its latest changes as seen. A non-null `commentsBefore` in the answer pages back to older comments.",
      inputSchema: {
        key: taskKeyInput.optional().describe(global ? 'Task key of any project, e.g. API-42; omit for your own task' : 'Task key of your project, e.g. API-42; omit for your own task'),
        comments_before: z.string().optional().describe('The `commentsBefore` cursor of a previous answer, for the comments before that page'),
      },
    },
    ({ key, comments_before }) => run(ctx, () => getTask(ctx, scope, key, comments_before)),
  );

  server.registerTool(
    'list_tasks',
    {
      description:
        `List the tasks of ${global ? 'a' : 'your'} project in board order, as summaries: key, title, status, category, priority, tags and whether it is yours. Filters combine with AND. Closed tasks are left out unless \`status_category\` is \`closed\`, which lists only them. Use \`get_task\` for a task's description and conversation.`,
      inputSchema: {
        ...(global ? { project: projectKeyInput.optional() } : {}),
        text: z
          .string()
          .max(200)
          .optional()
          .describe('Words to find in the title, description or key. Every word must appear, as a case-insensitive substring with accents as typed: use short distinctive roots, not phrases'),
        status_category: categoryInput.optional().describe('Only tasks whose status is in this category'),
        tag: z.string().optional().describe('Tag name'),
        assignee: z.string().optional().describe("A user's display name, or `none` for tasks without user assignees"),
        priority: z.enum(PRIORITIES).optional(),
        updated_since: z.string().optional().describe('Only tasks changed since this ISO 8601 date-time'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum tasks to return (default 50)'),
      },
    },
    (args) => run(ctx, () => listTasks(ctx, scope, args as Parameters<typeof listTasks>[2])),
  );

  // The Task of a Wiki Chat or a Scheduled Run is managed by its Wiki or its Schedule.
  if (scope.projectKind === 'project') {
    server.registerTool(
      'update_task',
      {
        description:
          "Edit your own task. Only the fields you pass change. Use it to keep the description current, e.g. tick checklist items. `tags` replaces the whole set: read `get_task` first to keep the current ones.",
        inputSchema: {
          title: taskFields.title.optional(),
          description: taskFields.description.optional(),
          priority: taskFields.priority.optional(),
          tags: taskFields.tags.optional(),
        },
      },
      (args) => run(ctx, async () => editTask(ctx, scope, await getTaskRow(ctx.db, scope.taskId), args)),
    );

    server.registerTool(
      'set_status',
      {
        description:
          'Move your own task to another status of the project, e.g. to signal it is ready for review. Statuses in the `closed` category are for humans and are refused.',
        inputSchema: { status_name: statusNameInput },
      },
      ({ status_name }) => run(ctx, async () => moveToStatus(ctx, scope, await getTaskRow(ctx.db, scope.taskId), status_name)),
    );

    server.registerTool(
      'create_task',
      {
        description:
          'Create a new task in your project, with no user assignees and no agent, e.g. to report a bug or a follow-up outside the scope of your task. Do not create one for work you can do in your task. Answers with its key.',
        inputSchema: {
          title: taskFields.title,
          description: taskFields.description.optional(),
          priority: taskFields.priority.optional().describe('Default `none`'),
          tags: taskFields.tags.optional(),
        },
      },
      (args) => run(ctx, () => createTaskIn(ctx, scope, scope.projectId, args)),
    );
  }

  if (!global && !reach.boardWrites) return;
  const which = global ? 'any task of any project' : 'any task of your project';
  server.registerTool(
    'update_task_by_key',
    {
      description: `Edit ${which} by key, like \`update_task\` does for your own: only the fields you pass change, and \`tags\` replaces the whole set. Closed tasks are refused.`,
      inputSchema: {
        key: taskKeyInput,
        title: taskFields.title.optional(),
        description: taskFields.description.optional(),
        priority: taskFields.priority.optional(),
        tags: taskFields.tags.optional(),
      },
    },
    ({ key, ...edit }) => run(ctx, async () => editTask(ctx, scope, await findOpenTask(ctx.db, scope, key), edit)),
  );
  server.registerTool(
    'set_task_status',
    {
      description: `Move ${which} to another status of its project by key. Closed tasks and statuses in the \`closed\` category are refused: closing is for humans.`,
      inputSchema: { key: taskKeyInput, status_name: statusNameInput },
    },
    ({ key, status_name }) => run(ctx, async () => moveToStatus(ctx, scope, await findOpenTask(ctx.db, scope, key), status_name)),
  );
}

/** A Task the Job may read: its own, one of its Project, or, for a global Schedule, one of any ordinary Project. */
export async function findTask(db: Executor, scope: JobScope, key: string | undefined): Promise<TaskRow> {
  if (!key) return getTaskRow(db, scope.taskId);
  const row = await getTaskRow(db, key.trim()).catch(() => null);
  if (scope.schedule?.global) {
    if (!row) throw badRequest(`No task ${key}`);
    await assertOrdinaryProject(db, row.projectId, key);
    return row;
  }
  if (!row || row.projectId !== scope.projectId) throw badRequest(`No task ${key} in your project`);
  return row;
}

/** Writes on Tasks other than the Agent's own stop at a `closed`-category Status: closing is for humans. */
export async function findOpenTask(db: Executor, scope: JobScope, key: string): Promise<TaskRow> {
  const row = await findTask(db, scope, key);
  await assertOpenTask(db, row.id);
  return row;
}

export async function assertOpenTask(db: Executor, taskId: string): Promise<void> {
  const [row] = await db
    .select({ category: statuses.category })
    .from(tasks)
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(eq(tasks.id, taskId));
  if (!row) throw badRequest('No such task.');
  if (row.category === 'closed') throw badRequest('This task is closed: closed tasks are for humans.');
}

/** The global tools reach Tasks of ordinary, non-archived Projects, not the ones of Wikis and Schedules. */
export async function assertOrdinaryProject(db: Executor, projectId: string, what: string): Promise<void> {
  const [project] = await db.select({ kind: projects.kind, archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, projectId));
  if (project?.kind !== 'project' || project.archivedAt !== null) throw badRequest(`No task or project ${what}`);
}

/** The Project a read targets: the Job's own, or the one a global Schedule names by key. */
export async function targetProject(db: Executor, scope: JobScope, key: string | undefined): Promise<{ id: string; key: string }> {
  if (key && scope.schedule?.global) return ordinaryProject(db, key);
  const [project] = await db.select({ id: projects.id, key: projects.key }).from(projects).where(eq(projects.id, scope.projectId));
  return project!;
}

export async function ordinaryProject(db: Executor, key: string): Promise<{ id: string; key: string }> {
  const [project] = await db.select().from(projects).where(eq(projects.key, key.trim().toUpperCase()));
  if (!project || project.kind !== 'project' || project.archivedAt) throw badRequest(`No project ${key}`);
  return { id: project.id, key: project.key };
}

async function getTask(ctx: AppContext, scope: JobScope, key: string | undefined, before: string | undefined) {
  const row = await findTask(ctx.db, scope, key);
  const task = await loadTask(ctx.db, row.id);
  const statusRows = await ctx.db.select().from(statuses).where(eq(statuses.projectId, row.projectId)).orderBy(asc(statuses.position));
  const tagRows = await ctx.db.select().from(tags).where(eq(tags.projectId, row.projectId)).orderBy(asc(tags.name));
  const assignees = await actorResolver(ctx.db, task.assigneeIds.map((id) => ({ type: 'user' as const, id })));

  let cursor: { t: string; id: string } | null = null;
  if (before) {
    try {
      cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')) as { t: string; id: string };
    } catch {
      throw badRequest('Invalid comments_before cursor');
    }
  }
  const page = await ctx.db
    .select({ c: comments, t: sql<string>`${comments.createdAt}::text` })
    .from(comments)
    .where(
      and(
        eq(comments.taskId, row.id),
        eq(comments.internal, false),
        isNull(comments.deletedAt),
        cursor ? or(lt(comments.createdAt, sql`${cursor.t}::timestamptz`), and(eq(comments.createdAt, sql`${cursor.t}::timestamptz`), lt(comments.id, cursor.id))) : undefined,
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(COMMENT_PAGE + 1);
  const shown = page.slice(0, COMMENT_PAGE);
  const authors = await actorResolver(ctx.db, shown.map(({ c }) => ({ type: c.authorType, id: c.authorId })));
  const last = shown[shown.length - 1];

  // Reading its own Task is how the Agent catches up with edits (the Unseen Changes banner).
  if (row.id === scope.taskId) {
    await ctx.db
      .update(sessions)
      .set({ lastSeenTaskVersion: sql`greatest(${sessions.lastSeenTaskVersion}, ${task.version})` })
      .where(eq(sessions.id, scope.sessionId));
    ctx.scheduler.publishTask(row.id);
  }
  const statusName = (id: string) => statusRows.find((s) => s.id === id)?.name ?? null;
  return {
    task: {
      key: task.key,
      title: task.title,
      description: task.description,
      status: statusName(task.statusId),
      priority: task.priority,
      tags: task.tagIds.map((id) => tagRows.find((l) => l.id === id)?.name).filter(Boolean),
      assignees: task.assigneeIds.map((id) => assignees({ type: 'user', id }).displayName),
      createdBy: task.createdBy.displayName,
      yours: row.id === scope.taskId,
      branch: task.branchName,
      pullRequest: task.pullRequest,
    },
    statuses: statusRows.map((s) => ({ name: s.name, category: s.category })),
    tags: tagRows.map((l) => l.name),
    comments: shown
      .map(({ c }) => ({ author: authors({ type: c.authorType, id: c.authorId }).displayName, kind: c.kind, createdAt: c.createdAt.toISOString(), body: c.body }))
      .reverse(),
    commentsBefore: page.length > COMMENT_PAGE && last ? Buffer.from(JSON.stringify({ t: last.t, id: last.c.id })).toString('base64url') : null,
  };
}

async function listTasks(
  ctx: AppContext,
  scope: JobScope,
  args: {
    project?: string;
    status_category?: Category;
    tag?: string;
    assignee?: string;
    priority?: Priority;
    updated_since?: string;
    text?: string;
    limit?: number;
  },
) {
  const { id: projectId } = await targetProject(ctx.db, scope, args.project);
  const statusRows = await ctx.db.select().from(statuses).where(eq(statuses.projectId, projectId));
  const tagRows = await ctx.db.select().from(tags).where(eq(tags.projectId, projectId));
  const tag = args.tag ? tagRows.find((l) => l.name.toLowerCase() === args.tag!.toLowerCase()) : undefined;
  if (args.tag && !tag) throw badRequest(`No tag named "${args.tag}" in the project. Available: ${tagRows.map((l) => l.name).join(', ') || 'none'}`);
  const assigneeIds = args.assignee ? await userIdsByDisplayName(ctx.db, args.assignee) : [];
  let updatedSince: Date | undefined;
  if (args.updated_since) {
    updatedSince = new Date(args.updated_since);
    if (Number.isNaN(updatedSince.getTime())) throw badRequest('updated_since must be an ISO 8601 date-time');
  }
  const cards = await loadCards(ctx.db, {
    projectId,
    includeClosed: args.status_category === 'closed',
    search: args.text,
    updatedSince,
    filter: { assignees: assigneeIds, tags: tag ? [tag.id] : [], priorities: args.priority ? [args.priority] : [], text: '' },
  });
  const status = (id: string) => statusRows.find((s) => s.id === id);
  return {
    tasks: cards
      .filter((c) => !args.status_category || status(c.statusId)?.category === args.status_category)
      .slice(0, args.limit ?? 50)
      .map((c) => ({
        key: c.key,
        title: c.title,
        status: status(c.statusId)?.name,
        category: status(c.statusId)?.category,
        priority: c.priority,
        tags: c.tagIds.map((id) => tagRows.find((l) => l.id === id)?.name).filter(Boolean),
        yours: c.id === scope.taskId,
      })),
  };
}

/** User ids for a display name in any letter case, or `none` for Tasks without Assignees. */
async function userIdsByDisplayName(db: Executor, name: string): Promise<string[]> {
  if (name.trim().toLowerCase() === 'none') return ['none'];
  const matches = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.displayName}) = ${name.trim().toLowerCase()}`);
  if (matches.length === 0) {
    const all = await db.select({ name: users.displayName }).from(users).where(eq(users.active, true)).orderBy(asc(users.displayName));
    throw badRequest(`No user named "${name}". Available: ${all.map((u) => u.name).join(', ') || 'none'}`);
  }
  return matches.map((u) => u.id);
}

async function tagIds(db: Executor, projectId: string, names: string[]): Promise<string[]> {
  const rows = await db.select().from(tags).where(eq(tags.projectId, projectId));
  return names.map((name) => {
    const found = rows.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
    if (!found) throw badRequest(`No tag named "${name}" in the project. Available: ${rows.map((l) => l.name).join(', ') || 'none'}`);
    return found.id;
  });
}

async function editTask(ctx: AppContext, scope: JobScope, row: TaskRow, edit: TaskEdit) {
  const task = await transact(ctx, async (tx, after) => {
    const current = await getTaskRow(tx, row.id);
    return updateTask(
      tx,
      after,
      row.id,
      {
        version: current.version,
        title: edit.title,
        description: edit.description,
        priority: edit.priority,
        tagIds: edit.tags ? await tagIds(tx, row.projectId, edit.tags) : undefined,
      },
      scope.actor,
    );
  });
  return { updated: task.key, version: task.version };
}

async function moveToStatus(ctx: AppContext, scope: JobScope, row: TaskRow, name: string) {
  const all = await ctx.db.select().from(statuses).where(eq(statuses.projectId, row.projectId)).orderBy(asc(statuses.position));
  const status = all.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!status) throw badRequest(`No status named "${name}". Available: ${all.map((s) => s.name).join(', ')}`);
  if (status.category === 'closed') throw badRequest(`"${status.name}" is a closed status; only humans can close tasks.`);
  const task = await transact(ctx, (tx, after) => moveTask(tx, after, row.id, { statusId: status.id }, scope.actor));
  return { moved: task.key, status: status.name };
}

/** A new Task with no assignees and no Agent: the tools' contract, so a Project default Agent doesn't apply. */
export async function createTaskIn(ctx: AppContext, scope: JobScope, projectId: string, args: TaskEdit & { title: string }) {
  const [project] = await ctx.db.select({ key: projects.key }).from(projects).where(eq(projects.id, projectId));
  const task = await transact(ctx, async (tx, after) =>
    createTask(
      tx,
      after,
      projectId,
      {
        title: args.title,
        description: args.description ?? '',
        priority: args.priority ?? 'none',
        tagIds: args.tags ? await tagIds(tx, projectId, args.tags) : [],
        assigneeIds: [],
      },
      scope.actor,
      { assignDefaultAgent: false },
    ),
  );
  return { created: taskKey(project!.key, task.number), title: task.title };
}

