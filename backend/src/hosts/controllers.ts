import { DockerTunnel } from './tunnel';
import { DockerRuntime } from '../agents/docker-runtime';
import type { WorkerRuntime } from '../agents/runtime';
import { HOST_PROTOCOL_VERSION, WORKERS_TOPIC } from '@claude-task/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { AppContext } from '../context';
import { hosts, workers } from '../db/schema';
import { FakeRuntime } from '../agents/fake-runtime';
import { loadHost } from '../modules/hosts/service';
import type { HostRow } from '../modules/hosts/service';

const helloSchema = z.object({ type: z.literal('hello'), protocolVersion: z.number().int(), controllerVersion: z.string().max(100), backendUrl: z.url({ protocol: /^https?$/ }).max(2000) });
interface Connection { socket: WebSocket; chain: Promise<void>; ready: boolean }

/** One outbound control connection per Remote Host, independent of its Runners. */
export class HostControllers {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Set<Promise<void>>();
  readonly fakeRuntimes = new Map<string, FakeRuntime>();
  constructor(private readonly ctx: AppContext) {}

  disconnect(id: string, code: number, reason: string): void { this.connections.get(id)?.socket.close(code, reason); }
  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.catch((err) => this.ctx.log.warn({ err }, 'Host Controller operation failed')).finally(() => this.pending.delete(work));
  }
  async publish(id: string): Promise<void> {
    const host = await loadHost(this.ctx, id).catch(() => null);
    if (!host) return;
    this.ctx.hub.publish(WORKERS_TOPIC, { type: 'host.updated', host });
    for (const worker of host.workers) this.ctx.scheduler.publishWorker(worker.id);
  }
  attach(host: HostRow, socket: WebSocket): void {
    this.disconnect(host.id, 4001, 'replaced');
    this.ctx.runtimes.detach(host.id);
    const tunnel = this.ctx.config.agents.runtime === 'fake' ? null : new DockerTunnel(socket);
    const conn: Connection = { socket, chain: Promise.resolve(), ready: false };
    this.connections.set(host.id, conn);
    let alive = true;
    const timeout = setTimeout(() => socket.close(4005, 'hello required'), 15_000);
    const ping = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      if (socket.readyState === socket.OPEN) socket.ping();
    }, this.ctx.config.agents.hostPingIntervalMs ?? 30_000);
    ping.unref(); timeout.unref();
    socket.on('pong', () => { alive = true; });
    socket.on('message', (raw, binary) => {
      alive = true;
      if (binary || conn.ready) return;
      conn.chain = conn.chain.then(async () => {
        if (this.connections.get(host.id) !== conn || conn.ready) return;
        const parsed = helloSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) { socket.close(4005, 'invalid hello'); return; }
        clearTimeout(timeout);
        const hello = parsed.data;
        let error: string | null = null;
        let code = 4005;
        if (hello.protocolVersion !== HOST_PROTOCOL_VERSION) error = `The Host Controller speaks protocol ${hello.protocolVersion}, this backend needs ${HOST_PROTOCOL_VERSION}: rebuild it from this version`;
        else if (hello.backendUrl.startsWith('http:') && !host.allowInsecure) { error = 'The Host Controller connects over http, but this Host does not allow insecure connections'; code = 4006; }
        if (error) {
          await this.ctx.db.update(hosts).set({ error, disconnectedAt: new Date() }).where(eq(hosts.id, host.id));
          await this.publish(host.id);
          socket.close(code, code === 4006 ? 'insecure' : 'incompatible controller');
          return;
        }
        // Recheck the hash: a token may have been rotated while this socket upgraded.
        const [current] = await this.ctx.db.select().from(hosts).where(and(eq(hosts.id, host.id), eq(hosts.tokenHash, host.tokenHash!)));
        if (!current) { socket.close(4007, 'token regenerated'); return; }
        let runtime: WorkerRuntime;
        let info = { dockerVersion: 'fake', os: 'linux', architecture: 'amd64', cpus: 4, memoryBytes: 8 * 1024 ** 3 };
        if (tunnel) {
          const docker = tunnel.createClient();
          const [version, system] = await Promise.all([docker.version(), docker.info()]);
          info = { dockerVersion: version.Version, os: system.OSType, architecture: system.Architecture, cpus: system.NCPU, memoryBytes: system.MemTotal };
          runtime = new DockerRuntime({ ...this.ctx.config.agents, network: current.network }, this.ctx.installationId, undefined, docker);
        } else {
          let fake = this.fakeRuntimes.get(host.id);
          if (!fake) { fake = new FakeRuntime(); this.fakeRuntimes.set(host.id, fake); }
          runtime = fake;
        }
        if (this.connections.get(host.id) !== conn || socket.readyState !== socket.OPEN) return;
        this.ctx.runtimes.attach(host.id, runtime);
        await this.ctx.db.update(hosts).set({
          reportedUrl: hello.backendUrl.replace(/\/+$/, ''), controllerVersion: hello.controllerVersion, protocolVersion: hello.protocolVersion,
          ...info,
          connectedAt: new Date(), disconnectedAt: null, error: null,
        }).where(eq(hosts.id, host.id));
        conn.ready = true;
        await this.publish(host.id);
        for (const worker of await this.ctx.db.select().from(workers).where(eq(workers.hostId, host.id))) await this.ctx.scheduler.reconcile(worker.id);
      }).catch((err) => { this.ctx.log.warn({ err, hostId: host.id }, 'Host hello failed'); socket.close(1011, 'hello failed'); });
      this.track(conn.chain);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timeout); clearInterval(ping);
      if (this.connections.get(host.id) !== conn) return;
      this.connections.delete(host.id);
      this.ctx.runtimes.detach(host.id);
      tunnel?.close();
      this.track(conn.chain.then(async () => {
        // A new Controller can arrive while the previous hello is finishing.
        if (this.connections.has(host.id)) return;
        await this.ctx.db.update(hosts).set({ disconnectedAt: new Date() }).where(eq(hosts.id, host.id));
        await this.publish(host.id);
      }));
    });
  }
  async closeAll(): Promise<void> {
    for (const conn of this.connections.values()) conn.socket.terminate();
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
