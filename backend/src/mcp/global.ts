// Global Task Tools: the Jobs of a global Schedule act on the Tasks of every ordinary Project
// (docs/specs/schedules.md). Editing and moving by key are shared with Board Write Access (tasks.ts).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { transact } from '../context';
import type { AppContext } from '../context';
import { agents, projects } from '../db/schema';
import { badRequest } from '../errors';
import { getTaskRow, updateTask } from '../modules/tasks/service';
import { lockJob, postMessage } from './agents';
import type { JobScope } from './scope';
import { assertOpenTask, createTaskIn, findOpenTask, ordinaryProject } from './tasks';
import { run, taskFields, taskKeyInput } from './tool';

export function registerGlobalTools(server: McpServer, ctx: AppContext, scope: JobScope): void {
  server.registerTool(
    'list_projects',
    {
      description:
        'List the active projects: key, name, description and how many tasks each has per status category. Pass a key as `project` to `list_tasks`, `search_comments` and `create_task_in_project`.',
      inputSchema: {},
    },
    () => run(ctx, () => listProjects(ctx)),
  );
  server.registerTool(
    'create_task_in_project',
    {
      description: 'Create a new task in any project, with no user assignees and no agent. Answers with its key.',
      inputSchema: {
        project: z.string().trim().min(1).max(10).describe('Project key, e.g. API'),
        title: taskFields.title,
        description: taskFields.description.optional(),
        priority: taskFields.priority.optional().describe('Default `none`'),
        tags: taskFields.tags.optional(),
      },
    },
    ({ project, ...task }) => run(ctx, async () => createTaskIn(ctx, scope, (await ordinaryProject(ctx.db, project)).id, task)),
  );
  server.registerTool(
    'assign_task_to_me',
    {
      description:
        'Assign a task of any project to yourself. It starts no work: call `start_task` next. Refused when another agent has the task, when it is closed, and for your own task.',
      inputSchema: { key: taskKeyInput },
    },
    ({ key }) => run(ctx, () => assignToMe(ctx, scope, key)),
  );
  server.registerTool(
    'start_task',
    {
      description:
        'Start a task assigned to you: posts `prompt` as your comment on it, which becomes its first message. You work on it in a session of its own once this run is over, in the same container, one task at a time. Read its progress later with `get_task`.',
      inputSchema: {
        key: taskKeyInput,
        prompt: z.string().trim().min(1).max(100_000).describe('A self-contained brief: the goal and what done looks like'),
      },
    },
    ({ key, prompt }) => run(ctx, () => startTask(ctx, scope, key, prompt)),
  );
}

async function listProjects(ctx: AppContext) {
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

async function assignToMe(ctx: AppContext, scope: JobScope, key: string) {
  const row = await findOpenTask(ctx.db, scope, key);
  if (row.id === scope.taskId) throw badRequest('This is your own task.');
  const task = await transact(ctx, async (tx, after) => {
    const current = await getTaskRow(tx, row.id, { lock: true });
    if (current.agentId && current.agentId !== scope.agentId) {
      const [other] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, current.agentId));
      throw badRequest(`${key} is assigned to ${other?.name ?? 'another agent'}.`);
    }
    return updateTask(tx, after, row.id, { version: current.version, agentId: scope.agentId }, scope.actor);
  });
  return { assigned: task.key, next: 'Call start_task to begin the work.' };
}

async function startTask(ctx: AppContext, scope: JobScope, key: string, prompt: string) {
  const row = await findOpenTask(ctx.db, scope, key);
  return transact(ctx, async (tx, after) => {
    await lockJob(tx, scope, 'the task could be started');
    const current = await getTaskRow(tx, row.id, { lock: true });
    await assertOpenTask(tx, current.id);
    if (current.agentId !== scope.agentId) throw badRequest(`${key} is not assigned to you: call assign_task_to_me first.`);
    // Starting its own work is what a global Schedule is for: the start cap is for other Agents.
    const posted = await postMessage(tx, after, scope, current.id, current.agentId, prompt, { capped: false });
    return { started: key, comment: posted.commentId, next: 'The task runs in its own session once you are free; read it later with get_task.' };
  });
}
