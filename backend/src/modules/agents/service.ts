import { AGENTS_TOPIC, agentTopic, API_PREFIX, taskKey } from '@claude-task/shared';
import type { Agent, AgentRef, AgentState, AgentBuild, Job, QueueEntryKind, TaskRef } from '@claude-task/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { agentBuilds, agentMcpServers, agents, agentSkills, credentials, jobs, projects, queueEntries, skills, tasks, turns } from '../../db/schema';
import { notFound } from '../../errors';

export type AgentRow = typeof agents.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

export const ACTIVE_JOB_STATES = ['dispatched', 'running', 'finishing'] as const;

/** What the container should be: compared with what it was created with to spot pending recreations. */
export function desiredContainerSpec(a: Pick<AgentRow, 'imageTag' | 'cpuLimit' | 'memoryMb'>): string | null {
  return a.imageTag ? JSON.stringify({ image: a.imageTag, cpu: a.cpuLimit, mem: a.memoryMb }) : null;
}

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

export async function loadAgents(db: Executor, isConnected: (agentId: string) => boolean, ids?: string[]): Promise<Agent[]> {
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
  const queued = await db
    .select({ agentId: queueEntries.agentId, n: sql<number>`count(*)::int` })
    .from(queueEntries)
    .where(inArray(queueEntries.agentId, agentIds))
    .groupBy(queueEntries.agentId);
  const refs = await taskRefs(db, active.map((a) => a.taskId));
  const assignedSkills = await db.select({ agentId: agentSkills.agentId, id: skills.id, name: skills.name, description: skills.description, userInvocable: skills.userInvocable })
    .from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(inArray(agentSkills.agentId, agentIds)).orderBy(asc(skills.name));
  const assignedMcp = await db.select().from(agentMcpServers).where(inArray(agentMcpServers.agentId, agentIds));

  return rows.map(({ agent: a, credentialName }) => {
    const job = active.find((j) => j.agentId === a.id);
    const runnerConnected = isConnected(a.id);
    const desired = desiredContainerSpec(a);
    return {
      ...agentRef(a),
      skillIds: assignedSkills.filter((s) => s.agentId === a.id).map((s) => s.id),
      mcpServerIds: assignedMcp.filter((s) => s.agentId === a.id).map((s) => s.mcpServerId),
      skillCommands: assignedSkills.filter((s) => s.agentId === a.id && s.userInvocable).map(({ name, description }) => ({ name, description })),
      extensionsPending: a.extensionsRevision !== a.configuredExtensionsRevision,
      extensionsError: a.extensionsError,
      description: a.description,
      dockerfile: a.dockerfile,
      credentialId: a.credentialId,
      credentialName,
      model: a.model,
      effort: a.effort,
      permissionMode: a.permissionMode,
      systemPrompt: a.systemPrompt,
      cpuLimit: a.cpuLimit,
      memoryMb: a.memoryMb,
      enabled: a.enabled,
      imageState: a.imageState,
      containerState: a.containerState,
      runnerConnected,
      recreatePending: desired !== null && a.containerSpec !== null && a.containerSpec !== desired,
      state: agentState(a, runnerConnected, !!job),
      currentTask: job ? (refs.get(job.taskId) ?? null) : null,
      queueLength: queued.find((q) => q.agentId === a.id)?.n ?? 0,
      lastActivityAt: a.lastActivityAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  });
}

function agentState(a: AgentRow, runnerConnected: boolean, working: boolean): AgentState {
  if (!a.enabled) return 'disabled';
  if (a.imageState === 'building') return 'building';
  if (a.imageState === 'failed') return 'build_failed';
  if (!runnerConnected) return 'offline';
  return working ? 'working' : 'idle';
}

export async function loadAgent(db: Executor, isConnected: (agentId: string) => boolean, id: string): Promise<Agent> {
  const [agent] = await loadAgents(db, isConnected, [id]);
  if (!agent) throw notFound('Agent');
  return agent;
}

export async function getAgentRow(db: Executor, id: string, opts: { lock?: boolean } = {}): Promise<AgentRow> {
  const query = db.select().from(agents).where(eq(agents.id, id));
  const [row] = await (opts.lock ? query.for('update') : query);
  if (!row) throw notFound('Agent');
  return row;
}

/** Locks several Agents in id order, the order every scheduling transaction uses. */
export async function lockAgents(db: Executor, ids: string[]): Promise<AgentRow[]> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return [];
  return db.select().from(agents).where(inArray(agents.id, unique)).orderBy(asc(agents.id)).for('update');
}

/** Publishes the Agent's current state on the Agents topics (loaded after commit). */
export async function publishAgent(ctx: AppContext, agentId: string): Promise<void> {
  const [agent] = await loadAgents(ctx.db, (id) => ctx.runners.isConnected(id), [agentId]);
  if (!agent) {
    ctx.hub.publish(AGENTS_TOPIC, { type: 'agent.deleted', agentId });
    ctx.hub.publish(agentTopic(agentId), { type: 'agent.deleted', agentId });
    return;
  }
  ctx.hub.publish(AGENTS_TOPIC, { type: 'agent.updated', agent });
  ctx.hub.publish(agentTopic(agentId), { type: 'agent.updated', agent });
}

export function serializeBuild(b: typeof agentBuilds.$inferSelect): AgentBuild {
  return {
    id: b.id,
    agentId: b.agentId,
    status: b.status,
    baseVersion: b.baseVersion,
    log: b.log,
    startedAt: b.startedAt.toISOString(),
    finishedAt: b.finishedAt?.toISOString() ?? null,
  };
}

export async function loadBuilds(db: Executor, agentId: string, limit = 20): Promise<AgentBuild[]> {
  const rows = await db
    .select()
    .from(agentBuilds)
    .where(eq(agentBuilds.agentId, agentId))
    .orderBy(desc(agentBuilds.startedAt))
    .limit(limit);
  return rows.map(serializeBuild);
}

// Jobs

export async function loadJobs(db: Executor, where: { agentId?: string; jobIds?: string[]; limit?: number }): Promise<Job[]> {
  if (where.jobIds && where.jobIds.length === 0) return [];
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        where.agentId ? eq(jobs.agentId, where.agentId) : undefined,
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
  return rows.map((r) => {
    const t = totals.find((x) => x.jobId === r.id);
    return serializeJob(r, refs.get(r.taskId)!, t);
  });
}

export function serializeJob(
  r: JobRow,
  task: TaskRef,
  t?: { turns: number; cost: number; input: number; output: number; cacheRead: number; cacheCreation: number },
): Job {
  return {
    id: r.id,
    sessionId: r.sessionId,
    agentId: r.agentId,
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
