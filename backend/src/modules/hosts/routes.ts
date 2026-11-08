import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { parse } from '../../errors';
import { loadHost, loadHosts } from './service';
const params = z.object({ id: z.uuid() });
export function hostRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/hosts', async () => ({ hosts: await loadHosts(ctx) }));
  app.get('/hosts/:id', async (request) => ({ host: await loadHost(ctx, parse(params, request.params).id) }));
}
