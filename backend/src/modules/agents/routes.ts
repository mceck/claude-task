import { AGENT_AVATAR_MAX_BYTES, AGENT_AVATAR_TYPES, createAgentBody, duplicateAgentBody, updateAgentBody } from '@claude-task/shared';
import type { AgentUsage, JobDetail } from '@claude-task/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { agents, credentials, jobs, projects, schedules, statuses, tasks } from '../../db/schema';
import { badRequest, conflict, notFound, parse } from '../../errors';
import { latestRateLimits } from '../credentials/service';
import { withDefaultSkills } from '../extensions/platform-skill';
import { getTaskRow, unassignDeletedAgent } from '../tasks/service';
import { retrySession, stopTurn } from '../../sessions/lifecycle';
import { notifyAgent } from '../../sessions/notify';
import { refreshProjectSkills } from '../../sessions/project-skills';
import { loadTaskSession } from '../../sessions/view';
import { getAgentRow, loadAgent, loadAgents, loadJobs, taskRefs } from './service';
import type { AgentRow } from './service';
import { agentExtensions, setAssignments } from '../extensions/service';
import { idOrKey } from '../../ids';
import { receiveAvatar } from '../avatar';

const params = z.object({ id: z.uuid() });
const taskParams = z.object({ id: idOrKey });

async function assertCredential(db: Executor, id: string): Promise<void> {
  const [row] = await db.select({ id: credentials.id }).from(credentials).where(eq(credentials.id, id));
  if (!row) throw badRequest('Unknown credential');
}

export function agentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { config: { auth: 'admin' as const } };

  app.get('/agents', async () => ({ agents: await loadAgents(ctx.db) }));

  app.get('/agents/:id', async (request) => {
    const { id } = parse(params, request.params);
    return { agent: await loadAgent(ctx.db, id) };
  });

  app.post('/agents', admin, async (request, reply) => {
    const body = parse(createAgentBody, request.body);
    await assertCredential(ctx.db, body.credentialId);
    const { skillIds, mcpServerIds, pluginIds, ...fields } = body;
    const row = await ctx.db.transaction(async (tx) => {
      const [created] = await tx.insert(agents).values(fields).returning();
      await setAssignments(tx, created!.id, { skillIds: await withDefaultSkills(tx, skillIds), mcpServerIds, pluginIds });
      return created!;
    });
    return reply.status(201).send({ agent: await loadAgent(ctx.db, row.id) });
  });

  app.patch('/agents/:id', admin, async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateAgentBody, request.body);
    if (body.credentialId !== undefined) await assertCredential(ctx.db, body.credentialId);
    await getAgentRow(ctx.db, id);
    const { skillIds, mcpServerIds, pluginIds, ...fields } = body;
    await ctx.db.transaction(async (tx) => {
      await getAgentRow(tx, id, { lock: true });
      await tx.update(agents).set({ ...fields, updatedAt: new Date() }).where(eq(agents.id, id));
      await setAssignments(tx, id, { skillIds, mcpServerIds, pluginIds });
    });
    // New Extensions or an Agent enabled again: the Workers with its Profile or its work synchronize and dispatch now.
    ctx.scheduler.refreshAgents([id]);
    ctx.scheduler.publishAgent(id);
    return { agent: await loadAgent(ctx.db, id) };
  });

  app.get('/agents/:id/avatar', async (request, reply) => {
    const { id } = parse(params, request.params);
    const agent = await getAgentRow(ctx.db, id);
    const blob = agent.avatarBlobId ? await ctx.blobs.get(agent.avatarBlobId) : null;
    if (!blob) throw notFound('Avatar');
    return reply
      .header('content-type', blob.metadata.contentType)
      .header('content-length', String(blob.metadata.size))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      // The URL carries the blob id, so a new image is a new URL.
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(blob.stream);
  });

  app.put('/agents/:id/avatar', admin, async (request) => {
    const { id } = parse(params, request.params);
    await getAgentRow(ctx.db, id);
    const blobId = await receiveAvatar(ctx, request, AGENT_AVATAR_MAX_BYTES, AGENT_AVATAR_TYPES);
    // Read the previous image under the row lock, so concurrent replacements each delete exactly the blob they replaced.
    const before = await ctx.db.transaction(async (tx) => {
      const row = await getAgentRow(tx, id, { lock: true });
      await tx.update(agents).set({ avatarBlobId: blobId, updatedAt: new Date() }).where(eq(agents.id, id));
      return row;
    }).catch(async (err) => {
      await ctx.blobs.delete(blobId);
      throw err;
    });
    if (before.avatarBlobId) await ctx.blobs.delete(before.avatarBlobId);
    ctx.scheduler.publishAgent(id);
    return { agent: await loadAgent(ctx.db, id) };
  });

  app.delete('/agents/:id/avatar', admin, async (request) => {
    const { id } = parse(params, request.params);
    const before = await ctx.db.transaction(async (tx) => {
      const row = await getAgentRow(tx, id, { lock: true });
      await tx.update(agents).set({ avatarBlobId: null, updatedAt: new Date() }).where(eq(agents.id, id));
      return row;
    });
    if (before.avatarBlobId) await ctx.blobs.delete(before.avatarBlobId);
    ctx.scheduler.publishAgent(id);
    return { agent: await loadAgent(ctx.db, id) };
  });

  app.delete('/agents/:id', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    const avatarBlobId = (await getAgentRow(ctx.db, id)).avatarBlobId;
    const actor = userActor(currentUser(request));
    await transact(ctx, async (tx, after) => {
      await getAgentRow(tx, id, { lock: true });
      // Open Tasks (Wiki Chats included, which never close) keep their Agent.
      const open = await tx
        .select({ taskId: tasks.id })
        .from(tasks)
        .innerJoin(statuses, eq(statuses.id, tasks.statusId))
        .where(and(eq(tasks.agentId, id), ne(statuses.category, 'closed')));
      if (open.length > 0) {
        const refs = await taskRefs(tx, open.map((o) => o.taskId));
        throw conflict(`The agent is assigned to open tasks: ${[...refs.values()].map((t) => t.key).join(', ')}. Unassign it first.`);
      }
      const [wiki] = await tx
        .select({ name: projects.name })
        .from(projects)
        .where(and(eq(projects.defaultAgentId, id), eq(projects.kind, 'wiki')));
      if (wiki) throw conflict(`This agent is the default agent of the Wiki "${wiki.name}". Choose another one first.`);
      const [schedule] = await tx.select({ name: schedules.name }).from(schedules).where(eq(schedules.agentId, id));
      if (schedule) throw conflict(`This agent runs the Schedule "${schedule.name}". Choose another agent for it first.`);
      await unassignDeletedAgent(tx, after, id, actor);
      await tx.delete(agents).where(eq(agents.id, id));
    });
    if (avatarBlobId) await ctx.blobs.delete(avatarBlobId);
    ctx.scheduler.publishAgent(id);
    return reply.status(204).send();
  });

  app.post('/agents/:id/duplicate', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    const { name } = parse(duplicateAgentBody, request.body ?? {});
    const source = await getAgentRow(ctx.db, id);
    // Blobs are owned by one row, so the copy gets its own (removed again if the copy fails).
    const original = source.avatarBlobId ? await ctx.blobs.get(source.avatarBlobId) : null;
    const avatarBlobId = original ? (await ctx.blobs.put(original.stream, original.metadata)).id : null;
    let row: AgentRow;
    try {
      row = await ctx.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(agents)
          .values({
            name: name ?? (await copyName(tx, source.name)),
            avatarEmoji: source.avatarEmoji,
            avatarColor: source.avatarColor,
            avatarBlobId,
            description: source.description,
            env: source.env,
            credentialId: source.credentialId,
            model: source.model,
            effort: source.effort,
            permissionMode: source.permissionMode,
            systemPrompt: source.systemPrompt,
            enabled: source.enabled,
          })
          .returning();
        const extensions = await agentExtensions(tx, source.id);
        await setAssignments(tx, created!.id, {
          skillIds: extensions.skills.map((s) => s.id),
          mcpServerIds: extensions.mcpServers.map((s) => s.id),
          pluginIds: extensions.plugins.map((p) => p.id),
        });
        return created!;
      });
    } catch (err) {
      if (avatarBlobId) await ctx.blobs.delete(avatarBlobId);
      throw err;
    }
    return reply.status(201).send({ agent: await loadAgent(ctx.db, row.id) });
  });

  // Jobs and usage

  app.get('/agents/:id/jobs', async (request) => {
    const { id } = parse(params, request.params);
    return { jobs: await loadJobs(ctx.db, { agentId: id, limit: 30 }) };
  });

  app.get('/jobs/:id', async (request) => {
    const { id } = parse(params, request.params);
    const [job] = await loadJobs(ctx.db, { jobIds: [id] });
    if (!job) throw notFound('Job');
    const [row] = await ctx.db.select().from(jobs).where(eq(jobs.id, id));
    const detail: JobDetail = { ...job, setupOutput: row!.setupOutput, stderr: row!.stderr, claudeVersion: row!.claudeVersion };
    return { job: detail };
  });

  app.get('/agents/:id/usage', async (request) => {
    const { id } = parse(params, request.params);
    const agent = await getAgentRow(ctx.db, id);
    const sums = sql`count(*)::int as turns, coalesce(sum(cost_usd), 0)::float8 as cost,
      coalesce(sum((usage->>'inputTokens')::bigint), 0)::float8 as input, coalesce(sum((usage->>'outputTokens')::bigint), 0)::float8 as output,
      coalesce(sum((usage->>'cacheReadTokens')::bigint), 0)::float8 as cache_read, coalesce(sum((usage->>'cacheCreationTokens')::bigint), 0)::float8 as cache_creation`;
    type Sum = { turns: number; cost: number; input: number; output: number; cache_read: number; cache_creation: number };
    const usage = (r: Sum) => ({ turns: r.turns, costUsd: r.cost, inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cache_read, cacheCreationTokens: r.cache_creation });
    const [total] = (await ctx.db.execute<Sum>(sql`select ${sums} from turns where agent_id = ${id}`)).rows;
    const byDay = (await ctx.db.execute<Sum & { day: string }>(sql`
      select to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD') as day, ${sums} from turns
      where agent_id = ${id} and finished_at > now() - interval '30 days' group by 1 order by 1`)).rows;
    const byTask = (await ctx.db.execute<Sum & { task_id: string }>(sql`
      select task_id, ${sums} from turns where agent_id = ${id} group by task_id order by cost desc limit 20`)).rows;
    const refs = await taskRefs(ctx.db, byTask.map((r) => r.task_id));
    const result: AgentUsage & { rateLimit: unknown } = {
      total: usage(total!),
      byDay: byDay.map((r) => ({ key: r.day, ...usage(r) })),
      byTask: byTask.map((r) => ({ key: refs.get(r.task_id)?.key ?? 'deleted', taskId: r.task_id, ...usage(r) })),
      rateLimit: (await latestRateLimits(ctx.db, [agent.credentialId])).get(agent.credentialId) ?? null,
    };
    return result;
  });

  // The Session of a Task

  app.get('/tasks/:id/session', async (request) => {
    const { id } = parse(taskParams, request.params);
    const task = await getTaskRow(ctx.db, id);
    // Before the Session's next Job: the Worktree already has the Project Skills claude will load.
    await refreshProjectSkills(ctx, task.id);
    return { session: await loadTaskSession(ctx.db, task.id) };
  });

  app.post('/tasks/:id/session/stop', async (request) => {
    const { id } = parse(taskParams, request.params);
    const task = await getTaskRow(ctx.db, id);
    await transact(ctx, (tx, after) => stopTurn(tx, after, task.id));
    return { session: await loadTaskSession(ctx.db, task.id) };
  });

  app.post('/tasks/:id/session/retry', async (request) => {
    const { id } = parse(taskParams, request.params);
    const task = await getTaskRow(ctx.db, id);
    await transact(ctx, (tx, after) => retrySession(tx, after, task.id));
    return { session: await loadTaskSession(ctx.db, task.id) };
  });

  app.post('/tasks/:id/session/notify', async (request) => {
    const { id } = parse(taskParams, request.params);
    const task = await getTaskRow(ctx.db, id);
    const actor = userActor(currentUser(request));
    await transact(ctx, (tx, after) => notifyAgent(tx, after, task.id, actor));
    return { session: await loadTaskSession(ctx.db, task.id) };
  });
}

/** `<name> (copy)`, then `(copy 2)`, … : the first one free, within the 100-character limit. */
async function copyName(db: Executor, source: string): Promise<string> {
  const taken = new Set((await db.select({ name: agents.name }).from(agents)).map((a) => a.name.toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const candidate = `${source.slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
