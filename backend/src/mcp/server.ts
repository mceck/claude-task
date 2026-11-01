import { openPullRequest } from '../git/service';
import { GitProviderError } from '../git/provider';
// Task Tools: the MCP server (Streamable HTTP, stateless) an Agent's `claude` reaches with its
// Job token. Every mutation is a Revision attributed to the Agent.
import { ATTACHMENT_MAX_FILES, CATEGORIES, PRIORITIES, QUESTION_LIMITS, taskKey } from '@claude-task/shared';
import type { Actor, Category, QuestionItem, QuestionKind } from '@claude-task/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transact } from '../context';
import type { AppContext } from '../context';
import type { Executor } from '../db/client';
import { agents, comments, jobs, tags, projects, schedules, sessions, statuses, tasks, users } from '../db/schema';
import { badRequest, fromDatabaseError, HttpError, unauthorized } from '../errors';
import { actorResolver, SYSTEM_ACTOR } from '../modules/actors';
import { ACTIVE_JOB_STATES, loadAgents } from '../modules/agents/service';
import { readComments, searchComments } from '../modules/search/comments';
import { deliverComment } from '../sessions/lifecycle';
import { createTask, getTaskRow, loadCards, loadTask, moveTask, updateTask } from '../modules/tasks/service';
import { assertBoardTask } from '../modules/projects/service';
import { createAgentComment, createUserComment } from '../modules/comments/service';
import type { NewAttachment, NewQuestion } from '../modules/comments/service';
import { expectedRespondents, questionBody, validateItems } from '../modules/questions/service';
import { discardBlobs } from '../blobstore';
import { hashToken } from '../secrets';

interface JobScope {
  jobId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
  projectId: string;
  projectKind: string;
  /** The Project lets its Agents act on every Task of the Project. */
  boardWriteAccess: boolean;
  actor: Actor;
  /** The Job belongs to a Scheduled Run: `global` when its Schedule has no Repository. */
  schedule: { global: boolean } | null;
}

const COMMENT_PAGE = 50;

const filePaths = z
  .array(z.string().min(1).max(4096))
  .max(ATTACHMENT_MAX_FILES)
  .describe('Files in your container: relative to your working directory, or absolute');
const questionItem = z.object({
  header: z.string().trim().min(1).max(QUESTION_LIMITS.header).describe('Very short label shown as a chip, e.g. "Database"'),
  question: z.string().trim().min(1).max(QUESTION_LIMITS.question).describe('The full question, in markdown'),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(QUESTION_LIMITS.label).describe('What people pick (1 to 5 words)'),
        description: z.string().trim().max(QUESTION_LIMITS.description).default('').describe('What choosing it means, its trade-offs'),
      }),
    )
    .min(QUESTION_LIMITS.options.min)
    .max(QUESTION_LIMITS.options.max)
    .describe('2 to 4 options; an "Other" free-text answer is always added for you'),
  multiSelect: z.boolean().default(false).describe('Allow choosing several options'),
});
const questionItems = z.array(questionItem).min(QUESTION_LIMITS.items.min).max(QUESTION_LIMITS.items.max);

/** Valid only while its Job runs, and not once a human closed the Task or unassigned the Agent. */
const activeJobCondition = and(inArray(jobs.state, [...ACTIVE_JOB_STATES]), eq(jobs.cancelRequested, false), eq(sessions.state, 'running'));

async function jobScope(ctx: AppContext, request: FastifyRequest): Promise<JobScope> {
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token) throw unauthorized('Missing job token');
  const [row] = await ctx.db
    .select({
      job: jobs,
      agentName: agents.name,
      projectId: tasks.projectId,
      projectKind: projects.kind,
      boardWriteAccess: projects.boardWriteAccess,
      scheduleId: schedules.id,
      repository: projects.repository,
    })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(schedules, eq(schedules.projectId, tasks.projectId))
    .where(
      and(eq(jobs.tokenHash, hashToken(token)), activeJobCondition),
    );
  if (!row) throw unauthorized('Unknown or expired job token');
  return {
    jobId: row.job.id,
    agentId: row.job.agentId,
    taskId: row.job.taskId,
    sessionId: row.job.sessionId,
    projectId: row.projectId,
    projectKind: row.projectKind,
    boardWriteAccess: row.boardWriteAccess,
    actor: { type: 'agent', id: row.job.agentId, displayName: row.agentName },
    schedule: row.scheduleId ? { global: !row.repository } : null,
  };
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/** Tool errors go back to the model as text it can act on. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const known = err instanceof HttpError || err instanceof GitProviderError ? err : fromDatabaseError(err);
    const message = known ? known.message : 'Internal error';
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

function buildServer(ctx: AppContext, scope: JobScope): McpServer {
  const server = new McpServer({ name: 'claude-task', version: '1.0.0' });

  server.registerTool(
    'get_task',
    {
      description:
        (scope.schedule?.global ? 'Read any task of any project by key. ' : '') + 'Read a task: its fields, the statuses (with categories) you can move it to, the tags, assignees and non-internal comments (newest 50; pass `comments_before` from the previous answer for older ones). Without `key` it reads your own task.',
      inputSchema: { key: z.string().optional().describe('Task key like API-42; defaults to your task'), comments_before: z.string().optional() },
    },
    ({ key, comments_before }) => run(() => getTask(ctx, scope, key, comments_before)),
  );

  server.registerTool(
    'list_tasks',
    {
      description:
        'List tasks of your project (summary fields only). `text` matches the title, the description or the task key: it is split into words and every word must appear somewhere in the task. Closed tasks are left out unless you ask for `status_category` `closed`.',
      inputSchema: {
        ...(scope.schedule?.global ? { project: z.string().optional().describe('Project key; defaults to the project of your own task') } : {}),
        status_category: z.enum(CATEGORIES).optional(),
        tag: z.string().optional().describe('Label name'),
        assignee: z.string().optional().describe("A User's display name, or `none` for tasks without assignees"),
        priority: z.enum(PRIORITIES).optional(),
        updated_since: z.string().optional().describe('Only tasks changed since this ISO 8601 date-time'),
        text: z.string().max(200).optional().describe('Words to look for in the title, description or key'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    (args) => run(() => listTasks(ctx, scope, args as Parameters<typeof listTasks>[2])),
  );

  server.registerTool(
    'search_comments',
    {
      description:
        "Search the comments of your project's tasks. The query is split into words and every word must appear in the same comment; matching is case-insensitive, without accent folding. Internal notes and deleted comments are never included. Closed tasks are left out unless you ask for `status_category` `closed`. Returns short snippets with the ids to read around them with `read_comments`.",
      inputSchema: {
        ...(scope.schedule?.global ? { project: z.string().optional().describe('Project key; defaults to the project of your own task') } : {}),
        query: z.string().trim().min(2).max(200),
        status_category: z.enum(CATEGORIES).optional().describe('Only comments on tasks in this category; closed tasks are excluded by default'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of hits (default 20)'),
      },
    },
    (args) => run(() => searchProjectComments(ctx, scope, args)),
  );

  server.registerTool(
    'read_comments',
    {
      description:
        'Read the conversation around one comment: the `before` comments before it and the `after` comments after it, in chronological order, with whether there are more on each side. Internal notes and deleted comments are never included.',
      inputSchema: {
        comment_id: z.string().min(1),
        before: z.number().int().min(0).max(25).optional().describe('Comments to return before it (default 10)'),
        after: z.number().int().min(0).max(25).optional().describe('Comments to return after it (default 10)'),
      },
    },
    (args) => run(() => readTaskComments(ctx, scope, args)),
  );

  server.registerTool(
    'update_task',
    {
      description: "Update your own task's title, description, priority or tags (tag names must exist in the project; the list replaces the current tags).",
      inputSchema: {
        title: z.string().trim().min(1).max(500).optional(),
        description: z.string().max(100_000).optional(),
        priority: z.enum(PRIORITIES).optional(),
        tags: z.array(z.string()).max(50).optional(),
      },
    },
    (args) => run(() => updateOwnTask(ctx, scope, args)),
  );

  server.registerTool(
    'set_status',
    {
      description: 'Move your own task to another status by name, e.g. to signal it is ready for review. Statuses in the closed category are reserved for humans.',
      inputSchema: { status_name: z.string().min(1) },
    },
    ({ status_name }) => run(() => setStatus(ctx, scope, status_name)),
  );

  server.registerTool(
    'create_task',
    {
      description: 'Create a new, unassigned task in your project, e.g. to report an issue outside the scope of your task.',
      inputSchema: {
        title: z.string().trim().min(1).max(500),
        description: z.string().max(100_000).optional(),
        priority: z.enum(PRIORITIES).optional(),
        tags: z.array(z.string()).max(50).optional(),
      },
    },
    (args) => run(() => createProjectTask(ctx, scope, args)),
  );

  server.registerTool(
    'send_files',
    {
      description:
        'Post files from your container to the task conversation, e.g. screenshots, charts, logs or reports, so humans can see them. Images are shown inline. Nothing is posted if any file cannot be read.',
      inputSchema: {
        paths: filePaths.min(1),
        caption: z.string().max(100_000).optional().describe('Markdown shown with the files'),
      },
    },
    ({ paths, caption }) => run(() => sendFiles(ctx, scope, paths, caption ?? '')),
  );

  // Nobody answers during a Scheduled Run.
  if (!scope.schedule) {
  server.registerTool(
    'ask_question',
    {
      description:
        'Ask the humans a multiple-choice question (1 to 4 items answered together) when you need a decision with clear options. The first person who answers decides. After calling it, end your turn: the answer arrives as a new message. Use plain text for open-ended questions.',
      inputSchema: { questions: questionItems, paths: filePaths.optional().describe('Files to show with the question, e.g. mockups to choose from') },
    },
    ({ questions, paths }) => run(() => postQuestion(ctx, scope, 'question', questions, paths ?? [])),
  );

  server.registerTool(
    'create_survey',
    {
      description:
        "Collect answers from several people: every task assignee is expected to answer, anyone may. Use it ONLY when a human explicitly asked you to run a survey or to collect several people's opinions; otherwise use ask_question. The results arrive in one message once every assignee answered or someone sends it early.",
      inputSchema: { questions: questionItems, paths: filePaths.optional().describe('Files to show with the survey') },
    },
    ({ questions, paths }) => run(() => postQuestion(ctx, scope, 'survey', questions, paths ?? [])),
  );
  }
  if (scope.schedule?.global) registerGlobalTools(server, ctx, scope);
  if (scope.boardWriteAccess && scope.projectKind === 'project' && !scope.schedule) registerBoardWriteTools(server, ctx, scope);

  server.registerTool('open_pull_request', {
    description: 'Open or update a pull request (a merge request on GitLab) from your task branch. Commit and push the branch first. Never changes the task status.',
    inputSchema: { title: z.string().trim().min(1).max(500), body: z.string().max(100000), draft: z.boolean().optional() },
  }, (args) => run(() => openPullRequest(ctx, scope, args)));
  return server;
}

async function findTaskInProject(db: Executor, scope: JobScope, key: string | undefined) {
  if (!key) return getTaskRow(db, scope.taskId);
  const row = await getTaskRow(db, key).catch(() => null);
  if (scope.schedule?.global) {
    if (!row) throw badRequest(`No task ${key}`);
    await assertOrdinaryProject(db, row.projectId, key);
    return row;
  }
  if (!row || row.projectId !== scope.projectId) throw badRequest(`No task ${key} in your project`);
  return row;
}

/** The global tools reach Tasks of ordinary, non-archived Projects, not the ones of Wikis and Schedules. */
async function assertOrdinaryProject(db: Executor, projectId: string, what: string) {
  const [project] = await db.select({ kind: projects.kind, archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, projectId));
  if (project?.kind !== 'project' || project.archivedAt !== null) throw badRequest(`No task or project ${what}`);
}

async function getTask(ctx: AppContext, scope: JobScope, key: string | undefined, before: string | undefined) {
  const row = await findTaskInProject(ctx.db, scope, key);
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
    priority?: (typeof PRIORITIES)[number];
    updated_since?: string;
    text?: string;
    limit?: number;
  },
) {
  let projectId = scope.projectId;
  if (args.project && scope.schedule?.global) {
    const [project] = await ctx.db.select().from(projects).where(eq(projects.key, args.project.trim().toUpperCase()));
    if (!project || project.kind !== 'project' || project.archivedAt) throw badRequest(`No project ${args.project}`);
    projectId = project.id;
  }
  const statusRows = await ctx.db.select().from(statuses).where(eq(statuses.projectId, projectId));
  const tagRows = await ctx.db.select().from(tags).where(eq(tags.projectId, projectId));
  const tag = args.tag ? tagRows.find((l) => l.name.toLowerCase() === args.tag!.toLowerCase()) : undefined;
  if (args.tag && !tag) throw badRequest(`No tag named "${args.tag}" in the project`);
  const assigneeIds = args.assignee ? await userIdsByDisplayName(ctx, args.assignee) : [];
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

async function tagIds(db: Executor, projectId: string, names: string[]): Promise<string[]> {
  const rows = await db.select().from(tags).where(eq(tags.projectId, projectId));
  return names.map((name) => {
    const found = rows.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
    if (!found) throw badRequest(`No tag named "${name}" in the project. Available: ${rows.map((l) => l.name).join(', ') || 'none'}`);
    return found.id;
  });
}

async function updateOwnTask(ctx: AppContext, scope: JobScope, args: { title?: string; description?: string; priority?: (typeof PRIORITIES)[number]; tags?: string[] }) {
  await assertBoardTask(ctx.db, scope.projectId);
  const task = await transact(ctx, async (tx, after) => {
    const current = await getTaskRow(tx, scope.taskId);
    return updateTask(
      tx,
      after,
      scope.taskId,
      {
        version: current.version,
        title: args.title,
        description: args.description,
        priority: args.priority,
        tagIds: args.tags ? await tagIds(tx, scope.projectId, args.tags) : undefined,
      },
      scope.actor,
    );
  });
  return { updated: task.key, version: task.version };
}

async function setStatus(ctx: AppContext, scope: JobScope, name: string) {
  await assertBoardTask(ctx.db, scope.projectId);
  const [status] = await ctx.db
    .select()
    .from(statuses)
    .where(and(eq(statuses.projectId, scope.projectId), sql`lower(${statuses.name}) = lower(${name.trim()})`));
  if (!status) {
    const all = await ctx.db.select({ name: statuses.name }).from(statuses).where(eq(statuses.projectId, scope.projectId));
    throw badRequest(`No status named "${name}". Available: ${all.map((s) => s.name).join(', ')}`);
  }
  if (status.category === 'closed') throw badRequest(`"${status.name}" is a closed status; only humans can close tasks.`);
  const task = await transact(ctx, (tx, after) => moveTask(tx, after, scope.taskId, { statusId: status.id }, scope.actor));
  return { moved: task.key, status: status.name };
}

async function createProjectTask(ctx: AppContext, scope: JobScope, args: { title: string; description?: string; priority?: (typeof PRIORITIES)[number]; tags?: string[] }) {
  await assertBoardTask(ctx.db, scope.projectId);
  const task = await transact(ctx, async (tx, after) =>
    createTask(
      tx,
      after,
      scope.projectId,
      {
        title: args.title,
        description: args.description ?? '',
        priority: args.priority ?? 'none',
        tagIds: args.tags ? await tagIds(tx, scope.projectId, args.tags) : [],
        assigneeIds: [],
      },
      scope.actor,
      // The tool contract is "new, unassigned": a Project default Agent doesn't apply.
      { assignDefaultAgent: false },
    ),
  );
  const [project] = await ctx.db.select({ key: projects.key }).from(projects).where(eq(projects.id, scope.projectId));
  return { created: taskKey(project!.key, task.number), title: task.title };
}

/** Asks the Runner for the files; any unreadable file posts nothing. */
async function collectFiles(ctx: AppContext, scope: JobScope, paths: string[]): Promise<NewAttachment[]> {
  if (paths.length === 0) return [];
  const { manifest, files } = await ctx.uploads.request(scope.agentId, scope.jobId, paths);
  const failed = manifest.filter((e) => e.error);
  if (failed.length > 0) {
    await discardBlobs(ctx.blobs, files.map((f) => f.blobId));
    throw badRequest(`Nothing was posted. These files could not be read:\n${failed.map((e) => `- ${e.path}: ${e.error}`).join('\n')}`);
  }
  return files;
}

async function postAgentComment(
  ctx: AppContext,
  scope: JobScope,
  body: string,
  files: NewAttachment[],
  question?: NewQuestion,
): Promise<string> {
  try {
    return await transact(ctx, async (tx, after) => {
      // Collecting files takes a while: the Job may have ended, or the Task closed, meanwhile.
      const [job] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
        .where(and(eq(jobs.id, scope.jobId), activeJobCondition));
      if (!job) throw unauthorized('Your job ended before the comment could be posted');
      return createAgentComment(tx, after, { taskId: scope.taskId, agentId: scope.agentId, jobId: scope.jobId, body, attachments: files, question });
    });
  } catch (err) {
    await discardBlobs(ctx.blobs, files.map((f) => f.blobId));
    throw err;
  }
}

async function sendFiles(ctx: AppContext, scope: JobScope, paths: string[], caption: string) {
  const files = await collectFiles(ctx, scope, paths);
  const id = await postAgentComment(ctx, scope, caption, files);
  return { posted: id, files: files.map((f) => f.filename) };
}

async function postQuestion(ctx: AppContext, scope: JobScope, kind: QuestionKind, items: QuestionItem[], paths: string[]) {
  validateItems(items);
  const expected = kind === 'survey' ? await expectedRespondents(ctx.db, scope.taskId) : [];
  if (kind === 'survey') {
    if (expected.length === 0) {
      throw badRequest('This task has no assignees to answer a survey: ask people to assign themselves to the task, or use ask_question.');
    }
  }
  const files = await collectFiles(ctx, scope, paths);
  const names = expected.map((e) => e.name);
  const id = await postAgentComment(ctx, scope, questionBody(kind, items, names), files, { kind, items, expectedRespondentIds: expected.map((e) => e.id) });
  if (kind === 'question') return { posted: id, next: 'Question posted. End your turn now; the answer will arrive as a new message.' };
  return {
    posted: id,
    expectedRespondents: names,
    next: `Survey posted. The results arrive in one message once ${names.join(', ')} have answered, or when someone sends it early. End your turn unless you have other work to do meanwhile.`,
  };
}

export function mcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  const config = { auth: 'public' as const, csrf: false };

  app.post('/mcp', { config }, async (request, reply) => {
    const scope = await jobScope(ctx, request);
    const server = buildServer(ctx, scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless server: no server-initiated stream and no sessions to end.
  const notAllowed = async (_request: FastifyRequest, reply: import('fastify').FastifyReply) =>
    reply.status(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', { config }, notAllowed);
  app.delete('/mcp', { config }, notAllowed);
}

// Global Task Tools: the Jobs of a global Schedule act on the Tasks of every ordinary Project (docs/specs/schedules.md).

const projectKey = z.string().trim().min(1).max(10).describe('Project key like API');

function registerGlobalTools(server: McpServer, ctx: AppContext, scope: JobScope): void {
  server.registerTool(
    'list_projects',
    { description: 'List the projects (key, name, and how many tasks each has per status category).', inputSchema: {} },
    () => run(() => listProjectsTool(ctx)),
  );
  server.registerTool(
    'update_task_by_key',
    {
      description: "Update any task's title, description, priority or tags (tag names must exist in its project; the list replaces the current tags).",
      inputSchema: {
        key: z.string().min(1),
        title: z.string().trim().min(1).max(500).optional(),
        description: z.string().max(100_000).optional(),
        priority: z.enum(PRIORITIES).optional(),
        tags: z.array(z.string()).max(50).optional(),
      },
    },
    (args) => run(() => updateAnyTask(ctx, scope, args)),
  );
  server.registerTool(
    'set_task_status',
    {
      description: 'Move any task to another status of its project by name. Statuses in the closed category are reserved for humans.',
      inputSchema: { key: z.string().min(1), status_name: z.string().min(1) },
    },
    ({ key, status_name }) => run(() => setAnyStatus(ctx, scope, key, status_name)),
  );
  server.registerTool(
    'create_task_in_project',
    {
      description: 'Create a new, unassigned task in any project.',
      inputSchema: {
        project: projectKey,
        title: z.string().trim().min(1).max(500),
        description: z.string().max(100_000).optional(),
        priority: z.enum(PRIORITIES).optional(),
        tags: z.array(z.string()).max(50).optional(),
      },
    },
    (args) => run(() => createAnyTask(ctx, scope, args)),
  );
  server.registerTool(
    'assign_task_to_me',
    {
      description: 'Assign a task to yourself. This starts no work: call start_task when you want to begin. A task that another agent works on is refused.',
      inputSchema: { key: z.string().min(1) },
    },
    ({ key }) => run(() => assignToMe(ctx, scope, key)),
  );
  server.registerTool(
    'start_task',
    {
      description: 'Start a task that is assigned to you: your prompt becomes its first message, and you work on it in a session of its own after your current job.',
      inputSchema: { key: z.string().min(1), prompt: z.string().trim().min(1).max(100_000).describe('What to do on the task') },
    },
    ({ key, prompt }) => run(() => startAnyTask(ctx, scope, key, prompt)),
  );
}

async function listProjectsTool(ctx: AppContext) {
  const rows = await ctx.db.select().from(projects).where(and(eq(projects.kind, 'project'), isNull(projects.archivedAt))).orderBy(asc(projects.name));
  const counts = await ctx.db.execute<{ project_id: string; category: string; n: number }>(sql`
    select t.project_id, s.category, count(*)::int as n from tasks t join statuses s on s.id = t.status_id group by t.project_id, s.category`);
  return {
    projects: rows.map((p) => ({
      key: p.key,
      name: p.name,
      description: p.description,
      tasks: Object.fromEntries(counts.rows.filter((c) => c.project_id === p.id).map((c) => [c.category, c.n])),
    })),
  };
}

async function updateAnyTask(ctx: AppContext, scope: JobScope, args: { key: string; title?: string; description?: string; priority?: (typeof PRIORITIES)[number]; tags?: string[] }) {
  const row = await findTaskInProject(ctx.db, scope, args.key);
  const task = await transact(ctx, async (tx, after) => {
    const current = await getTaskRow(tx, row.id);
    return updateTask(
      tx,
      after,
      row.id,
      {
        version: current.version,
        title: args.title,
        description: args.description,
        priority: args.priority,
        tagIds: args.tags ? await tagIds(tx, row.projectId, args.tags) : undefined,
      },
      scope.actor,
    );
  });
  return { updated: task.key, version: task.version };
}

async function setAnyStatus(ctx: AppContext, scope: JobScope, key: string, name: string) {
  const row = await findTaskInProject(ctx.db, scope, key);
  const all = await ctx.db.select().from(statuses).where(eq(statuses.projectId, row.projectId));
  const status = all.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!status) throw badRequest(`No status named "${name}". Available: ${all.map((s) => s.name).join(', ')}`);
  if (status.category === 'closed') throw badRequest(`"${status.name}" is a closed status; only humans can close tasks.`);
  const task = await transact(ctx, (tx, after) => moveTask(tx, after, row.id, { statusId: status.id }, scope.actor));
  return { moved: task.key, status: status.name };
}

async function createAnyTask(ctx: AppContext, scope: JobScope, args: { project: string; title: string; description?: string; priority?: (typeof PRIORITIES)[number]; tags?: string[] }) {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.key, args.project.toUpperCase()));
  if (!project || project.kind !== 'project' || project.archivedAt) throw badRequest(`No project ${args.project}`);
  const task = await transact(ctx, async (tx, after) =>
    createTask(
      tx,
      after,
      project.id,
      {
        title: args.title,
        description: args.description ?? '',
        priority: args.priority ?? 'none',
        tagIds: args.tags ? await tagIds(tx, project.id, args.tags) : [],
        assigneeIds: [],
      },
      scope.actor,
      { assignDefaultAgent: false },
    ),
  );
  return { created: taskKey(project.key, task.number), title: task.title };
}

async function assignToMe(ctx: AppContext, scope: JobScope, key: string) {
  const row = await findTaskInProject(ctx.db, scope, key);
  if (row.id === scope.taskId) throw badRequest('This is your own task.');
  if (row.agentId && row.agentId !== scope.agentId) {
    const [other] = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentId));
    throw badRequest(`${key} is assigned to ${other?.name ?? 'another agent'}.`);
  }
  const task = await transact(ctx, async (tx, after) => {
    const current = await getTaskRow(tx, row.id);
    return updateTask(tx, after, row.id, { version: current.version, agentId: scope.agentId }, scope.actor);
  });
  return { assigned: task.key, next: 'Call start_task to begin the work.' };
}

async function startAnyTask(ctx: AppContext, scope: JobScope, key: string, prompt: string) {
  const row = await findTaskInProject(ctx.db, scope, key);
  if (row.agentId !== scope.agentId) throw badRequest(`${key} is not assigned to you: call assign_task_to_me first.`);
  const comment = await transact(ctx, async (tx, after) => {
    const current = await getTaskRow(tx, row.id, { lock: true });
    return createUserComment(tx, after, current, { body: prompt, internal: false, attachments: [] }, SYSTEM_ACTOR);
  });
  return { started: key, comment: comment.id, next: 'The task runs in its own session once you are free; read it later with get_task.' };
}

// Comment search and reading: the two tools every Job gets, plus the helpers they share.

/** User ids for a display name in any letter case, or `none` for Tasks without Assignees. */
async function userIdsByDisplayName(ctx: AppContext, name: string): Promise<string[]> {
  if (name.trim().toLowerCase() === 'none') return ['none'];
  const matches = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.displayName}) = ${name.trim().toLowerCase()}`);
  if (matches.length === 0) {
    const all = await ctx.db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.active, true))
      .orderBy(asc(users.displayName));
    throw badRequest(`No user named "${name}". Available: ${all.map((u) => u.name).join(', ') || 'none'}`);
  }
  return matches.map((u) => u.id);
}

async function searchProjectComments(
  ctx: AppContext,
  scope: JobScope,
  args: { project?: string; query: string; status_category?: Category; limit?: number },
) {
  let projectId = scope.projectId;
  if (args.project && scope.schedule?.global) {
    const [project] = await ctx.db.select().from(projects).where(eq(projects.key, args.project.trim().toUpperCase()));
    if (!project || project.kind !== 'project' || project.archivedAt) throw badRequest(`No project ${args.project}`);
    projectId = project.id;
  }
  const limit = args.limit ?? 20;
  const hits = await searchComments(ctx.db, {
    projectId,
    query: args.query,
    statusCategory: args.status_category,
    limit,
  });
  return { hits, truncated: hits.length >= limit };
}

async function readTaskComments(ctx: AppContext, scope: JobScope, args: { comment_id: string; before?: number; after?: number }) {
  const window = await readComments(ctx.db, {
    commentId: args.comment_id,
    before: args.before ?? 10,
    after: args.after ?? 10,
  });
  if (!window) throw badRequest('No such comment, or it is internal or deleted.');
  if (scope.schedule?.global) await assertOrdinaryProject(ctx.db, window.projectId, args.comment_id);
  else if (window.projectId !== scope.projectId) throw badRequest('That comment is not in your project.');
  return {
    task: window.task,
    comments: window.comments,
    hasMoreBefore: window.hasMoreBefore,
    hasMoreAfter: window.hasMoreAfter,
  };
}

// Board Write Access: the extra Task Tools of a Project that lets its Agents act on every Task.

const STARTS_PER_JOB = 3;

function registerBoardWriteTools(server: McpServer, ctx: AppContext, scope: JobScope): void {
  server.registerTool(
    'update_task_by_key',
    {
      description:
        'Update any task of your project: title, description, priority or tags (tag names must exist in the project; the list replaces the current tags). Closed tasks cannot be edited.',
      inputSchema: {
        key: z.string().min(1),
        title: z.string().trim().min(1).max(500).optional(),
        description: z.string().max(100_000).optional(),
        priority: z.enum(PRIORITIES).optional(),
        tags: z.array(z.string()).max(50).optional(),
      },
    },
    (args) => run(() => updateTaskInProject(ctx, scope, args)),
  );
  server.registerTool(
    'set_task_status',
    {
      description: 'Move any task of your project to another status by name. Closed statuses are for humans.',
      inputSchema: { key: z.string().min(1), status_name: z.string().min(1) },
    },
    ({ key, status_name }) => run(() => setStatusInProject(ctx, scope, key, status_name)),
  );
  server.registerTool(
    'comment_on_task',
    {
      description:
        "Write an Agent Comment in another task's conversation. It is delivered to the agent working on that task, mid-turn when it is running there and queued otherwise; the agent sees you as the author. It does not notify people. Closed tasks and your own task are refused.",
      inputSchema: { key: z.string().min(1), body: z.string().trim().min(1).max(100_000) },
    },
    (args) => run(() => commentOnTask(ctx, scope, args)),
  );
  server.registerTool(
    'start_agent',
    {
      description:
        'Assign an agent to a task of your project and send it your opening message, starting its session (or queueing the message when it is already working). The task must be unassigned or already assigned to that agent; it cannot be your own task. At most 3 starts per job.',
      inputSchema: {
        key: z.string().min(1),
        agent: z.string().trim().min(1).max(64).describe("The agent's name, case-insensitive"),
        prompt: z.string().trim().min(1).max(100_000).describe('The opening message: what to do, what done looks like'),
      },
    },
    (args) => run(() => startAgent(ctx, scope, args)),
  );
  server.registerTool(
    'list_agents',
    {
      description:
        'List the enabled agents with their description, state, current task and queue length, so you can pick a free and suitable one.',
      inputSchema: {},
    },
    () => run(() => listAgentsTool(ctx)),
  );
}

/** A `closed`-category Status is out of reach for the Project's Agent-side writes. */
async function assertOpenTask(db: Executor, taskId: string): Promise<void> {
  const [row] = await db
    .select({ category: statuses.category })
    .from(tasks)
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(eq(tasks.id, taskId));
  if (!row) throw badRequest('No such task.');
  if (row.category === 'closed') throw badRequest('This task is closed: closed tasks are for humans.');
}

async function updateTaskInProject(
  ctx: AppContext,
  scope: JobScope,
  args: { key: string; title?: string; description?: string; priority?: (typeof PRIORITIES)[number]; tags?: string[] },
) {
  const row = await findTaskInProject(ctx.db, scope, args.key);
  await assertOpenTask(ctx.db, row.id);
  const task = await transact(ctx, async (tx, after) => {
    const current = await getTaskRow(tx, row.id);
    return updateTask(
      tx,
      after,
      row.id,
      {
        version: current.version,
        title: args.title,
        description: args.description,
        priority: args.priority,
        tagIds: args.tags ? await tagIds(tx, row.projectId, args.tags) : undefined,
      },
      scope.actor,
    );
  });
  return { updated: task.key, version: task.version };
}

async function setStatusInProject(ctx: AppContext, scope: JobScope, key: string, name: string) {
  const row = await findTaskInProject(ctx.db, scope, key);
  await assertOpenTask(ctx.db, row.id);
  const all = await ctx.db.select().from(statuses).where(eq(statuses.projectId, row.projectId));
  const status = all.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!status) throw badRequest(`No status named "${name}". Available: ${all.map((s) => s.name).join(', ')}`);
  if (status.category === 'closed') throw badRequest(`"${status.name}" is a closed status; only humans can close tasks.`);
  const task = await transact(ctx, (tx, after) => moveTask(tx, after, row.id, { statusId: status.id }, scope.actor));
  return { moved: task.key, status: status.name };
}

async function commentOnTask(ctx: AppContext, scope: JobScope, args: { key: string; body: string }) {
  const row = await findTaskInProject(ctx.db, scope, args.key);
  if (row.id === scope.taskId) throw badRequest('That is your own task: your text already goes there.');
  await assertOpenTask(ctx.db, row.id);
  const id = await transact(ctx, async (tx, after) => {
    const [job] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
      .where(and(eq(jobs.id, scope.jobId), activeJobCondition));
    if (!job) throw unauthorized('Your job ended before the comment could be posted');
    const commentId = await createAgentComment(tx, after, {
      taskId: row.id,
      agentId: scope.agentId,
      jobId: scope.jobId,
      body: args.body,
      attachments: [],
    });
    const [comment] = await tx.select().from(comments).where(eq(comments.id, commentId));
    await deliverComment(tx, after, { id: row.id }, comment!);
    return commentId;
  });
  return { posted: id, task: args.key };
}

async function startAgent(
  ctx: AppContext,
  scope: JobScope,
  args: { key: string; agent: string; prompt: string },
) {
  const row = await findTaskInProject(ctx.db, scope, args.key);
  if (row.id === scope.taskId) throw badRequest('That is your own task: work on it directly.');
  await assertOpenTask(ctx.db, row.id);
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(sql`lower(${agents.name}) = ${args.agent.trim().toLowerCase()}`);
  if (!agent) {
    const all = await ctx.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.enabled, true))
      .orderBy(asc(agents.name));
    throw badRequest(`No agent named "${args.agent}". Available: ${all.map((a) => a.name).join(', ') || 'none'}`);
  }
  if (!agent.enabled) throw badRequest(`${agent.name} is disabled.`);
  if (agent.id === scope.agentId) throw badRequest('That is you: start another agent, or do the work on your own task.');
  if (row.agentId && row.agentId !== agent.id) {
    const [other] = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentId));
    throw badRequest(`${args.key} is assigned to ${other?.name ?? 'another agent'}.`);
  }
  return transact(ctx, async (tx, after) => {
    // Starts of one Job are serialized, so two parallel calls cannot both pass the cap.
    const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, scope.jobId)).for('update');
    const [active] = job
      ? await tx
          .select({ id: jobs.id })
          .from(jobs)
          .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
          .where(and(eq(jobs.id, scope.jobId), activeJobCondition))
      : [];
    if (!active) throw unauthorized('Your job ended before the agent could be started');
    const [started] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(eq(comments.jobId, scope.jobId), isNotNull(comments.startedAgentId)));
    if ((started?.n ?? 0) >= STARTS_PER_JOB)
      throw badRequest(`You have started ${STARTS_PER_JOB} agents in this job. Finish your own work, or report why the rest is blocked.`);
    const current = await getTaskRow(tx, row.id, { lock: true });
    await assertOpenTask(tx, current.id);
    if (current.agentId && current.agentId !== agent.id) throw badRequest(`${args.key} is assigned to another agent.`);
    if (!current.agentId) await updateTask(tx, after, current.id, { version: current.version, agentId: agent.id }, scope.actor);
    const [session] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.taskId, current.id), eq(sessions.agentId, agent.id)));
    const startsSession = !!session && !session.started && session.state !== 'closed' && session.state !== 'paused';
    const commentId = await createAgentComment(tx, after, {
      taskId: current.id,
      agentId: scope.agentId,
      jobId: scope.jobId,
      body: args.prompt,
      attachments: [],
    });
    if (startsSession) await tx.update(comments).set({ startedAgentId: agent.id }).where(eq(comments.id, commentId));
    const [comment] = await tx.select().from(comments).where(eq(comments.id, commentId));
    await deliverComment(tx, after, { id: current.id }, comment!);
    return { started: args.key, agent: agent.name, comment: commentId, sessionStarted: startsSession };
  });
}

async function listAgentsTool(ctx: AppContext) {
  const all = await loadAgents(ctx.db, (id) => ctx.runners.isReady(id));
  return {
    agents: all
      .filter((agent) => agent.enabled)
      .sort((a, b) => a.queueLength - b.queueLength || a.name.localeCompare(b.name))
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        state: agent.state,
        currentTask: agent.currentTask ? { key: agent.currentTask.key, title: agent.currentTask.title } : null,
        queueLength: agent.queueLength,
      })),
  };
}
