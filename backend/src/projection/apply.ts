import { taskTopic } from '@claude-task/shared';
import type { AgentItem } from '@claude-task/shared';
import { eq, sql } from 'drizzle-orm';
import type { AfterCommit } from '../context';
import type { Executor } from '../db/client';
import { agentItems, comments, jobs, rateLimitObservations, turns } from '../db/schema';
import type { JobRow } from '../modules/agents/service';
import type { Broadcast, Mutation } from './projector';

export type AgentItemRow = typeof agentItems.$inferSelect;

export function serializeAgentItem(r: AgentItemRow): AgentItem {
  return {
    id: r.id,
    taskId: r.taskId,
    sessionId: r.sessionId,
    jobId: r.jobId,
    agentId: r.agentId,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Writes what the projection produced for one event and queues the matching real-time events. */
export async function applyProjection(
  tx: Executor,
  after: AfterCommit,
  job: JobRow,
  credentialId: string,
  mutations: Mutation[],
  broadcasts: Broadcast[],
): Promise<void> {
  const topic = taskTopic(job.taskId);
  const created: string[] = [];
  const updated: string[] = [];
  for (const m of mutations) {
    switch (m.op) {
      case 'comment.create':
        // clock_timestamp keeps the order of items created by one event.
        await tx
          .insert(comments)
          .values({
            id: m.id,
            taskId: job.taskId,
            kind: 'agent',
            authorType: 'agent',
            authorId: job.agentId,
            body: m.body,
            jobId: job.id,
            createdAt: sql`clock_timestamp()`,
          })
          .onConflictDoNothing();
        created.push(m.id);
        break;
      case 'comment.update':
        await tx.update(comments).set({ body: m.body, updatedAt: new Date() }).where(eq(comments.id, m.id));
        if (!created.includes(m.id)) updated.push(m.id);
        break;
      case 'system_comment': {
        const [row] = await tx
          .insert(comments)
          .values({ taskId: job.taskId, kind: 'system', authorType: 'system', authorId: null, body: m.body, jobId: job.id, createdAt: sql`clock_timestamp()` })
          .returning({ id: comments.id });
        created.push(row!.id);
        break;
      }
      case 'item.create': {
        const [row] = await tx
          .insert(agentItems)
          .values({ id: m.id, taskId: job.taskId, sessionId: job.sessionId, jobId: job.id, agentId: job.agentId, kind: m.payload.kind, payload: m.payload })
          .onConflictDoUpdate({ target: agentItems.id, set: { payload: m.payload, updatedAt: new Date() } })
          .returning();
        after.emit(topic, { type: 'agent_item.created', item: serializeAgentItem(row!) });
        break;
      }
      case 'item.update': {
        const [row] = await tx
          .update(agentItems)
          .set({ payload: m.payload, updatedAt: new Date() })
          .where(eq(agentItems.id, m.id))
          .returning();
        if (row) after.emit(topic, { type: 'agent_item.updated', item: serializeAgentItem(row) });
        break;
      }
      case 'turn':
        await tx
          .insert(turns)
          .values({
            jobId: job.id,
            taskId: job.taskId,
            agentId: job.agentId,
            index: m.turn.index,
            startedAt: new Date(m.turn.startedAt),
            finishedAt: new Date(m.turn.finishedAt),
            resultSubtype: m.turn.subtype,
            isError: m.turn.isError,
            stopReason: m.turn.stopReason,
            durationMs: Math.round(m.turn.durationMs),
            numToolCalls: m.turn.toolCalls,
            costUsd: m.turn.costUsd,
            usage: m.turn.usage,
          })
          .onConflictDoNothing();
        break;
      case 'rate_limit':
        await tx.insert(rateLimitObservations).values({ credentialId, agentId: job.agentId, payload: m.info });
        break;
      case 'init':
        await tx.update(jobs).set({ claudeVersion: m.claudeVersion, mcpServers: m.mcpServers }).where(eq(jobs.id, job.id));
        break;
    }
  }
  for (const b of broadcasts) {
    if (b.type === 'live.delta') after.emit(topic, { type: 'live.delta', taskId: job.taskId, delta: b.delta });
    else after.emit(topic, { type: 'live.status', taskId: job.taskId, status: b.status });
  }
  if (created.length > 0) after.effect((ctx) => ctx.scheduler.publishComments(created, 'created'));
  if (updated.length > 0) after.effect((ctx) => ctx.scheduler.publishComments(updated));
}
