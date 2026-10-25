import { createCredentialBody, updateCredentialBody } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { parse } from '../../errors';
import { createCredential, deleteCredential, loadCredential, loadCredentials, updateCredential } from './service';

const params = z.object({ id: z.uuid() });

/** Admin only. Secrets are write-only: responses carry the last 4 characters. */
export function credentialRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { config: { auth: 'admin' as const } };

  app.get('/credentials', admin, async () => ({ credentials: await loadCredentials(ctx.db) }));

  app.get('/credentials/:id', admin, async (request) => {
    const { id } = parse(params, request.params);
    return { credential: await loadCredential(ctx.db, id) };
  });

  app.post('/credentials', admin, async (request, reply) => {
    const body = parse(createCredentialBody, request.body);
    return reply.status(201).send({ credential: await createCredential(ctx.db, ctx.config.secrets, body) });
  });

  app.patch('/credentials/:id', admin, async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateCredentialBody, request.body);
    return { credential: await updateCredential(ctx.db, ctx.config.secrets, id, body) };
  });

  app.delete('/credentials/:id', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    await ctx.db.transaction((tx) => deleteCredential(tx, id));
    return reply.status(204).send();
  });
}
