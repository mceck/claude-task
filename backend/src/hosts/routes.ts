import { HOST_CONTROLLER_PATH, API_PREFIX } from '@claude-task/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { hosts } from '../db/schema';
import { unauthorized } from '../errors';
import { hashToken } from '../secrets';
import type { HostRow } from '../modules/hosts/service';

export function hostControllerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const identities = new WeakMap<FastifyRequest, HostRow>();
  app.get(
    HOST_CONTROLLER_PATH.slice(API_PREFIX.length),
    {
      websocket: true,
      config: { auth: 'public' },
      preValidation: async (request) => {
        const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
        if (!token) throw unauthorized('Missing Host Token');
        const [host] = await ctx.db
          .select()
          .from(hosts)
          .where(eq(hosts.tokenHash, hashToken(token)));
        if (!host || host.kind !== 'remote') throw unauthorized('Unknown Host Token');
        identities.set(request, host);
      },
    },
    (socket, request) => ctx.controllers.attach(identities.get(request)!, socket),
  );
}
