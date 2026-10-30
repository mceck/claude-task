// Background work around Agents: dispatching, image builds, the container reconciler, and
// publishing scheduling state to browsers. Everything it starts is tracked so tests can settle.
import { agentTopic, pinAgentBase, projectTopic, taskTopic } from '@claude-task/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { ContainerInfo } from './runtime';
import { agentBuilds, agents, jobs, queueEntries, sessions } from '../db/schema';
import { ACTIVE_JOB_STATES, agentNeedsContainer, desiredContainerSpec, getAgentRow, loadJobs, publishAgent, serializeBuild } from '../modules/agents/service';
import { loadCommentsById } from '../modules/comments/service';
import { agentExtensions } from '../modules/extensions/service';
import { loadCard } from '../modules/tasks/service';
import { recoverAbandonedJobs } from '../runner/handlers';
import { newToken } from '../secrets';
import { dispatchNext, runnerWsUrl } from '../sessions/dispatch';
import { loadQueue } from '../sessions/queue';
import { loadTaskSession } from '../sessions/view';

const isUp = (state: string) => ['running', 'restarting'].includes(state);

const BUILD_LOG_CAP = 256 * 1024;
const BUILD_LOG_FLUSH_MS = 500;

/** Docker's final USER for an Agent image must be the non-root `agent`. */
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
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  // Coalesced real-time publishing, flushed in order.
  private pendingQueues = new Set<string>();
  private pendingTasks = new Set<string>();
  private pendingComments = new Map<string, 'created' | 'updated'>();
  private pendingJobs = new Set<string>();
  private pendingAgents = new Set<string>();
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
  }

  stop(): void {
    this.stopping = true;
    this.dispatchAgain.clear();
    this.buildAgain.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    await this.reconcileAll();
    await recoverAbandonedJobs(this.ctx);
    const waiting = await this.ctx.db.selectDistinct({ agentId: queueEntries.agentId }).from(queueEntries);
    for (const { agentId } of waiting) this.kick(agentId);
  }

  // Dispatching

  kick(agentId: string): void {
    if (this.stopping) return;
    if (this.dispatching.has(agentId)) {
      this.dispatchAgain.add(agentId);
      return;
    }
    const run = (async () => {
      do {
        this.dispatchAgain.delete(agentId);
        const dispatched = await dispatchNext(this.ctx, agentId).catch((err) => {
          this.ctx.log.error({ err, agentId }, 'dispatch failed');
          return true;
        });
        if (!dispatched) await this.wake(agentId);
      } while (!this.stopping && this.dispatchAgain.has(agentId));
    })().finally(() => this.dispatching.delete(agentId));
    this.dispatching.set(agentId, run);
    this.track(run);
  }

  /** Work is waiting for an Agent whose container was stopped for lack of it: start it. */
  private async wake(agentId: string): Promise<void> {
    if (this.stopping || !this.ctx.config.agents.stopWhenUnused) return;
    const { state } = await this.ctx.runtime.inspect(agentId);
    if (isUp(state)) return;
    if (await agentNeedsContainer(this.ctx.db, agentId, this.ctx.config.agents.wikiIdleStopMs)) await this.reconcile(agentId);
  }

  /** A Session changed: the Agent may have gained work (wake it) or lost its last (stop it). */
  refresh(agentId: string): void {
    if (this.ctx.config.agents.stopWhenUnused) void this.reconcile(agentId);
  }

  /** After a Job: a pending container recreation goes first, then the next Queue Entry. */
  jobEnded(agentId: string): void {
    this.track(this.reconcile(agentId).finally(() => this.kick(agentId)));
  }

  removeWorktree(sessionId: string): void {
    this.track(
      (async () => {
        const [s] = await this.ctx.db.select().from(sessions).where(eq(sessions.id, sessionId));
        if (!s?.worktreeRemovalPending) return;
        if (!this.ctx.runners.send(s.agentId, { type: 'worktree.remove', worktreePath: s.worktreePath, repoPath: `repos/${s.worktreePath.split('/')[1]}.git` })) return;
        await this.ctx.db.update(sessions).set({ worktreeRemovalPending: false }).where(eq(sessions.id, sessionId));
      })(),
    );
  }

  // Image builds

  /** Builds the Agent's image from its current Dockerfile; a build already running is followed by another. */
  build(agentId: string): void {
    if (this.stopping) return;
    if (this.building.has(agentId)) {
      this.buildAgain.add(agentId);
      return;
    }
    this.building.add(agentId);
    this.track(
      this.runBuild(agentId).finally(() => {
        this.building.delete(agentId);
        if (this.buildAgain.delete(agentId)) this.build(agentId);
      }),
    );
  }

  private async runBuild(agentId: string): Promise<void> {
    const { db, runtime, hub } = this.ctx;
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return;
    const build = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentBuilds)
        .values({ agentId, dockerfile: agent.dockerfile, baseVersion: runtime.baseVersion })
        .returning();
      await tx.update(agents).set({ imageState: 'building' }).where(eq(agents.id, agentId));
      return row!;
    });
    const { log: _log, ...summary } = serializeBuild(build);
    hub.publish(agentTopic(agentId), { type: 'build.updated', build: summary });
    await this.publishAgent(agentId);

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
      flushing = flushing.then(() => db.update(agentBuilds).set({ log: snapshot }).where(eq(agentBuilds.id, build.id))).then(() => {});
      return flushing;
    };
    const onLog = (chunk: string) => {
      log = (log + chunk).slice(-BUILD_LOG_CAP);
      version++;
      hub.publish(agentTopic(agentId), { type: 'build.log', agentId, buildId: build.id, chunk });
      timer ??= setTimeout(() => void flush().catch(() => {}), BUILD_LOG_FLUSH_MS);
    };

    let imageTag: string | null = null;
    let error: string | null = null;
    try {
      await runtime.ensureBaseImage((chunk) => onLog(chunk));
      const result = await runtime.buildAgentImage(
        { agentId, buildId: build.id, dockerfile: pinAgentBase(agent.dockerfile, runtime.baseVersion, agent.services) },
        onLog,
      );
      if (!isAgentUser(result.user)) {
        throw new Error(`The image must end with \`USER agent\`, but its user is ${result.user ? `\`${result.user}\`` : 'root'}.`);
      }
      imageTag = result.imageTag;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      onLog(`\nBuild failed: ${error}\n`);
    }
    if (timer) clearTimeout(timer);
    await flushing.catch(() => {});

    const finished = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(agentBuilds)
        .set({ status: imageTag ? 'succeeded' : 'failed', imageTag, log, finishedAt: new Date() })
        .where(eq(agentBuilds.id, build.id))
        .returning();
      // A failed build keeps the previous image (and container) in service.
      await tx
        .update(agents)
        .set(imageTag ? { imageState: 'built', imageTag, imageBaseVersion: runtime.baseVersion } : { imageState: 'failed' })
        .where(eq(agents.id, agentId));
      return row;
    });
    if (!finished) {
      // The Agent was deleted during the build: clean up the image created meanwhile.
      if (imageTag) await runtime.removeAgent(agentId).catch(() => {});
      return;
    }
    const { log: _l, ...done } = serializeBuild(finished);
    hub.publish(agentTopic(agentId), { type: 'build.updated', build: done });
    await this.publishAgent(agentId);
    if (imageTag) await this.reconcile(agentId);
  }

  // Containers

  reconcileAll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(
      (async () => {
        const rows = await this.ctx.db.select({ id: agents.id }).from(agents);
        for (const { id } of rows) await this.reconcile(id);
      })(),
    );
  }

  /** Brings one Agent's image and container in line with its configuration. Serialized per Agent. */
  reconcile(agentId: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const previous = this.reconciling.get(agentId) ?? Promise.resolve();
    const next = previous.then(() => this.reconcileOnce(agentId)).catch((err) => this.ctx.log.error({ err, agentId }, 'reconcile failed'));
    this.reconciling.set(agentId, next);
    void next.finally(() => {
      if (this.reconciling.get(agentId) === next) this.reconciling.delete(agentId);
    });
    return this.track(next);
  }

  private async reconcileOnce(agentId: string): Promise<void> {
    if (this.stopping) return;
    const { db, runtime } = this.ctx;
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return;
    const stale = agent.imageState === 'built' && agent.imageBaseVersion !== runtime.baseVersion;
    if ((agent.imageState === 'none' || stale) && !this.building.has(agentId)) this.build(agentId);

    const desired = desiredContainerSpec(agent);
    let info = await runtime.inspect(agentId);
    const unused = this.ctx.config.agents.stopWhenUnused && !(await agentNeedsContainer(db, agentId, this.ctx.config.agents.wikiIdleStopMs));
    // A forced recreate is immediate: only the "when idle" variant waits for work.
    if (desired && unused && !agent.forceRecreate) {
      // Recreation and restarts wait for the next wake-up; a missing container is not created.
      if (isUp(info.state)) info = await this.sleep(agentId, info);
    } else if (desired) {
      if (info.state === 'missing' || agent.containerSpec !== desired) {
        const [busy] = await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.agentId, agentId), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
        // Recreating kills the running Job, so it waits for the Agent to be idle unless forced.
        if (info.state === 'missing' || !busy || agent.forceRecreate) {
          await this.recreate(agent, desired);
          info = await runtime.inspect(agentId);
        }
      } else if (!isUp(info.state)) {
        await runtime.restartContainer(agentId);
        info = await runtime.inspect(agentId);
      }
    }
    if (info.state !== agent.containerState) {
      await db.update(agents).set({ containerState: info.state }).where(eq(agents.id, agentId));
      await this.publishAgent(agentId);
      if (info.state === 'running') this.kick(agentId);
    }
    if (info.state === 'running') {
      // No lock is held while Docker works (installs can take minutes and the Agent's row lock
      // would stall every Comment on its Tasks). Dispatch stays off on its own: it needs the
      // configured revision to match, and reconciles of one Agent are serialized.
      const pending = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
        if (!current || current.extensionsRevision === current.configuredExtensionsRevision) return null;
        const [busy] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, agentId), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
        if (busy) return null;
        return { revision: current.extensionsRevision, extensions: await agentExtensions(tx, agentId) };
      });
      let configured = false;
      if (pending) {
        const { revision, extensions } = pending;
        try {
          await runtime.configureSkills(agentId, revision, extensions.skills.map(({ name, files }) => ({ name, files })));
          await runtime.configurePlugins(agentId, extensions.plugins.map(({ name, source }) => ({ name, source })));
          await db.update(agents).set({ configuredExtensionsRevision: revision, extensionsError: null }).where(eq(agents.id, agentId));
          configured = true;
        } catch (err) {
          await db.update(agents).set({ extensionsError: (err instanceof Error ? err.message : 'Could not configure skills and plugins').slice(0, 2000) }).where(eq(agents.id, agentId));
        }
      }
      await this.publishAgent(agentId);
      if (configured) this.kick(agentId);
    }
  }

  /** Stops the container of an Agent with no work, keeping it (and its volume) for the next wake-up. */
  private async sleep(agentId: string, info: ContainerInfo): Promise<ContainerInfo> {
    // Dispatch only starts Jobs on a `running` container and locks this row, so marking it stopped
    // first closes the window between the check and Docker's stop.
    const stopping = await this.ctx.db.transaction(async (tx) => {
      await getAgentRow(tx, agentId, { lock: true });
      if (await agentNeedsContainer(tx, agentId, this.ctx.config.agents.wikiIdleStopMs)) return false;
      await tx.update(agents).set({ containerState: 'exited' }).where(eq(agents.id, agentId));
      return true;
    });
    if (!stopping) return info;
    this.ctx.runners.disconnect(agentId, 4003, 'container stopped: no work');
    try {
      await this.ctx.runtime.stopContainer(agentId);
    } catch (err) {
      // Keep the stored state true to Docker's, so the next reconcile decides again.
      await this.ctx.db.update(agents).set({ containerState: (await this.ctx.runtime.inspect(agentId)).state }).where(eq(agents.id, agentId));
      throw err;
    }
    await this.publishAgent(agentId);
    // Work may have arrived while Docker was stopping: wake the container now, not at the next tick.
    if (await agentNeedsContainer(this.ctx.db, agentId, this.ctx.config.agents.wikiIdleStopMs)) this.kick(agentId);
    return this.ctx.runtime.inspect(agentId);
  }

  private async recreate(agent: typeof agents.$inferSelect, desired: string): Promise<void> {
    const { token, hash } = newToken();
    // A new token for every container: the old one stops working with the old container.
    // `containerSpec` stays null until the container exists, so a crash or a failed create
    // makes the next reconcile retry instead of believing the old container is current.
    await this.ctx.db
      .update(agents)
      .set({ runnerTokenHash: hash, containerSpec: null, forceRecreate: false, configuredExtensionsRevision: -1, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
    this.ctx.runners.disconnect(agent.id, 4002, 'container recreated');
    await this.ctx.runtime.createContainer(agent.id, {
      image: agent.imageTag!,
      env: {
        CLAUDE_TASK_BACKEND_URL: runnerWsUrl(this.ctx.config.agents.backendUrl),
        CLAUDE_TASK_RUNNER_TOKEN: token,
      },
      cpuLimit: agent.cpuLimit,
      memoryMb: agent.memoryMb,
    });
    const [current] = await this.ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id));
    if (!current) {
      // The Agent was deleted while Docker was creating its container.
      await this.ctx.runtime.removeAgent(agent.id).catch(() => {});
      return;
    }
    await this.ctx.db.update(agents).set({ containerSpec: desired }).where(eq(agents.id, agent.id));
    await this.publishAgent(agent.id);
  }

  // Real-time publishing

  publishAgent(agentId: string): Promise<void> {
    return this.track(publishAgent(this.ctx, agentId));
  }

  publishQueue(agentId: string, taskIds: string[]): void {
    this.pendingQueues.add(agentId);
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
      hub.publish(agentTopic(job.agentId), { type: 'job.updated', job });
      this.pendingAgents.add(job.agentId);
    }
    for (const agentId of queues) {
      const entries = await loadQueue(db, agentId);
      hub.publish(agentTopic(agentId), { type: 'queue.changed', agentId, entries });
      for (const e of entries) taskIds.add(e.task.id);
      this.pendingAgents.add(agentId);
    }
    const comments = await loadCommentsById(db, [...commentModes.keys()]);
    for (const [id, comment] of comments) {
      const created = commentModes.get(id) === 'created';
      hub.publish(taskTopic(comment.taskId), { type: created ? 'comment.created' : 'comment.updated', comment });
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
  }
}

