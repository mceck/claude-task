import { openPullRequest } from '../git/service';
import { GitProviderError } from '../git/provider';
// Task Tools: the MCP server (Streamable HTTP, stateless) an Agent's `claude` reaches with its
// Job token. Every mutation is a Revision attributed to the Agent.
import { ATTACHMENT_MAX_FILES, CATEGORIES, PRIORITIES, QUESTION_LIMITS, taskKey } from '@claude-task/shared';
import type { Actor, QuestionItem, QuestionKind } from '@claude-task/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { transact } from '../context';
import type { AppContext } from '../context';
import type { Executor } from '../db/client';
import { agents, comments, jobs, tags, projects, schedules, sessions, statuses, tasks } from '../db/schema';
import { badRequest, fromDatabaseError, HttpError, unauthorized } from '../errors';
import { actorResolver, SYSTEM_ACTOR } from '../modules/actors';
import { ACTIVE_JOB_STATES } from '../modules/agents/service';
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
    .select({ job: jobs, agentName: agents.name, projectId: tasks.projectId, scheduleId: schedules.id, repository: projects.repository })
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
      description: "List tasks of your project (summary fields only). Closed tasks are left out unless you ask for status_category 'closed'.",
      inputSchema: {
        ...(scope.schedule?.global ? { project: z.string().optional().describe('Project key; defaults to the project of your own task') } : {}),
        status_category: z.enum(CATEGORIES).optional(),
        tag: z.string().optional().describe('Label name'),
        text: z.string().optional().describe('Matches title or key'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    (args) => run(() => listTasks(ctx, scope, args as Parameters<typeof listTasks>[2])),
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

/** The global tools reach Tasks of ordinary Projects, not the ones of Wikis and Schedules. */
async function assertOrdinaryProject(db: Executor, projectId: string, what: string) {
  const [project] = await db.select({ kind: projects.kind }).from(projects).where(eq(projects.id, projectId));
  if (project?.kind !== 'project') throw badRequest(`No task or project ${what}`);
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

async function listTasks(ctx: AppContext, scope: JobScope, args: { project?: string; status_category?: string; tag?: string; text?: string; limit?: number }) {
  let projectId = scope.projectId;
  if (args.project && scope.schedule?.global) {
    const [project] = await ctx.db.select().from(projects).where(eq(projects.key, args.project.trim().toUpperCase()));
    if (!project || project.kind !== 'project') throw badRequest(`No project ${args.project}`);
    projectId = project.id;
  }
  const statusRows = await ctx.db.select().from(statuses).where(eq(statuses.projectId, projectId));
  const tagRows = await ctx.db.select().from(tags).where(eq(tags.projectId, projectId));
  const tag = args.tag ? tagRows.find((l) => l.name.toLowerCase() === args.tag!.toLowerCase()) : undefined;
  if (args.tag && !tag) throw badRequest(`No tag named "${args.tag}" in the project`);
  const cards = await loadCards(ctx.db, {
    projectId,
    includeClosed: args.status_category === 'closed',
    filter: { assignees: [], tags: tag ? [tag.id] : [], priorities: [], text: args.text ?? '' },
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
  if (!project || project.kind !== 'project') throw badRequest(`No project ${args.project}`);
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
