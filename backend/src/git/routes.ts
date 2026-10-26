import { createGitConnectionBody, repositoryBody, updateGitConnectionBody } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { parse } from '../errors';
import { createConnection, deleteConnection, listConnections, listRepositoryGroups, updateConnection } from './connections';
import { linkRepository, recheckProtection, repositorySettings } from './service';

const params = z.object({ id: z.string().min(1).max(64) });
export function gitRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { config: { auth: 'admin' as const } };
  app.get('/git/connections', admin, async () => ({ connections: await listConnections(ctx) }));
  app.post('/git/connections', admin, async (request, reply) => {
    const connection = await createConnection(ctx, parse(createGitConnectionBody, request.body));
    return reply.status(201).send({ connection });
  });
  app.patch('/git/connections/:id', admin, async (request) => {
    const { id } = parse(params, request.params);
    return { connection: await updateConnection(ctx, id, parse(updateGitConnectionBody, request.body)) };
  });
  app.delete('/git/connections/:id', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    await deleteConnection(ctx, id);
    return reply.status(204).send();
  });
  app.get('/git/repositories', async () => ({ groups: await listRepositoryGroups(ctx) }));
  app.get('/projects/:id/repository', async (request) => {
    const { id } = parse(params, request.params);
    return repositorySettings(ctx.db, id);
  });
  app.put('/projects/:id/repository', async (request) => {
    const { id } = parse(params, request.params);
    await linkRepository(ctx, id, parse(repositoryBody, request.body));
    return repositorySettings(ctx.db, id);
  });
  app.post('/projects/:id/repository/check-protection', async (request) => {
    const { id } = parse(params, request.params);
    await recheckProtection(ctx, id);
    return repositorySettings(ctx.db, id);
  });
}
