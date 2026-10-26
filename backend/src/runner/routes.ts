import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context';
import { agents, attachments, comments, jobs } from '../db/schema';
import { notFound, parse, unauthorized } from '../errors';
import { ACTIVE_JOB_STATES } from '../modules/agents/service';
import { hashToken } from '../secrets';
import { handleRunnerClosed, handleRunnerMessage } from './handlers';

const PING_INTERVAL_MS = 30_000;
const params = z.object({ id: z.uuid() });

/** The Runner's bearer token maps to exactly one Agent. */
async function runnerAgent(ctx: AppContext, request: FastifyRequest): Promise<string> {
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token) throw unauthorized('Missing runner token');
  const [agent] = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.runnerTokenHash, hashToken(token)));
  if (!agent) throw unauthorized('Unknown runner token');
  return agent.id;
}

export function runnerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const agentOf = new WeakMap<FastifyRequest, string>();

  app.get(
    '/runner',
    {
      websocket: true,
      config: { auth: 'public' },
      preValidation: async (request) => {
        agentOf.set(request, await runnerAgent(ctx, request));
      },
    },
    (socket, request) => {
      const agentId = agentOf.get(request)!;
      ctx.runners.attach(agentId, socket, {
        message: (msg) => handleRunnerMessage(ctx, agentId, msg),
        close: () => handleRunnerClosed(ctx, agentId),
      });
      const ping = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, PING_INTERVAL_MS);
      socket.on('close', () => clearInterval(ping));
    },
  );

  /** Attachments of the Task the Agent is working on, fetched into its Worktree. */
  app.get('/runner/attachments/:id', { config: { auth: 'public' } }, async (request, reply) => {
    const agentId = await runnerAgent(ctx, request);
    const { id } = parse(params, request.params);
    // Files of comments need a visible comment; files of the description belong to the task itself.
    const [row] = await ctx.db
      .select({ attachment: attachments })
      .from(attachments)
      .leftJoin(comments, eq(comments.id, attachments.commentId))
      .innerJoin(
        jobs,
        and(eq(jobs.taskId, sql`coalesce(${attachments.taskId}, ${comments.taskId})`), eq(jobs.agentId, agentId), inArray(jobs.state, [...ACTIVE_JOB_STATES])),
      )
      .where(and(eq(attachments.id, id), or(isNotNull(attachments.taskId), and(eq(comments.internal, false), isNull(comments.deletedAt)))))
      .limit(1);
    if (!row) throw notFound('Attachment');
    const blob = await ctx.blobs.get(row.attachment.blobId);
    if (!blob) throw notFound('Attachment');
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(blob.metadata.size))
      .send(blob.stream);
  });
}
