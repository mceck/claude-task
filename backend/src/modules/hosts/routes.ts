import { createHostBody, updateHostBody, WORKERS_TOPIC } from '@claude-task/shared';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { hosts, workers } from '../../db/schema';
import { badRequest, conflict, notFound, parse } from '../../errors';
import { newToken } from '../../secrets';
import { loadHost, loadHosts } from './service';
const params = z.object({ id: z.uuid() });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function hostRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { config: { auth: 'admin' as const } };
  const remote = async (id: string) => {
    const [row] = await ctx.db.select().from(hosts).where(eq(hosts.id, id));
    if (!row) throw notFound('Host');
    if (row.kind === 'local') throw conflict('The Local Host cannot be edited');
    return row;
  };
  const publish = async (id: string) => {
    const host = await loadHost(ctx, id);
    ctx.hub.publish(WORKERS_TOPIC, { type: 'host.updated', host });
    return host;
  };
  const connect = async (id: string, token: string) => {
    const host = await publish(id);
    const url = ctx.config.webUrl ?? 'http://localhost:3000';
    return { host, token, commands: [
      'docker build --target host-controller -t claude-task/host-controller .',
      `docker run -d --name claude-task-host-controller --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock -e ${quote(`CLAUDE_TASK_URL=${url}`)} -e ${quote(`CLAUDE_TASK_HOST_TOKEN=${token}`)}${url.startsWith('http:') && host.allowInsecure ? ' -e CLAUDE_TASK_ALLOW_INSECURE=true' : ''} claude-task/host-controller`,
      'scripts/deploy.sh host',
    ] };
  };
  app.get('/hosts', async () => ({ hosts: await loadHosts(ctx) }));
  app.get('/hosts/:id', async (request) => ({ host: await loadHost(ctx, parse(params, request.params).id) }));
  app.post('/hosts', admin, async (request, reply) => {
    const body = parse(createHostBody, request.body);
    validateTransport(body);
    const { token, hash } = newToken();
    const [row] = await ctx.db.insert(hosts).values({ ...body, kind: 'remote', tokenHash: hash }).returning();
    return reply.status(201).send(await connect(row!.id, token));
  });
  app.patch('/hosts/:id', admin, async (request) => {
    const { id } = parse(params, request.params);
    const body = parse(updateHostBody, request.body);
    const before = await remote(id);
    validateTransport({ ...before, ...body });
    await ctx.db.update(hosts).set({ ...body, updatedAt: new Date() }).where(eq(hosts.id, id));
    for (const worker of await ctx.db.select().from(workers).where(eq(workers.hostId, id))) await ctx.scheduler.reconcile(worker.id);
    return { host: await publish(id) };
  });
  app.post('/hosts/:id/token', admin, async (request) => {
    const { id } = parse(params, request.params);
    await remote(id);
    const { token, hash } = newToken();
    await ctx.db.update(hosts).set({ tokenHash: hash, updatedAt: new Date() }).where(eq(hosts.id, id));
    return connect(id, token);
  });
  app.delete('/hosts/:id', admin, async (request, reply) => {
    const { id } = parse(params, request.params);
    const [row] = await ctx.db.select().from(hosts).where(eq(hosts.id, id));
    if (!row) throw notFound('Host');
    if (row.kind === 'local') throw conflict('The Local Host cannot be deleted');
    const used = await ctx.db.select().from(workers).where(eq(workers.hostId, id));
    if (used.length) throw conflict(`These workers use the Host: ${used.map((w) => w.name).join(', ')}. Move them first.`);
    await ctx.db.delete(hosts).where(eq(hosts.id, id));
    ctx.hub.publish(WORKERS_TOPIC, { type: 'host.deleted', hostId: id });
    return reply.status(204).send();
  });
}
function validateTransport(host: { backendUrlOverride: string | null; allowInsecure: boolean }): void {
  if (host.backendUrlOverride?.startsWith('http:') && !host.allowInsecure) throw badRequest('The backend URL must use https unless insecure connections are allowed');
}
