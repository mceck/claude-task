import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context';
import { agents, attachments, comments, jobs } from '../db/schema';
import { badRequest, HttpError, notFound, parse, unauthorized } from '../errors';
import { receiveMultipart } from '../modules/comments/routes';
import { discardBlobs } from '../blobstore';
import { ACTIVE_JOB_STATES } from '../modules/agents/service';
import { hashToken } from '../secrets';
import { handleRunnerClosed, handleRunnerMessage } from './handlers';

const PING_INTERVAL_MS = 30_000;
const params = z.object({ id: z.uuid() });
const uploadParams = z.object({ requestId: z.uuid() });
const manifestSchema = z.array(z.object({ path: z.string(), error: z.string().optional() }));

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
      // A Runner that misses a whole round is gone (e.g. a half-open connection): dropping it lets
      // its Job be recovered instead of looking connected forever.
      let alive = true;
      socket.on('pong', () => (alive = true));
      socket.on('message', () => (alive = true));
      const ping = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        if (socket.readyState !== socket.OPEN) return;
        socket.ping();
        socket.send(JSON.stringify({ type: 'ping' }));
      }, ctx.config.agents.runnerPingIntervalMs ?? PING_INTERVAL_MS);
      socket.on('close', () => clearInterval(ping));
    },
  );

  /** Files an Agent posts, sent by its Runner in answer to `job.upload` while the tool call waits. */
  app.post('/runner/uploads/:requestId', { config: { auth: 'public', csrf: false } }, async (request, reply) => {
    const agentId = await runnerAgent(ctx, request);
    const { requestId } = parse(uploadParams, request.params);
    const pending = ctx.uploads.take(agentId, requestId);
    if (!pending) throw notFound('Upload request');
    if (!request.isMultipart()) {
      pending.fail('the runner sent no files.');
      throw badRequest('Send the files as multipart/form-data');
    }
    let received: Awaited<ReturnType<typeof receiveMultipart>>;
    try {
      received = await receiveMultipart(ctx, request);
    } catch (err) {
      pending.fail(err instanceof HttpError ? `${err.message}.` : 'the upload failed.');
      throw err;
    }
    let manifest: z.infer<typeof manifestSchema> | null = null;
    try {
      manifest = manifestSchema.parse(JSON.parse(String(received.fields.manifest ?? '')));
    } catch {
      manifest = null;
    }
    const consistent =
      manifest &&
      manifest.length === pending.paths.length &&
      manifest.every((e, i) => e.path === pending.paths[i]) &&
      manifest.filter((e) => !e.error).length === received.files.length;
    if (!consistent) {
      await discardBlobs(ctx.blobs, received.files.map((f) => f.blobId));
      pending.fail('the runner sent an inconsistent upload.');
      throw badRequest('The manifest must list every requested path in order, followed by one file per successful entry');
    }
    // The tool call may have given up while the files streamed in.
    if (!pending.complete({ manifest: manifest!, files: received.files })) {
      await discardBlobs(ctx.blobs, received.files.map((f) => f.blobId));
      throw notFound('Upload request');
    }
    return reply.status(204).send();
  });

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
