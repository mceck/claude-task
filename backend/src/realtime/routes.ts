import { taskKey, voiceCommandSchema } from '@claude-task/shared';
import type { ServerMessage, VoiceCommand, VoiceServerMessage } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { projects } from '../db/schema';
import { getTaskRow } from '../modules/tasks/service';
import { idOrKey } from '../ids';
import type { AppContext } from '../context';
import { forbidden, HttpError, parse } from '../errors';
import { isTopic } from './hub';
import { voiceIceConfiguration } from './ice';

const PING_INTERVAL_MS = 30_000;

export function realtimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/tasks/:id/voice', async (request) => {
    const { id } = parse(z.object({ id: idOrKey }), request.params);
    const row = await getTaskRow(ctx.db, id);
    const [project] = await ctx.db.select({ key: projects.key }).from(projects).where(eq(projects.id, row.projectId));
    return { room: ctx.hub.voice.snapshot({ id: row.id, key: taskKey(project!.key, row.number) }) };
  });
  app.get(
    '/ws',
    {
      websocket: true,
      // Cross-site WebSocket hijacking: browsers always send Origin on WS handshakes.
      preValidation: async (request) => {
        const origin = request.headers.origin;
        if (origin && safeHost(origin) !== request.host) throw forbidden('Cross-origin WebSocket refused');
        if (!ctx.loginRevocations.ready) throw new HttpError(503, 'unavailable', 'Realtime is reconnecting. Try again shortly.');
      },
    },
    (socket, request) => {
      if (!ctx.loginRevocations.ready) return socket.close(1013, 'realtime reconnecting');
      const { user, loginId } = request.auth!;
      ctx.hub.add(socket, user.id, loginId);

      let alive = true;
      socket.on('pong', () => (alive = true));
      const ping = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, PING_INTERVAL_MS);
      socket.on('close', () => clearInterval(ping));

      let commands = Promise.resolve();
      let pending = 0, windowStart = Date.now(), count = 0;
      const sendVoiceError = (message: Extract<VoiceServerMessage, { type: 'voice.error' }>) => {
        if (ctx.hub.has(socket)) socket.send(JSON.stringify(message));
      };
      const voiceCommand = async (command: VoiceCommand) => {
        if (!ctx.hub.has(socket)) return;
        if (command.type === 'voice.ice') return ctx.hub.voice.refresh(socket, command.participantId, voiceIceConfiguration(ctx.config, user.id));
        if (command.type !== 'voice.join') return ctx.hub.voice.command(socket, command);
        try {
          await ctx.db.transaction(async (tx) => {
            // Serialize with Task deletion until membership has been admitted.
            const row = await getTaskRow(tx, command.taskId, { lock: true });
            const [project] = await tx.select({ key: projects.key }).from(projects).where(eq(projects.id, row.projectId));
            if (ctx.hub.has(socket)) ctx.hub.voice.join(socket, user, { id: row.id, key: taskKey(project!.key, row.number) }, command, voiceIceConfiguration(ctx.config, user.id));
          });
        } catch (err) {
          sendVoiceError({ type: 'voice.error', requestId: command.requestId, code: err instanceof HttpError && err.statusCode === 404 ? 'not_found' : 'invalid', message: err instanceof HttpError ? err.message : 'Could not join the Voice Room. Try again.' });
        }
      };

      socket.on('message', (raw) => {
        const text = raw.toString();
        if (Buffer.byteLength(text) > 64 * 1024) return socket.close(1009, 'message too large');
        let msg: { type?: unknown; topics?: unknown; requestId?: unknown };
        try {
          msg = JSON.parse(text);
        } catch {
          return socket.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
        }
        if (typeof msg?.type === 'string' && msg.type.startsWith('voice.')) {
          if (Date.now() - windowStart >= 10_000) { windowStart = Date.now(); count = 0; }
          if (++count > 120 || pending >= 128) {
            sendVoiceError({ type: 'voice.error', code: 'rate_limited', message: 'Too many voice commands. Wait a moment and retry.', ...(typeof msg.requestId === 'string' && msg.requestId.length <= 64 ? { requestId: msg.requestId } : {}) });
            // Closing an overloaded leaver releases membership without growing the queue.
            if (msg.type === 'voice.leave') socket.close(1008, 'voice command limit');
            return;
          }
          const parsed = voiceCommandSchema.safeParse(msg);
          if (!parsed.success) return sendVoiceError({ type: 'voice.error', code: 'invalid', message: 'Invalid voice command.', ...(typeof msg.requestId === 'string' && msg.requestId.length <= 64 ? { requestId: msg.requestId } : {}) });
          pending++;
          commands = commands.then(() => voiceCommand(parsed.data)).catch(() => sendVoiceError({ type: 'voice.error', code: 'invalid', message: 'Voice command failed.' })).finally(() => { pending--; });
          return;
        }
        const topics = Array.isArray(msg?.topics) ? msg.topics.filter(isTopic).filter((t) => !t.startsWith('user:') || t === `user:${user.id}`).slice(0, 100) : [];
        // Every user may see every project, so any well-formed topic is allowed.
        if (msg?.type === 'subscribe') {
          ctx.hub.subscribe(socket, topics);
          socket.send(JSON.stringify({ type: 'subscribed', topics } satisfies ServerMessage));
        } else if (msg?.type === 'unsubscribe') ctx.hub.unsubscribe(socket, topics);
        else socket.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
      });
    },
  );
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
