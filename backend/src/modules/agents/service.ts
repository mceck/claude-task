import { AGENTS_TOPIC, agentTopic, API_PREFIX, taskKey } from '@claude-task/shared';
import type { Agent, AgentRef, AgentState, Job, QueueEntryKind, TaskRef } from '@claude-task/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { agentMcpServers, agentPlugins, agentProfiles, agents, agentSkills, credentials, jobs, projects, skills, tasks, turns, workers } from '../../db/schema';
import { notFound } from '../../errors';

export type AgentRow = typeof agents.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

export const ACTIVE_JOB_STATES = ['dispatched', 'running', 'finishing'] as const;

export function agentRef(a: Pick<AgentRow, 'id' | 'name' | 'avatarEmoji' | 'avatarColor' | 'avatarBlobId'>): AgentRef {
  return {
    id: a.id,
    name: a.name,
    avatarEmoji: a.avatarEmoji,
    avatarColor: a.avatarColor,
    avatarImageUrl: a.avatarBlobId ? `${API_PREFIX}/agents/${a.id}/avatar?v=${a.avatarBlobId}` : null,
  };
}

export async function agentRefs(db: Executor, ids: string[]): Promise<Map<string, AgentRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: agents.id, name: agents.name, avatarEmoji: agents.avatarEmoji, avatarColor: agents.avatarColor, avatarBlobId: agents.avatarBlobId })
    .from(agents)
    .where(inArray(agents.id, unique));
  return new Map(rows.map((r) => [r.id, agentRef(r)]));
}

export async function taskRefs(db: Executor, taskIds: string[]): Promise<Map<string, TaskRef>> {
  const unique = [...new Set(taskIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, number: tasks.number, projectId: tasks.projectId, key: projects.key })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(inArray(tasks.id, unique));
  return new Map(rows.map((r) => [r.id, { id: r.id, key: taskKey(r.key, r.number), title: r.title, projectId: r.projectId }]));
}

export async function loadAgents(db: Executor, ids?: string[]): Promise<Agent[]> {
  if (ids && ids.length === 0) return [];
  const rows = await db
    .select({ agent: agents, credentialName: credentials.name })
    .from(agents)
    .innerJoin(credentials, eq(credentials.id, agents.credentialId))
    .where(ids ? inArray(agents.id, ids) : undefined)
    .orderBy(asc(sql`lower(${agents.name})`));
  if (rows.length === 0) return [];
  const agentIds = rows.map((r) => r.agent.id);
  const active = await db
    .select({ agentId: jobs.agentId, taskId: jobs.taskId })
    .from(jobs)
    .where(and(inArray(jobs.agentId, agentIds), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
  const refs = await taskRefs(db, active.map((a) => a.taskId));
  const assignedSkills = await db.select({ agentId: agentSkills.agentId, id: skills.id, name: skills.name, description: skills.description, userInvocable: skills.userInvocable })
    .from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(inArray(agentSkills.agentId, agentIds)).orderBy(asc(skills.name));
  const assignedMcp = await db.select().from(agentMcpServers).where(inArray(agentMcpServers.agentId, agentIds));
  const assignedPlugins = await db.select().from(agentPlugins).where(inArray(agentPlugins.agentId, agentIds));
  const profiles = await db
    .select({ agentId: agentProfiles.agentId, workerId: agentProfiles.workerId, workerName: workers.name, applied: agentProfiles.appliedRevision, error: agentProfiles.error, updatedAt: agentProfiles.updatedAt })
    .from(agentProfiles)
    .innerJoin(workers, eq(workers.id, agentProfiles.workerId))
    .where(inArray(agentProfiles.agentId, agentIds))
    .orderBy(desc(agentProfiles.updatedAt));

  return rows.map(({ agent: a, credentialName }) => {
    const mine = active.filter((j) => j.agentId === a.id);
    const mineProfiles = profiles.filter((p) => p.agentId === a.id);
    const errors = mineProfiles.filter((p) => p.error).map((p) => ({ workerId: p.workerId, workerName: p.workerName, error: p.error! }));
    return {
      ...agentRef(a),
      skillIds: assignedSkills.filter((s) => s.agentId === a.id).map((s) => s.id),
      mcpServerIds: assignedMcp.filter((s) => s.agentId === a.id).map((s) => s.mcpServerId),
      pluginIds: assignedPlugins.filter((p) => p.agentId === a.id).map((p) => p.pluginId),
      skillCommands: assignedSkills.filter((s) => s.agentId === a.id && s.userInvocable).map(({ name, description }) => ({ name, description })),
      extensionsPending: mineProfiles.some((p) => p.applied !== a.extensionsRevision),
      extensionsError: errors[0]?.error ?? null,
      extensionErrors: errors,
      description: a.description,
      env: a.env,
      credentialId: a.credentialId,
      credentialName,
      model: a.model,
      effort: a.effort,
      permissionMode: a.permissionMode,
      systemPrompt: a.systemPrompt,
      enabled: a.enabled,
      state: agentState(a, mine.length),
      activeJobs: mine.length,
      activeTasks: [...new Set(mine.map((j) => j.taskId))].map((id) => refs.get(id)!).filter(Boolean),
      lastActivityAt: a.lastActivityAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  });
}

function agentState(a: AgentRow, activeJobs: number): AgentState {
  if (!a.enabled) return 'disabled';
  return activeJobs > 0 ? 'working' : 'idle';
}

export async function loadAgent(db: Executor, id: string): Promise<Agent> {
  const [agent] = await loadAgents(db, [id]);
  if (!agent) throw notFound('Agent');
  return agent;
}

export async function getAgentRow(db: Executor, id: string, opts: { lock?: boolean } = {}): Promise<AgentRow> {
  const query = db.select().from(agents).where(eq(agents.id, id));
  const [row] = await (opts.lock ? query.for('update') : query);
  if (!row) throw notFound('Agent');
  return row;
}

/** Publishes the Agent's current state on the Agents topics (loaded after commit). */
export async function publishAgent(ctx: AppContext, agentId: string): Promise<void> {
  const [agent] = await loadAgents(ctx.db, [agentId]);
  if (!agent) {
    ctx.hub.publish(AGENTS_TOPIC, { type: 'agent.deleted', agentId });
    ctx.hub.publish(agentTopic(agentId), { type: 'agent.deleted', agentId });
    return;
  }
  ctx.hub.publish(AGENTS_TOPIC, { type: 'agent.updated', agent });
  ctx.hub.publish(agentTopic(agentId), { type: 'agent.updated', agent });
}

// Jobs

export async function loadJobs(db: Executor, where: { agentId?: string; workerId?: string; jobIds?: string[]; limit?: number }): Promise<Job[]> {
  if (where.jobIds && where.jobIds.length === 0) return [];
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        where.agentId ? eq(jobs.agentId, where.agentId) : undefined,
        where.workerId ? eq(jobs.workerId, where.workerId) : undefined,
        where.jobIds ? inArray(jobs.id, where.jobIds) : undefined,
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(where.limit ?? 50);
  if (rows.length === 0) return [];
  const totals = await db
    .select({
      jobId: turns.jobId,
      turns: sql<number>`count(*)::int`,
      cost: sql<number>`coalesce(sum(${turns.costUsd}), 0)::float8`,
      input: sql<number>`coalesce(sum((${turns.usage}->>'inputTokens')::bigint), 0)::float8`,
      output: sql<number>`coalesce(sum((${turns.usage}->>'outputTokens')::bigint), 0)::float8`,
      cacheRead: sql<number>`coalesce(sum((${turns.usage}->>'cacheReadTokens')::bigint), 0)::float8`,
      cacheCreation: sql<number>`coalesce(sum((${turns.usage}->>'cacheCreationTokens')::bigint), 0)::float8`,
    })
    .from(turns)
    .where(inArray(turns.jobId, rows.map((r) => r.id)))
    .groupBy(turns.jobId);
  const refs = await taskRefs(db, rows.map((r) => r.taskId));
  const workerIds = [...new Set(rows.map((r) => r.workerId).filter((id): id is string => !!id))];
  const workerNames = new Map(
    workerIds.length ? (await db.select({ id: workers.id, name: workers.name }).from(workers).where(inArray(workers.id, workerIds))).map((w) => [w.id, w.name]) : [],
  );
  return rows.map((r) => {
    const t = totals.find((x) => x.jobId === r.id);
    return serializeJob(r, refs.get(r.taskId)!, t, r.workerId ? (workerNames.get(r.workerId) ?? null) : null);
  });
}

export function serializeJob(
  r: JobRow,
  task: TaskRef,
  t?: { turns: number; cost: number; input: number; output: number; cacheRead: number; cacheCreation: number },
  workerName: string | null = null,
): Job {
  return {
    id: r.id,
    sessionId: r.sessionId,
    agentId: r.agentId,
    agentName: r.agentName,
    workerId: r.workerId,
    workerName,
    slot: r.slot,
    task,
    kind: r.kind as QueueEntryKind,
    state: r.state,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    exitCode: r.exitCode,
    failureStage: r.failureStage,
    error: r.error,
    turns: t?.turns ?? 0,
    usage: {
      inputTokens: t?.input ?? 0,
      outputTokens: t?.output ?? 0,
      cacheReadTokens: t?.cacheRead ?? 0,
      cacheCreationTokens: t?.cacheCreation ?? 0,
      costUsd: t?.cost ?? 0,
    },
  };
}
