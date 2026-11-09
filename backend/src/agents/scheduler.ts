// Background work around Workers: dispatching, image builds, the reconciler that starts and stops
// Worker Containers between a Worker's minimum and cap, Agent Profile synchronization, and
// publishing scheduling state to browsers. Everything it starts is tracked so tests can settle.
import { agentTopic, pinAgentBase, projectTopic, taskTopic, workerTopic } from '@claude-task/shared';
import type { BackendToRunner, CleanupTrigger } from '@claude-task/shared';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { agentProfiles, agents, hosts, jobs, projects, queueEntries, sessions, tasks, workerBuilds, workerContainers, workers } from '../db/schema';
import { loadTimelinePositions } from '../db/activity';
import { ACTIVE_JOB_STATES, loadJobs, publishAgent } from '../modules/agents/service';
import type { JobRow } from '../modules/agents/service';
import { loadCommentsById } from '../modules/comments/service';
import { runDueMessages } from '../modules/scheduled-messages/service';
import { runDueSchedules } from '../modules/schedules/service';
import { agentExtensions } from '../modules/extensions/service';
import { loadCard } from '../modules/tasks/service';
import { addToCleanup, createCleanup, publishCleanup, volumeCleanupRequest } from '../modules/workers/cleanup';
import { containerRows, desiredContainerSpec, ensureContainerRow, getWorkerRow, isUp, publishWorker, serializeBuild, workerOfTask } from '../modules/workers/service';
import type { WorkerContainerRow, WorkerRow } from '../modules/workers/service';
import { recoverAbandonedJobs } from '../runner/handlers';
import { newToken } from '../secrets';
import { dispatchNext, readyEntries, runnerWsUrl } from '../sessions/dispatch';
import { repoPathOf } from '../sessions/lifecycle';
import { loadQueue } from '../sessions/queue';
import { loadTaskSession } from '../sessions/view';
import { refreshLocalHost, workerConnection } from '../modules/hosts/service';
import { HostDisconnectedError } from '../errors';

const BUILD_LOG_CAP = 256 * 1024;
/** The automatic Cleanup's interval. */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
/** How long a slot above the cap stays without a Job before an automatic Cleanup removes it. */
export const SLOT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const BUILD_LOG_FLUSH_MS = 500;

/** Docker's final USER for a Worker image must be the non-root `agent`. */
export function isAgentUser(user: string): boolean {
  return ['agent', 'agent:agent', '1000', '1000:1000'].includes(user.trim());
}

export class Scheduler {
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly dispatching = new Map<string, Promise<void>>();
  private readonly dispatchAgain = new Set<string>();
  private readonly building = new Set<string>();
  private readonly buildAgain = new Set<string>();
  private readonly reconciling = new Map<string, Promise<void>>();
  private readonly syncing = new Set<string>();
  /** Worker Containers running an Agent Profile synchronization, which the reconciler keeps up. */
  private readonly syncingIn = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** The id of the running Cleanup, if any. */
  private cleaning: Promise<string> | null = null;
  private readonly hostCleanups = new Map<string, Promise<void>>();
  private stopping = false;

  // Coalesced real-time publishing, flushed in order.
  private pendingQueues = new Set<string>();
  private pendingTasks = new Set<string>();
  private pendingComments = new Map<string, 'created' | 'updated'>();
  private pendingJobs = new Set<string>();
  private pendingAgents = new Set<string>();
  private pendingWorkers = new Set<string>();
  private flushScheduled = false;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: AppContext) {}

  /** Periodic reconcile, recovery of abandoned Jobs and dispatch, plus one pass right away. */
  start(): void {
    this.stopping = false;
    const tick = () => this.track(this.tick());
    this.timer = setInterval(tick, this.ctx.config.agents.reconcileIntervalMs);
    this.timer.unref();
    tick();
    if (this.ctx.config.agents.cleanup) {
      const cleanup = () => void this.cleanup('automatic').catch((err) => this.ctx.log.error(err, 'could not start a cleanup'));
      this.cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();
      cleanup();
    }
  }

  stop(): void {
    this.stopping = true;
    this.dispatchAgain.clear();
    this.buildAgain.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  /** Resolves once no background work is left (used by tests). */
  async settle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (this.inflight.size === 0 && this.reconciling.size === 0 && !this.flushScheduled) {
        await this.flushChain;
        if (this.inflight.size === 0 && this.reconciling.size === 0 && !this.flushScheduled) return;
      }
      await Promise.allSettled([...this.inflight, ...this.reconciling.values(), this.flushChain]);
      await new Promise((r) => setImmediate(r));
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.then(
      () => this.inflight.delete(p),
      (err) => {
        this.inflight.delete(p);
        this.ctx.log.error(err, 'scheduler task failed');
      },
    );
    return p;
  }

  private async tick(): Promise<void> {
    await refreshLocalHost(this.ctx);
    await this.reconcileAll();
    await this.runSchedules();
    await recoverAbandonedJobs(this.ctx);
    this.kickWaiting();
  }

  /** Starts or skips the Schedules due at `now` (the scheduler's clock, a parameter so tests can move time). */
  async runSchedules(now = new Date()): Promise<void> {
    if (this.stopping) return;
    await runDueSchedules(this.ctx, now);
    await runDueMessages(this.ctx, now);
    this.kickWaiting();
  }

  private kickWaiting(): void {
    void this.ctx.db
      .selectDistinct({ workerId: queueEntries.workerId })
      .from(queueEntries)
      .then((waiting) => waiting.forEach(({ workerId }) => this.kick(workerId)))
      .catch((err) => this.ctx.log.error(err, 'could not dispatch waiting work'));
  }

  // Dispatching

  /** Dispatches the Worker's Queue onto its free containers; work left over makes the reconciler scale up. */
  kick(workerId: string): void {
    if (this.stopping) return;
    if (this.dispatching.has(workerId)) {
      this.dispatchAgain.add(workerId);
      return;
    }
    const run = (async () => {
      do {
        this.dispatchAgain.delete(workerId);
        for (let i = 0; i < 100 && !this.stopping; i++) {
          const dispatched = await dispatchNext(this.ctx, workerId).catch((err) => {
            this.ctx.log.error({ err, workerId }, 'dispatch failed');
            return false;
          });
          if (!dispatched) break;
        }
        if (await this.needsCapacity(workerId)) await this.reconcile(workerId);
      } while (!this.stopping && this.dispatchAgain.has(workerId));
    })().finally(() => this.dispatching.delete(workerId));
    this.dispatching.set(workerId, run);
    this.track(run);
  }

  /**
   * The Agents' Extensions or enabled flag changed: every Worker that holds their Profile, or has
   * work waiting for them, synchronizes and dispatches again.
   */
  refreshAgents(agentIds: string[]): void {
    if (this.stopping || agentIds.length === 0) return;
    this.track(
      (async () => {
        const ids = sql.join([...new Set(agentIds)].map((id) => sql`${id}::uuid`), sql`, `);
        const rows = await this.ctx.db.execute<{ worker_id: string }>(sql`
          select worker_id from agent_profiles where agent_id in (${ids})
          union select q.worker_id from queue_entries q join tasks t on t.id = q.task_id where t.agent_id in (${ids})`);
        for (const { worker_id } of rows.rows) {
          await this.reconcile(worker_id);
          this.kick(worker_id);
        }
      })(),
    );
  }

  /** Ready entries still waiting while no container of the Worker is free: a slot may have to start. */
  private async needsCapacity(workerId: string): Promise<boolean> {
    return (await readyEntries(this.ctx.db, workerId)).length > 0;
  }

  /** After a Job: its container is idle from now, a pending recreation goes first, then the next Queue Entry. */
  jobEnded(job: Pick<JobRow, 'workerId' | 'containerId' | 'agentId'>): void {
    const { workerId, containerId, agentId } = job;
    if (!workerId) return;
    this.track(
      (async () => {
        if (containerId) await this.ctx.db.update(workerContainers).set({ idleSince: new Date() }).where(eq(workerContainers.id, containerId));
        await this.reconcile(workerId);
        if (agentId) this.pendingAgents.add(agentId);
        this.kick(workerId);
      })(),
    );
  }

  /** Sends to a connected Runner of the Worker, preferring the given slot. Returns whether one took it. */
  sendToWorker(workerId: string, msg: BackendToRunner, preferSlot: number | null = null): boolean {
    for (const containerId of this.ctx.runners.forWorker(workerId, preferSlot)) if (this.ctx.runners.send(containerId, msg)) return true;
    return false;
  }

  removeWorktree(sessionId: string): void {
    this.track(
      (async () => {
        const [session] = await this.ctx.db.select().from(sessions).where(eq(sessions.id, sessionId));
        if (!session?.worktreeRemovalPending) return;
        const workerId = await workerOfTask(this.ctx.db, session.taskId);
        const msg = { type: 'worktree.remove' as const, worktreePath: session.worktreePath, repoPath: repoPathOf(session.worktreePath) };
        // A Job still being cancelled works in that Worktree: only its own Runner removes it, after the
        // Job exits. Any Runner of the Worker can remove an idle one, since the volume is shared.
        const [busy] = await this.ctx.db
          .select({ containerId: jobs.containerId })
          .from(jobs)
          .where(and(eq(jobs.sessionId, sessionId), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
        const sent = busy ? !!busy.containerId && this.ctx.runners.send(busy.containerId, msg) : this.sendToWorker(workerId, msg, session.lastSlot);
        if (sent) await this.ctx.db.update(sessions).set({ worktreeRemovalPending: false }).where(eq(sessions.id, sessionId));
      })(),
    );
  }

  // Cleanup (docs/specs/workers.md, "Cleanup")

  /** Starts a Cleanup in the background and returns its id, or the id of the one already running. */
  cleanup(trigger: CleanupTrigger, userId: string | null = null): Promise<string> {
    if (this.cleaning) return this.cleaning;
    const id = createCleanup(this.ctx.db, trigger, userId);
    this.cleaning = id;
    this.track(
      id
        .then(async (cleanupId) => {
          await publishCleanup(this.ctx, cleanupId);
          await this.runCleanup(cleanupId, trigger);
        })
        .finally(() => {
          this.cleaning = null;
        }),
    );
    return id;
  }

  private async runCleanup(id: string, trigger: CleanupTrigger): Promise<void> {
    const { db } = this.ctx;
    for (const host of await db.select().from(hosts)) {
      if (host.kind === 'local' && this.ctx.config.localHost === false && !(await db.select().from(workers).where(eq(workers.hostId, host.id))).length) continue;
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(hosts).where(eq(hosts.id, host.id)).for('update');
        if (!current || current.cleanupPending === id) return;
        if (current.cleanupPending) await addToCleanup(tx, current.cleanupPending, { hostsPending: -1 });
        await tx.update(hosts).set({ cleanupPending: id }).where(eq(hosts.id, host.id));
        await addToCleanup(tx, id, { hostsPending: 1 });
      });
      if (this.ctx.runtimes.has(host.id)) await this.hostReconnected(host.id);
    }

    const errors: string[] = [];
    let slots = 0;
    const all = await db.select({ id: workers.id, name: workers.name, hostId: workers.hostId }).from(workers);
    for (const worker of all) {
      if (!this.ctx.runtimes.has(worker.hostId)) continue;
      slots += await this.onWorker(worker.id, () => this.removeSlotsAboveCap(worker.id, trigger === 'manual' ? 0 : SLOT_RETENTION_MS, errors)).catch((err: unknown) => {
        errors.push(`${worker.name}: ${errorText(err)}`);
        return 0;
      });
    }
    // Counted before the requests go out, so an early answer finds its Worker Volume pending.
    await addToCleanup(db, id, { volumesPending: all.length });
    for (const worker of all) await this.requestVolumeCleanup(worker.id, id);
    for (const error of errors) this.ctx.log.warn({ cleanupId: id }, `cleanup: ${error}`);
    await addToCleanup(db, id, { removed: { slots }, errors, finished: true });
    await publishCleanup(this.ctx, id);
  }

  /** Completes the Docker part that waited for this Host, serialized across reconnects. */
  hostReconnected(hostId: string): Promise<void> {
    const previous = this.hostCleanups.get(hostId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const { db } = this.ctx;
      const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId));
      if (!host?.cleanupPending || !this.ctx.runtimes.has(hostId)) return;
      const id = host.cleanupPending;
      const known = async () => (await db.select().from(workers).where(eq(workers.hostId, hostId))).map((w) => ({ id: w.id, imageTag: w.imageTag, claudeCodeVersion: w.claudeCodeVersion, building: this.building.has(w.id) }));
      const current = await known();
      const report = await this.ctx.runtimes.get(hostId).cleanup({ anyBuilding: current.some((w) => w.building), workers: known })
        .catch((err: unknown) => ({ removed: {}, reclaimedBytes: 0, errors: [`Docker: ${errorText(err)}`] }));
      await db.transaction(async (tx) => {
        const [latest] = await tx.select().from(hosts).where(eq(hosts.id, hostId)).for('update');
        const done = latest?.cleanupPending === id && this.ctx.runtimes.has(hostId);
        if (done) await tx.update(hosts).set({ cleanupPending: null }).where(eq(hosts.id, hostId));
        await addToCleanup(tx, id, { ...report, hostsPending: done ? -1 : 0 });
      });
      await publishCleanup(this.ctx, id);
    });
    this.hostCleanups.set(hostId, run);
    void run.finally(() => { if (this.hostCleanups.get(hostId) === run) this.hostCleanups.delete(hostId); }).catch(() => {});
    return this.track(run);
  }

  /** Runs `fn` after the Worker's earlier reconciles and Cleanup steps: they never overlap. */
  private onWorker<T>(workerId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.reconciling.get(workerId) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => {},
      () => {},
    );
    this.reconciling.set(workerId, settled);
    void settled.finally(() => {
      if (this.reconciling.get(workerId) === settled) this.reconciling.delete(workerId);
    });
    return run;
  }

  /** Slots above the cap, stopped and idle for at least `minIdleMs`: container, Service Volume and record go. */
  private async removeSlotsAboveCap(workerId: string, minIdleMs: number, errors: string[]): Promise<number> {
    const { db } = this.ctx;
    const runtime = await this.ctx.runtimes.forWorker(workerId);
    const [worker] = await db.select().from(workers).where(eq(workers.id, workerId));
    if (!worker) return 0;
    let removed = 0;
    const now = Date.now();
    for (const row of await containerRows(db, workerId)) {
      if (row.slot <= worker.cap || this.syncingIn.has(row.id)) continue;
      if (now - (row.idleSince ?? row.createdAt).getTime() < minIdleMs) continue;
      if (isUp((await runtime.inspect(workerId, row.slot)).state)) continue;
      const [busy] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.containerId, row.id), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
      if (busy) continue;
      try {
        await runtime.removeSlot(workerId, row.slot);
      } catch (err) {
        errors.push(`${worker.name}, slot ${row.slot}: ${errorText(err)}`);
        continue;
      }
      await db.delete(workerContainers).where(eq(workerContainers.id, row.id));
      removed++;
    }
    if (removed) this.publishWorker(workerId);
    return removed;
  }

  /**
   * Hands the Worker Volume part of a Cleanup to the Worker: it stays pending until a Runner of the
   * Worker answers, and goes out now when one is connected. A pending request it replaces will not
   * be answered any more, so that Cleanup stops waiting for it.
   */
  private async requestVolumeCleanup(workerId: string, cleanupId: string): Promise<void> {
    const { db } = this.ctx;
    const replaced = await db.transaction(async (tx) => {
      const [row] = await tx.select({ pending: workers.volumeCleanupPending }).from(workers).where(eq(workers.id, workerId)).for('update');
      if (!row) return { gone: true, previous: null };
      await tx.update(workers).set({ volumeCleanupPending: cleanupId }).where(eq(workers.id, workerId));
      return { gone: false, previous: row.pending };
    });
    // The Worker was deleted meanwhile: nobody will answer.
    if (replaced.gone) await addToCleanup(db, cleanupId, { volumesPending: -1 });
    if (replaced.previous && replaced.previous !== cleanupId && (await addToCleanup(db, replaced.previous, { volumesPending: -1 }))) {
      await publishCleanup(this.ctx, replaced.previous);
    }
    if (!replaced.gone) await this.sendPendingVolumeCleanup(workerId);
  }

  /** Sends the Worker's pending Worker Volume cleanup, if any, to the given Runner or to any connected one. */
  async sendPendingVolumeCleanup(workerId: string, containerId?: string): Promise<void> {
    const [row] = await this.ctx.db.select({ pending: workers.volumeCleanupPending }).from(workers).where(eq(workers.id, workerId));
    if (!row?.pending) return;
    const msg = await volumeCleanupRequest(this.ctx.db, workerId, row.pending);
    if (containerId) this.ctx.runners.send(containerId, msg);
    else this.sendToWorker(workerId, msg);
  }

  // Image builds

  /** Builds the Worker's image from its current Dockerfile; a build already running is followed by another. */
  build(workerId: string): void {
    if (this.stopping) return;
    if (this.building.has(workerId)) {
      this.buildAgain.add(workerId);
      return;
    }
    this.building.add(workerId);
    this.track(
      this.runBuild(workerId).finally(() => {
        this.building.delete(workerId);
        if (this.buildAgain.delete(workerId)) this.build(workerId);
      }),
    );
  }

  private async runBuild(workerId: string): Promise<void> {
    const { db, hub } = this.ctx;
    const [worker] = await db.select().from(workers).where(eq(workers.id, workerId));
    if (!worker) return;
    if (!this.ctx.runtimes.has(worker.hostId)) {
      await db.update(workers).set({ imageState: 'none' }).where(eq(workers.id, workerId));
      return;
    }
    const runtime = this.ctx.runtimes.get(worker.hostId);
    const baseVersion = runtime.baseVersionFor(worker.claudeCodeVersion);
    const build = await db.transaction(async (tx) => {
      const [row] = await tx.insert(workerBuilds).values({ workerId, dockerfile: worker.dockerfile, baseVersion }).returning();
      await tx.update(workers).set({ imageState: 'building' }).where(eq(workers.id, workerId));
      return row!;
    });
    const { log: _log, ...summary } = serializeBuild(build);
    hub.publish(workerTopic(workerId), { type: 'build.updated', build: summary });
    await this.publishWorkerNow(workerId);

    let log = '';
    // The capped log can keep the same length while its content changes; count writes instead.
    let version = 0;
    let flushedVersion = -1;
    let timer: NodeJS.Timeout | null = null;
    let flushing: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> => {
      timer = null;
      if (flushedVersion === version) return flushing;
      const snapshot = log;
      flushedVersion = version;
      flushing = flushing.then(() => db.update(workerBuilds).set({ log: snapshot }).where(eq(workerBuilds.id, build.id))).then(() => {});
      return flushing;
    };
    const onLog = (chunk: string) => {
      log = (log + chunk).slice(-BUILD_LOG_CAP);
      version++;
      hub.publish(workerTopic(workerId), { type: 'build.log', workerId, buildId: build.id, chunk });
      timer ??= setTimeout(() => void flush().catch(() => {}), BUILD_LOG_FLUSH_MS);
    };

    let imageTag: string | null = null;
    let error: string | null = null;
    let interrupted = false;
    try {
      const result = await this.ctx.runtimes.run(worker.hostId, async () => {
      await runtime.ensureBaseImage(worker.claudeCodeVersion, (chunk) => onLog(chunk));
      return runtime.buildWorkerImage(
        { workerId, buildId: build.id, dockerfile: pinAgentBase(worker.dockerfile, baseVersion, worker.services) },
        onLog,
      );
      });
      if (!isAgentUser(result.user)) {
        throw new Error(`The image must end with \`USER agent\`, but its user is ${result.user ? `\`${result.user}\`` : 'root'}.`);
      }
      imageTag = result.imageTag;
    } catch (err) {
      interrupted = !this.ctx.runtimes.has(worker.hostId) || err instanceof HostDisconnectedError;
      error = interrupted ? 'The Host disconnected during this build' : (err instanceof Error ? err.message : String(err));
      if (interrupted) this.buildAgain.add(workerId);
      onLog(`\nBuild failed: ${error}\n`);
    }
    const [currentWorker] = await db.select().from(workers).where(eq(workers.id, workerId));
    if (currentWorker && currentWorker.hostId !== worker.hostId) {
      imageTag = null;
      onLog('\nThe Worker moved to another Host during this build.\n');
      await runtime.removeWorker(workerId).catch(() => {});
      this.buildAgain.add(workerId);
    }
    if (timer) clearTimeout(timer);
    await flushing.catch(() => {});

    const finished = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(workerBuilds)
        .set({ status: imageTag ? 'succeeded' : 'failed', imageTag, log, finishedAt: new Date() })
        .where(eq(workerBuilds.id, build.id))
        .returning();
      // A failed build keeps the previous image (and containers) in service.
      await tx
        .update(workers)
        .set(imageTag ? { imageState: 'built', imageTag, imageBaseVersion: baseVersion } : { imageState: interrupted ? 'none' : 'failed' })
        .where(and(eq(workers.id, workerId), eq(workers.hostId, worker.hostId)));
      return row;
    });
    if (!finished) {
      // The Worker was deleted during the build: clean up the image created meanwhile.
      if (imageTag) await runtime.removeWorker(workerId).catch(() => {});
      return;
    }
    const { log: _l, ...done } = serializeBuild(finished);
    hub.publish(workerTopic(workerId), { type: 'build.updated', build: done });
    await this.publishWorkerNow(workerId);
    if (imageTag) await this.reconcile(workerId);
    // Base Images of versions no Worker uses any more, unless another Build may still need its parent.
    if (imageTag && this.ctx.config.agents.cleanup && (await db.select().from(workers).where(eq(workers.hostId, worker.hostId))).every((w) => w.id === workerId || !this.building.has(w.id))) {
      const versions = await this.claudeCodeVersions(worker.hostId);
      await runtime.removeOldBaseImages(versions).catch((err) => this.ctx.log.warn({ err }, 'could not remove old base images'));
    }
  }

  // Containers

  /** Every Claude Code version a Worker uses: their Base Images are kept. */
  private async claudeCodeVersions(hostId: string): Promise<string[]> {
    const rows = await this.ctx.db.selectDistinct({ version: workers.claudeCodeVersion }).from(workers).where(eq(workers.hostId, hostId));
    return rows.map((r) => r.version);
  }

  reconcileAll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(
      (async () => {
        const rows = await this.ctx.db.select({ id: workers.id }).from(workers);
        for (const { id } of rows) await this.reconcile(id);
      })(),
    );
  }

  /** Brings one Worker's image and containers in line with its configuration and its work. Serialized per Worker. */
  reconcile(workerId: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(this.onWorker(workerId, () => this.reconcileOnce(workerId)).catch((err) => this.ctx.log.error({ err, workerId }, 'reconcile failed')));
  }

  private async reconcileOnce(workerId: string): Promise<void> {
    if (this.stopping) return;
    const { db } = this.ctx;
    const [worker] = await db.select().from(workers).where(eq(workers.id, workerId));
    if (!worker || !this.ctx.runtimes.has(worker.hostId)) return;
    const runtime = this.ctx.runtimes.get(worker.hostId);
    const stale = worker.imageState === 'built' && worker.imageBaseVersion !== runtime.baseVersionFor(worker.claudeCodeVersion);
    if ((worker.imageState === 'none' || stale) && !this.building.has(workerId)) this.build(workerId);

    const desired = desiredContainerSpec(worker, await workerConnection(this.ctx, db, worker.hostId));
    let changed = false;
    let started = false;
    const rows = await containerRows(db, workerId);
    const active = await this.activeJobsByContainer(workerId);
    const observed = new Map<number, string>();
    for (const row of rows) observed.set(row.slot, (await runtime.inspect(workerId, row.slot)).state);

    if (desired) {
      const wanted = await this.wantedSlots(worker, rows, observed, active);
      // Start what's wanted and not up; recreate what runs an older image or limits once it's free.
      for (const slot of wanted) {
        const row = rows.find((r) => r.slot === slot) ?? (await ensureContainerRow(db, workerId, slot));
        const state = observed.get(slot) ?? 'missing';
        const busy = active.has(row.id);
        if (this.runnerGone(worker, row, state, busy)) {
          // Docker kept the container running but its Runner never reconnected. Nothing can use
          // this free container, and the Queue would wait for it forever: recreate it.
          this.ctx.log.warn({ workerId, slot }, 'recreating a Worker Container whose Runner stayed away');
          await this.recreate(worker, row, desired);
          started = true;
          changed = true;
        } else if (state === 'missing' || row.containerSpec !== desired || row.forceRecreate) {
          if (state === 'missing' || !busy || row.forceRecreate) {
            await this.recreate(worker, row, desired);
            started = true;
            changed = true;
          }
        } else if (!isUp(state)) {
          await runtime.restartContainer(workerId, slot);
          await db.update(workerContainers).set({ idleSince: new Date(), runnerDisconnectedAt: new Date() }).where(eq(workerContainers.id, row.id));
          started = true;
          changed = true;
        }
      }
      // Stop what runs and isn't wanted, once it has no Job.
      for (const row of rows) {
        if (wanted.has(row.slot) || !isUp(observed.get(row.slot) ?? 'missing') || active.has(row.id) || this.syncingIn.has(row.id)) continue;
        if (await this.sleep(worker, row)) changed = true;
      }
    }
    let removedOutdated = false;
    for (const row of await containerRows(db, workerId)) {
      const info = await runtime.inspect(workerId, row.slot);
      let state = info.state;
      // A stopped container on an older image only pins that image: its next start recreates it anyway.
      if (this.ctx.config.agents.cleanup && worker.imageTag && info.image && info.image !== worker.imageTag && !isUp(state) && state !== 'missing' && !active.has(row.id)) {
        await runtime.removeContainer(workerId, row.slot);
        state = 'missing';
        removedOutdated = true;
      }
      if (state !== row.containerState) {
        await db.update(workerContainers).set({ containerState: state }).where(eq(workerContainers.id, row.id));
        changed = true;
      }
    }
    if (removedOutdated) await runtime.removeUnusedImages(workerId, worker.imageTag!).catch((err) => this.ctx.log.warn({ err, workerId }, 'could not remove old worker images'));
    if (changed) this.publishWorker(workerId);
    if (started) this.kick(workerId);

    // Agent Profiles the waiting work needs, and the Profiles this Worker holds whose Extensions changed.
    const agentIds = new Set((await readyEntries(db, workerId)).map((e) => e.agentId));
    const outdated = await db
      .select({ agentId: agentProfiles.agentId })
      .from(agentProfiles)
      .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
      .where(and(eq(agentProfiles.workerId, workerId), sql`${agentProfiles.appliedRevision} <> ${agents.extensionsRevision}`));
    for (const { agentId } of outdated) agentIds.add(agentId);
    for (const agentId of agentIds) this.syncProfile(workerId, agentId);
  }

  private async activeJobsByContainer(workerId: string): Promise<Map<string, string>> {
    const rows = await this.ctx.db
      .select({ id: jobs.id, containerId: jobs.containerId })
      .from(jobs)
      .where(and(eq(jobs.workerId, workerId), inArray(jobs.state, [...ACTIVE_JOB_STATES]), isNotNull(jobs.containerId)));
    return new Map(rows.map((r) => [r.containerId!, r.id]));
  }

  /**
   * The slots that should run: slots 1 to the minimum, every busy one, every one that runs and
   * hasn't been idle for the timeout, and as many more as the waiting work needs, up to the cap.
   * The Task's last slot is preferred for a new start; otherwise the lowest free one.
   */
  private async wantedSlots(worker: WorkerRow, rows: WorkerContainerRow[], observed: Map<number, string>, active: Map<string, string>): Promise<Set<number>> {
    const { stopWhenUnused, idleStopMs } = this.ctx.config.agents;
    const wanted = new Set<number>();
    const now = Date.now();
    for (const row of rows) {
      const up = isUp(observed.get(row.slot) ?? 'missing');
      if (active.has(row.id)) wanted.add(row.slot);
      else if (up && row.slot <= worker.cap) {
        const idleFor = now - (row.idleSince ?? row.createdAt).getTime();
        // Disabling a Worker stops its containers after the idle timeout even when the idle stop
        // is off: `WORKER_STOP_WHEN_UNUSED=false` only governs an enabled Worker.
        const idleLimitApplies = !worker.enabled || stopWhenUnused;
        if (!idleLimitApplies || idleFor < idleStopMs) wanted.add(row.slot);
      }
    }
    if (!worker.enabled) return wanted;
    for (let slot = 1; slot <= Math.min(worker.minimum, worker.cap); slot++) wanted.add(slot);
    const entries = await readyEntries(this.ctx.db, worker.id);
    const busy = (slot: number) => {
      const row = rows.find((r) => r.slot === slot);
      return !!row && active.has(row.id);
    };
    const available = [...wanted].filter((slot) => slot <= worker.cap && !busy(slot)).length;
    let need = entries.length - available;
    const candidates = [
      ...entries.map((e) => e.lastSlot).filter((s): s is number => s !== null),
      ...Array.from({ length: worker.cap }, (_, i) => i + 1),
    ];
    for (const slot of candidates) {
      if (need <= 0) break;
      if (slot > worker.cap || wanted.has(slot)) continue;
      wanted.add(slot);
      need--;
    }
    return wanted;
  }

  /**
   * Whether a wanted container is up and free but has had no Runner for longer than the reconnect
   * timeout. Its Runner is not coming back on its own (or never connected), so it can take no Job.
   */
  private runnerGone(worker: WorkerRow, row: WorkerContainerRow, state: string, busy: boolean): boolean {
    if (!worker.enabled || busy || !isUp(state) || this.syncingIn.has(row.id) || this.ctx.runners.isReady(row.id)) return false;
    const since = row.runnerDisconnectedAt?.getTime();
    return since !== undefined && Date.now() - since >= this.ctx.config.agents.runnerReconnectTimeoutMs;
  }

  /** Stops a Worker Container that is no longer wanted, keeping it (and its volumes) for the next start. */
  private async sleep(worker: WorkerRow, row: WorkerContainerRow): Promise<boolean> {
    // Dispatch only starts Jobs on a `running` container and locks the Worker's row, so marking it
    // stopped first closes the window between the check and Docker's stop.
    const stopping = await this.ctx.db.transaction(async (tx) => {
      await getWorkerRow(tx, worker.id, { lock: true });
      const [busy] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.containerId, row.id), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
      if (busy) return false;
      await tx.update(workerContainers).set({ containerState: 'exited' }).where(eq(workerContainers.id, row.id));
      return true;
    });
    if (!stopping) return false;
    this.ctx.runners.disconnect(row.id, 4003, 'container stopped: no work');
    try {
      await (await this.ctx.runtimes.forWorker(worker.id)).stopContainer(worker.id, row.slot);
    } catch (err) {
      // Keep the stored state true to Docker's, so the next reconcile decides again.
      await this.ctx.db.update(workerContainers).set({ containerState: (await (await this.ctx.runtimes.forWorker(worker.id)).inspect(worker.id, row.slot)).state }).where(eq(workerContainers.id, row.id));
      throw err;
    }
    return true;
  }

  private async recreate(worker: WorkerRow, row: WorkerContainerRow, desired: string): Promise<void> {
    const runtime = this.ctx.runtimes.get(worker.hostId);
    const connection = await workerConnection(this.ctx, this.ctx.db, worker.hostId);
    const { token, hash } = newToken();
    // A new token for every container: the old one stops working with the old container.
    // `containerSpec` stays null until the container exists, so a crash or a failed create
    // makes the next reconcile retry instead of believing the old container is current.
    await this.ctx.db
      .update(workerContainers)
      .set({
        runnerTokenHash: hash,
        containerSpec: null,
        forceRecreate: false,
        idleSince: new Date(),
        // The new container has no Runner yet; the timeout starts here, not at the old disconnect.
        runnerDisconnectedAt: new Date(),
      })
      .where(eq(workerContainers.id, row.id));
    this.ctx.runners.disconnect(row.id, 4002, 'container recreated');
    await runtime.createContainer(worker.id, row.slot, {
      image: worker.imageTag!,
      env: {
        CLAUDE_TASK_BACKEND_URL: runnerWsUrl(connection.backendUrl!),
        CLAUDE_TASK_RUNNER_TOKEN: token,
      },
      network: connection.network,
      cpuLimit: worker.cpuLimit,
      memoryMb: worker.memoryMb,
    });
    const [current] = await this.ctx.db.select({ id: workers.id, hostId: workers.hostId }).from(workers).where(eq(workers.id, worker.id));
    if (!current || current.hostId !== worker.hostId) {
      // The Worker was deleted while Docker was creating its container.
      await runtime.removeWorker(worker.id).catch(() => {});
      return;
    }
    const [liveContainer] = await this.ctx.db.select({ id: workerContainers.id }).from(workerContainers).where(eq(workerContainers.id, row.id));
    if (!liveContainer) { await runtime.removeContainer(worker.id, row.slot).catch(() => {}); return; }
    await this.ctx.db.update(workerContainers).set({ containerSpec: desired, containerState: 'running' }).where(eq(workerContainers.id, row.id));
  }

  // Agent Profiles

  /**
   * Brings the Agent's Profile on this Worker up to its Extensions revision, from one running
   * container, while the Agent has no Job on the Worker. Only that Agent's entries wait for it.
   */
  syncProfile(workerId: string, agentId: string): void {
    const key = `${workerId}:${agentId}`;
    if (this.stopping || this.syncing.has(key)) return;
    this.syncing.add(key);
    let retry = false;
    this.track(
      (async () => {
        const { db } = this.ctx;
        const [worker] = await db.select().from(workers).where(eq(workers.id, workerId));
        if (!worker || !this.ctx.runtimes.has(worker.hostId)) return;
        const runtime = this.ctx.runtimes.get(worker.hostId);
        const pending = await db.transaction(async (tx) => {
          const current = await getWorkerRow(tx, workerId, { lock: true });
          if (current.hostId !== worker.hostId) { retry = true; return null; }
          const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId));
          if (!agent) return null;
          const [profile] = await tx.select().from(agentProfiles).where(and(eq(agentProfiles.workerId, workerId), eq(agentProfiles.agentId, agentId)));
          if (profile?.appliedRevision === agent.extensionsRevision) return null;
          const [busy] = await tx
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(eq(jobs.workerId, workerId), eq(jobs.agentId, agentId), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
          if (busy) return null;
          return { revision: agent.extensionsRevision, extensions: await agentExtensions(tx, agentId) };
        });
        if (!pending) return;
        // No lock is held while Docker works: installs can take minutes.
        const [container] = await db
          .select()
          .from(workerContainers)
          .where(and(eq(workerContainers.workerId, workerId), eq(workerContainers.containerState, 'running')))
          .orderBy(asc(workerContainers.slot))
          .limit(1);
        if (!container) return;
        let error: string | null = null;
        this.syncingIn.add(container.id);
        try {
          await runtime.configureProfile(workerId, container.slot, {
            agentId,
            revision: pending.revision,
            skills: pending.extensions.skills.map(({ name, files }) => ({ name, files })),
            plugins: pending.extensions.plugins.map(({ name, source }) => ({ name, source })),
          });
        } catch (err) {
          error = (err instanceof Error ? err.message : 'Could not configure skills and plugins').slice(0, 2000);
        } finally {
          this.syncingIn.delete(container.id);
        }
        const values = error ? { error } : { appliedRevision: pending.revision, error: null };
        const recorded = await db.transaction(async (tx) => {
          const [current] = await tx.select().from(workers).where(eq(workers.id, workerId)).for('update');
          if (!current || current.hostId !== worker.hostId) return false;
          const [liveContainer] = await tx.select({ id: workerContainers.id }).from(workerContainers).where(eq(workerContainers.id, container.id));
          if (!liveContainer) return false;
          await tx.insert(agentProfiles)
            .values({ workerId, agentId, appliedRevision: error ? -1 : pending.revision, error, updatedAt: new Date() })
            .onConflictDoUpdate({ target: [agentProfiles.workerId, agentProfiles.agentId], set: { ...values, updatedAt: new Date() } });
          return true;
        }).catch((err) => { this.ctx.log.warn({ err, workerId, agentId }, 'could not record an Agent Profile synchronization'); return false; });
        if (!recorded) { retry = true; return; }
        this.publishWorker(workerId);
        this.publishAgent(agentId);
        if (!error) this.kick(workerId);
      })().finally(() => { this.syncing.delete(key); if (retry) this.kick(workerId); }),
    );
  }

  // Real-time publishing

  publishAgent(agentId: string): void {
    this.pendingAgents.add(agentId);
    this.scheduleFlush();
  }

  publishWorker(workerId: string): void {
    this.pendingWorkers.add(workerId);
    this.scheduleFlush();
  }

  private publishWorkerNow(workerId: string): Promise<void> {
    return this.track(publishWorker(this.ctx, workerId));
  }

  publishQueue(workerId: string, taskIds: string[]): void {
    this.pendingQueues.add(workerId);
    for (const id of taskIds) this.pendingTasks.add(id);
    this.scheduleFlush();
  }

  /** The Task's Session (view and card). */
  publishTask(taskId: string): void {
    this.pendingTasks.add(taskId);
    this.scheduleFlush();
  }

  publishComments(ids: string[], mode: 'created' | 'updated' = 'updated'): void {
    for (const id of ids) if (this.pendingComments.get(id) !== 'created') this.pendingComments.set(id, mode);
    this.scheduleFlush();
  }

  publishJob(jobId: string): void {
    this.pendingJobs.add(jobId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flushChain = this.track(this.flushChain.then(() => this.flush())).catch(() => {});
    });
  }

  private async flush(): Promise<void> {
    const { db, hub } = this.ctx;
    const queues = [...this.pendingQueues];
    const taskIds = new Set(this.pendingTasks);
    const commentModes = new Map(this.pendingComments);
    const jobIds = [...this.pendingJobs];
    this.pendingQueues.clear();
    this.pendingTasks.clear();
    this.pendingComments.clear();
    this.pendingJobs.clear();

    for (const job of await loadJobs(db, { jobIds })) {
      if (job.agentId) {
        hub.publish(agentTopic(job.agentId), { type: 'job.updated', job });
        this.pendingAgents.add(job.agentId);
      }
      if (job.workerId) {
        hub.publish(workerTopic(job.workerId), { type: 'job.updated', job });
        this.pendingWorkers.add(job.workerId);
      }
    }
    for (const workerId of queues) {
      const entries = await loadQueue(db, workerId);
      hub.publish(workerTopic(workerId), { type: 'queue.changed', workerId, entries });
      for (const e of entries) taskIds.add(e.task.id);
      this.pendingWorkers.add(workerId);
    }
    const comments = await loadCommentsById(db, [...commentModes.keys()]);
    // A new Comment's Timeline position: clients place it where the server stored it, even when
    // its timestamp ties with another entry's once cut to milliseconds.
    const createdByTask = new Map<string, string[]>();
    for (const [id, comment] of comments) {
      if (commentModes.get(id) !== 'created') continue;
      createdByTask.set(comment.taskId, [...(createdByTask.get(comment.taskId) ?? []), id]);
    }
    const positions = new Map<string, string>();
    for (const [taskId, ids] of createdByTask) {
      for (const [id, position] of await loadTimelinePositions(db, taskId, ids)) positions.set(id, position);
    }
    for (const [id, comment] of comments) {
      const created = commentModes.get(id) === 'created';
      hub.publish(taskTopic(comment.taskId), {
        type: created ? 'comment.created' : 'comment.updated',
        comment,
        ...(created ? { readPosition: positions.get(id) } : {}),
      });
      if (created) taskIds.add(comment.taskId);
    }
    for (const taskId of taskIds) {
      const card = await loadCard(db, taskId).catch(() => null);
      if (!card) continue;
      hub.publish(taskTopic(taskId), { type: 'session.changed', taskId, session: await loadTaskSession(db, taskId) });
      hub.publish(projectTopic(card.projectId), { type: 'task.updated', task: card });
    }
    if (taskIds.size > 0) {
      // A Chat's last activity and unread state live in the Wiki's Chat list; every
      // Comment, including Agent ones projected from the stream, changes it.
      const wikiProjects = await db.execute<{ id: string }>(sql`
        select distinct p.id from projects p join tasks t on t.project_id = p.id
        where p.kind = 'wiki' and t.id in (${sql.join([...taskIds].map((id) => sql`${id}::uuid`), sql`, `)})`);
      for (const { id } of wikiProjects.rows) hub.publish('wikis', { type: 'wiki.changed', wikiId: id });
    }
    const agentIds = [...this.pendingAgents];
    this.pendingAgents.clear();
    for (const agentId of agentIds) await publishAgent(this.ctx, agentId);
    const workerIds = [...this.pendingWorkers];
    this.pendingWorkers.clear();
    for (const workerId of workerIds) await publishWorker(this.ctx, workerId);
  }
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
