import type { Host, HostState } from '@claude-task/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { hosts, projects, tasks, workerContainers, workers } from '../../db/schema';
import { notFound } from '../../errors';

export type HostRow = typeof hosts.$inferSelect;
export const hostState = (h: HostRow): HostState =>
  h.connectedAt && (!h.disconnectedAt || h.connectedAt > h.disconnectedAt) ? 'connected' : 'disconnected';
export const backendUrlFor = (ctx: AppContext, h: HostRow): string | null =>
  h.kind === 'local' ? ctx.config.agents.backendUrl : (h.backendUrlOverride ?? h.reportedUrl);

export async function refreshLocalHost(ctx: AppContext): Promise<void> {
  const [local] = await ctx.db.select().from(hosts).where(eq(hosts.kind, 'local'));
  if (!local) return;
  let error: string | null = null;
  try {
    if (ctx.config.localHost === false) throw new Error('Local Host disabled (LOCAL_HOST=false)');
    await ctx.runtimes.probe(local.id).ping();
  } catch (err) {
    error = (err as Error).message.slice(0, 2000);
  }
  // Preserve the time of the transition, rather than resetting it on every ping.
  const connected = !error;
  ctx.runtimes.setConnected(local.id, connected);
  await ctx.db
    .update(hosts)
    .set({
      error,
      ...(connected && hostState(local) !== 'connected' ? { connectedAt: new Date() } : {}),
      ...(!connected && (hostState(local) !== 'disconnected' || !local.disconnectedAt) ? { disconnectedAt: new Date() } : {}),
    })
    .where(eq(hosts.id, local.id));
  if (hostState(local) !== (connected ? 'connected' : 'disconnected') && ctx.controllers) {
    await ctx.controllers.publish(local.id);
    if (connected) await ctx.scheduler.hostReconnected(local.id);
  }
}

export async function loadHosts(ctx: AppContext): Promise<Host[]> {
  const rows = await ctx.db
    .select()
    .from(hosts)
    .orderBy(asc(sql`lower(${hosts.name})`));
  const allWorkers = await ctx.db.select().from(workers);
  const containers = await ctx.db.select().from(workerContainers);
  return rows
    .filter((h) => h.kind !== 'local' || ctx.config.localHost !== false || allWorkers.some((w) => w.hostId === h.id))
    .map((h) => {
      const mine = allWorkers.filter((w) => w.hostId === h.id);
      return {
        id: h.id,
        kind: h.kind,
        name: h.name,
        description: h.description,
        state: hostState(h),
        connectedAt: h.connectedAt?.toISOString() ?? null,
        disconnectedAt: h.disconnectedAt?.toISOString() ?? null,
        controllerVersion: h.controllerVersion,
        dockerVersion: h.dockerVersion,
        os: h.os,
        architecture: h.architecture,
        cpus: h.cpus,
        memoryBytes: h.memoryBytes,
        backendUrl: backendUrlFor(ctx, h),
        backendUrlOverride: h.backendUrlOverride,
        allowInsecure: h.allowInsecure,
        network: h.network,
        error: h.error,
        workers: mine.map(({ id, name }) => ({ id, name })),
        runningContainers: containers.filter(
          (c) => mine.some((w) => w.id === c.workerId) && ['running', 'restarting'].includes(c.containerState),
        ).length,
      };
    });
}
export async function loadHost(ctx: AppContext, id: string): Promise<Host> {
  const host = (await loadHosts(ctx)).find((h) => h.id === id);
  if (!host) throw notFound('Host');
  return host;
}

export function hostConnection(ctx: AppContext, host: HostRow): { backendUrl: string | null; network: string | null } {
  return { backendUrl: backendUrlFor(ctx, host), network: host.kind === 'local' ? ctx.config.agents.network : host.network };
}
export async function workerConnection(ctx: AppContext, db: import('../../db/client').Executor, hostId: string) {
  const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId));
  if (!host) throw notFound('Host');
  return hostConnection(ctx, host);
}
export async function taskBackendUrl(ctx: AppContext, db: import('../../db/client').Executor, taskId: string): Promise<string> {
  const [row] = await db
    .select({ host: hosts })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(workers, eq(workers.id, projects.workerId))
    .innerJoin(hosts, eq(hosts.id, workers.hostId))
    .where(eq(tasks.id, taskId));
  if (!row) throw notFound('Task');
  const url = backendUrlFor(ctx, row.host);
  if (!url) throw new Error('Host has no backend URL yet');
  return url;
}
