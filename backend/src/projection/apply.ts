import { projectTopic, taskTopic } from '@claude-task/shared';
import type { AgentItem } from '@claude-task/shared';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { AfterCommit } from '../context';
import type { Executor } from '../db/client';
import { offerLimitResume, onTurnWorked } from '../modules/scheduled-messages/service';
import { setAlertComment, turnEventId } from '../notifications/alerts';
import { agentItems, comments, jobs, rateLimitObservations, tasks, turns } from '../db/schema';
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
  /** A failed Turn's Alert previews the System Comment its `result` adds right after it. */
  let failedTurnEvent: string | null = null;
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
        if (failedTurnEvent) await setAlertComment(tx, failedTurnEvent, row!.id);
        failedTurnEvent = null;
        if (m.limitResetsAt) await offerLimitResume(tx, after, job.taskId, row!.id, new Date(m.limitResetsAt));
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
      case 'run.create':
        // The transcript lives in memory, so its registry is updated and announced from one
        // effect: the clients never see a Run event the registry can't answer for.
        after.effect((ctx) => {
          const run = ctx.runs.create(job.id, job.taskId, m.id, m.run, m.prompt);
          ctx.hub.publish(topic, { type: 'run.updated', taskId: job.taskId, run });
        });
        break;
      case 'run.message':
        after.effect((ctx) => {
          const message = ctx.runs.message(m.runId, m.message);
          if (!message) return;
          ctx.hub.publish(topic, { type: 'run.message', taskId: job.taskId, runId: m.runId, message });
          // A tool call raises the count the bar and dialog show: announce it while the Run still runs.
          if (message.type === 'tool') {
            const run = ctx.runs.summary(m.runId);
            if (run) ctx.hub.publish(topic, { type: 'run.updated', taskId: job.taskId, run });
          }
        });
        break;
      case 'run.tool_result':
        after.effect((ctx) => {
          const message = ctx.runs.toolResult(m.runId, m.toolUseId, m.status, m.outcome, m.output);
          if (message) ctx.hub.publish(topic, { type: 'run.message', taskId: job.taskId, runId: m.runId, message });
        });
        break;
      case 'run.end':
        after.effect((ctx) => {
          const run = ctx.runs.end(m.runId, m.run, m.usage);
          if (run) ctx.hub.publish(topic, { type: 'run.updated', taskId: job.taskId, run });
        });
        break;
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
            contextTokens: m.turn.context?.tokens ?? null,
            contextWindow: m.turn.context?.window ?? null,
          })
          .onConflictDoNothing();
        if (m.turn.commentId) await setAlertComment(tx, turnEventId(job.id, m.turn.index), m.turn.commentId);
        // The card's tool call count is the sum of the Task's Turns: publish it as each one lands.
        after.effect((ctx) => ctx.scheduler.publishTask(job.taskId));
        {
          // The Turn read the Comments delivered to its Session before its last model call: they
          // are handled. One written while it was finishing waits for the Turn that reads it.
          const handled = await tx
            .update(comments)
            .set({ deliveryState: 'handled' })
            .where(and(eq(comments.taskId, job.taskId), eq(comments.deliveryState, 'delivered'),
              lte(comments.deliveryChangedAt, new Date(m.turn.readUpTo)),
              inArray(comments.deliveredInJobId, tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.sessionId, job.sessionId)))))
            .returning({ id: comments.id });
          for (const { id } of handled) if (!created.includes(id) && !updated.includes(id)) updated.push(id);
        }
        failedTurnEvent = m.turn.isError ? turnEventId(job.id, m.turn.index) : null;
        if (!m.turn.isError) await onTurnWorked(tx, after, job.taskId);
        break;
      case 'rate_limit':
        await tx.insert(rateLimitObservations).values({ credentialId, agentId: job.agentId, payload: m.info });
        break;
      case 'init':
        await tx.update(jobs).set({ claudeVersion: m.claudeVersion, mcpServers: m.mcpServers, slashCommands: m.slashCommands }).where(eq(jobs.id, job.id));
        after.effect((ctx) => ctx.scheduler.publishTask(job.taskId));
        break;
    }
  }
  // The Board's cards follow the context too, from the Project's topic.
  const liveContext = broadcasts.findLast((b) => b.type === 'live.context');
  if (liveContext?.type === 'live.context') {
    const [row] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, job.taskId));
    if (row) after.emit(projectTopic(row.projectId), { type: 'live.context', taskId: job.taskId, context: liveContext.context });
  }
  for (const b of broadcasts) {
    if (b.type === 'live.delta') after.emit(topic, { type: 'live.delta', taskId: job.taskId, delta: b.delta });
    else if (b.type === 'live.context') after.emit(topic, { type: 'live.context', taskId: job.taskId, context: b.context });
    else after.emit(topic, { type: 'live.status', taskId: job.taskId, status: b.status });
  }
  if (created.length > 0) after.effect((ctx) => ctx.scheduler.publishComments(created, 'created'));
  if (updated.length > 0) after.effect((ctx) => ctx.scheduler.publishComments(updated));
}
