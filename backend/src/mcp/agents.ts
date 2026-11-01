// Task Tools that reach other Agents: writing in another Task's Conversation, starting an Agent on a
// Task, and the Agents to choose from. Board Write Access turns them on (docs/specs/agent-sessions.md).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AfterCommit, AppContext } from '../context';
import { transact } from '../context';
import type { Executor } from '../db/client';
import { agents, comments, jobs, sessions } from '../db/schema';
import { badRequest, unauthorized } from '../errors';
import { loadAgents } from '../modules/agents/service';
import { createAgentComment } from '../modules/comments/service';
import { getTaskRow, updateTask } from '../modules/tasks/service';
import { deliverComment } from '../sessions/lifecycle';
import { getEntry } from '../sessions/queue';
import { assertJobActive } from './scope';
import type { JobScope } from './scope';
import { assertOpenTask, findOpenTask } from './tasks';
import { run, taskKeyInput } from './tool';

/** Sessions one Job may start through `comment_on_task` and `start_agent`: a guard against chains of Agents. */
export const STARTS_PER_JOB = 3;

export function registerAgentTools(server: McpServer, ctx: AppContext, scope: JobScope): void {
  server.registerTool(
    'list_agents',
    {
      description:
        'List the enabled agents, freest first: name, description, state, current task and queue length. States: `idle` (connected and free), `working` (on a job), `offline` (container stopped, it wakes when work arrives), `building` or `build_failed` (image not ready). Pick one whose description fits the work, preferring an empty queue.',
      inputSchema: {},
    },
    () => run(ctx, () => listAgents(ctx)),
  );

  server.registerTool(
    'start_agent',
    {
      description:
        "Give a task of your project to another agent: assigns it when the task has no agent, then posts `prompt` as your comment on that task, which starts the agent's session, or waits in its queue while it works on something else. The task must be unassigned or already that agent's, open, and not your own. Create the task first with `create_task` when it does not exist. At most 3 sessions started per job.",
      inputSchema: {
        key: taskKeyInput,
        agent: z.string().trim().min(1).max(64).describe("The agent's name, case-insensitive (see `list_agents`)"),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(100_000)
          .describe('A self-contained brief: the goal, what done looks like, what not to touch, and whether to report back on your task with `comment_on_task`'),
      },
    },
    (args) => run(ctx, () => startAgent(ctx, scope, args)),
  );

  server.registerTool(
    'comment_on_task',
    {
      description:
        "Write a comment, signed by you, in another task's conversation of your project. The agent assigned to that task receives it as a message: mid-turn when it is working on that task, otherwise queued, starting its session if it has not started yet. It notifies no human. Your own task and closed tasks are refused. Write only when it carries information: every comment costs the other agent a turn.",
      inputSchema: { key: taskKeyInput, body: z.string().trim().min(1).max(100_000).describe('Markdown') },
    },
    ({ key, body }) => run(ctx, () => commentOnTask(ctx, scope, key, body)),
  );
}

async function listAgents(ctx: AppContext) {
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

async function commentOnTask(ctx: AppContext, scope: JobScope, key: string, body: string) {
  const row = await findOpenTask(ctx.db, scope, key);
  if (row.id === scope.taskId) throw badRequest('That is your own task: your text already goes there.');
  return transact(ctx, async (tx, after) => {
    await lockJob(tx, scope, 'the comment could be posted');
    const current = await getTaskRow(tx, row.id, { lock: true });
    await assertOpenTask(tx, current.id);
    const posted = await postMessage(tx, after, scope, current.id, current.agentId, body, { capped: true });
    return { posted: posted.commentId, task: key, sessionStarted: posted.sessionStarted };
  });
}

async function startAgent(ctx: AppContext, scope: JobScope, args: { key: string; agent: string; prompt: string }) {
  const row = await findOpenTask(ctx.db, scope, args.key);
  if (row.id === scope.taskId) throw badRequest('That is your own task: work on it directly.');
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(sql`lower(${agents.name}) = ${args.agent.trim().toLowerCase()}`);
  if (!agent) {
    const all = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.enabled, true)).orderBy(asc(agents.name));
    throw badRequest(`No agent named "${args.agent}". Available: ${all.map((a) => a.name).join(', ') || 'none'}`);
  }
  if (!agent.enabled) throw badRequest(`${agent.name} is disabled.`);
  if (agent.id === scope.agentId) throw badRequest('That is you: start another agent, or do the work on your own task.');
  return transact(ctx, async (tx, after) => {
    await lockJob(tx, scope, 'the agent could be started');
    const current = await getTaskRow(tx, row.id, { lock: true });
    await assertOpenTask(tx, current.id);
    if (current.agentId && current.agentId !== agent.id) {
      const [other] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, current.agentId));
      throw badRequest(`${args.key} is assigned to ${other?.name ?? 'another agent'}.`);
    }
    if (!current.agentId) await updateTask(tx, after, current.id, { version: current.version, agentId: agent.id }, scope.actor);
    const posted = await postMessage(tx, after, scope, current.id, agent.id, args.prompt, { capped: true });
    return { started: args.key, agent: agent.name, comment: posted.commentId, sessionStarted: posted.sessionStarted };
  });
}

/**
 * Serializes the Job's cross-Task writes, so two parallel calls cannot both pass the start cap,
 * and checks the Job is still active.
 */
export async function lockJob(tx: Executor, scope: JobScope, what: string): Promise<void> {
  const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, scope.jobId)).for('update');
  if (!job) throw unauthorized(`Your job ended before ${what}`);
  await assertJobActive(tx, scope, what);
}

/**
 * Posts an Agent Comment by the calling Agent on another Task and delivers it to that Task's Agent.
 * A Comment that starts a Session records the started Agent, which is what the cap counts.
 */
export async function postMessage(
  tx: Executor,
  after: AfterCommit,
  scope: JobScope,
  taskId: string,
  taskAgentId: string | null,
  body: string,
  opts: { capped: boolean },
): Promise<{ commentId: string; sessionStarted: boolean }> {
  const [session] = taskAgentId
    ? await tx.select().from(sessions).where(and(eq(sessions.taskId, taskId), eq(sessions.agentId, taskAgentId)))
    : [];
  // A Session waiting for its first Message, which no earlier Comment has already queued.
  const startsSession = !!session && session.state === 'pending' && !(await getEntry(tx, taskAgentId!, taskId));
  if (startsSession && opts.capped) {
    const [started] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(eq(comments.jobId, scope.jobId), isNotNull(comments.startedAgentId)));
    if ((started?.n ?? 0) >= STARTS_PER_JOB)
      throw badRequest(`You have started ${STARTS_PER_JOB} agents in this job. Finish your own work, or report why the rest is blocked.`);
  }
  const commentId = await createAgentComment(tx, after, { taskId, agentId: scope.agentId, jobId: scope.jobId, body, attachments: [] });
  if (startsSession) await tx.update(comments).set({ startedAgentId: taskAgentId }).where(eq(comments.id, commentId));
  const [comment] = await tx.select().from(comments).where(eq(comments.id, commentId));
  await deliverComment(tx, after, { id: taskId }, comment!);
  return { commentId, sessionStarted: startsSession };
}
