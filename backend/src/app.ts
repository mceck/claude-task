import { wikiRoutes } from './modules/wikis/routes';
import { notificationRoutes } from './notifications/routes';
import { gitRoutes } from './git/routes';
import { gitProxyRoutes } from './git/proxy';
import { GitProviderError } from './git/provider';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { API_PREFIX, GIT_PROXY_PATH } from '@claude-task/shared';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { installGuard } from './auth/guard';
import { authRoutes } from './auth/routes';
import type { AppContext } from './context';
import { fromDatabaseError, HttpError } from './errors';
import { commentRoutes } from './modules/comments/routes';
import { tagRoutes } from './modules/tags/routes';
import { projectRoutes } from './modules/projects/routes';
import { statusRoutes } from './modules/statuses/routes';
import { taskRoutes } from './modules/tasks/routes';
import { userRoutes } from './modules/users/routes';
import { agentRoutes } from './modules/agents/routes';
import { extensionRoutes } from './modules/extensions/routes';
import { credentialRoutes } from './modules/credentials/routes';
import { agentSettingsRoutes } from './modules/projects/agent-settings';
import { mcpRoutes } from './mcp/server';
import { realtimeRoutes } from './realtime/routes';
import { runnerRoutes } from './runner/routes';

/**
 * Defense in depth for the web app: Agents write descriptions and comments users view, so no
 * inline or third-party script may run, and no other site may frame the app. Styles stay
 * inline-capable (the editors set them), and images may come from any HTTPS URL.
 */
const WEB_APP_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

export async function buildApp(
  ctx: AppContext,
  opts: { logger?: boolean | FastifyBaseLogger | { level: string } } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: ctx.config.logLevel },
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  // Claude tool results are single stream-json lines and routinely exceed 64 KB.
  // Browser control messages keep their smaller limit in realtime/routes.ts.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 * 1024 } });
  await app.register(multipart, { limits: { fieldSize: 1024 * 1024, fields: 10 } });

  app.setErrorHandler((err, request, reply) => {
    const known = err instanceof HttpError ? err : err instanceof GitProviderError ? new HttpError(err.status === 409 ? 409 : 502, 'git_provider', err.message) : fromDatabaseError(err);
    if (known) {
      return reply
        .status(known.statusCode)
        .send({ error: { code: known.code, message: known.message, details: known.details }, ...known.extra });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const e = err as { code?: string; message?: string };
      return reply.status(status).send({ error: { code: e.code ?? 'bad_request', message: e.message ?? 'Bad request' } });
    }
    request.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  await app.register(
    async (api) => {
      installGuard(api, ctx);
      api.setNotFoundHandler((_request, reply) =>
        reply.status(404).send({ error: { code: 'not_found', message: 'No such endpoint' } }),
      );
      authRoutes(api, ctx);
      notificationRoutes(api, ctx);
      userRoutes(api, ctx);
      projectRoutes(api, ctx);
      statusRoutes(api, ctx);
      tagRoutes(api, ctx);
      taskRoutes(api, ctx);
      wikiRoutes(api, ctx);
      commentRoutes(api, ctx);
      credentialRoutes(api, ctx);
      gitRoutes(api, ctx);
      agentRoutes(api, ctx);
      extensionRoutes(api, ctx);
      agentSettingsRoutes(api, ctx);
      realtimeRoutes(api, ctx);
      runnerRoutes(api, ctx);
      mcpRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );
  // Outside the API: no Login cookies or CSRF, only Basic auth with a Job token.
  await app.register(async (git) => gitProxyRoutes(git, ctx), { prefix: GIT_PROXY_PATH });

  const staticDir = ctx.config.staticDir ? path.resolve(ctx.config.staticDir) : null;
  if (staticDir && existsSync(path.join(staticDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: staticDir,
      wildcard: false,
      setHeaders: (reply) => reply.headers(WEB_APP_HEADERS),
    });
    // Client-side routes all load the SPA shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET') return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    ctx.hub.closeAll();
    await ctx.runners.closeAll();
  });
  return app;
}
