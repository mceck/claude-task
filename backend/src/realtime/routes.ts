import type { ClientMessage, ServerMessage } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { forbidden } from '../errors';
import { isTopic } from './hub';

const PING_INTERVAL_MS = 30_000;

export function realtimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    '/ws',
    {
      websocket: true,
      // Cross-site WebSocket hijacking: browsers always send Origin on WS handshakes.
      preValidation: async (request) => {
        const origin = request.headers.origin;
        if (origin && safeHost(origin) !== request.host) throw forbidden('Cross-origin WebSocket refused');
      },
    },
    (socket, request) => {
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

      socket.on('message', (raw) => {
        const text = raw.toString();
        if (Buffer.byteLength(text) > 64 * 1024) return socket.close(1009, 'message too large');
        let msg: ClientMessage;
        try {
          msg = JSON.parse(text) as ClientMessage;
        } catch {
          return socket.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
        }
        const topics = Array.isArray(msg?.topics) ? msg.topics.filter(isTopic).slice(0, 100) : [];
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
