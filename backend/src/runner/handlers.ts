// The backend side of the Runner Protocol: every message is processed exactly once and in
// order (per-Job seq), inside a transaction that locks task → worker → session → job. Each
// connection is one Worker Container's Runner.
import type { JobFailureStage, RunnerJobMessage, RunnerToBackend } from '@claude-task/shared';
import { taskTopic } from '@claude-task/shared';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { AfterCommit, AppContext } from '../context';
import { transactWithRetry } from '../context';
import type { Executor } from '../db/client';
import { agents, btwThreads, comments, jobs, projects, sessionEvents, sessions, tasks, workerContainers, workers } from '../db/schema';
import { publishCleanup, settleVolumeCleanup } from '../modules/workers/cleanup';
import { ACTIVE_JOB_STATES } from '../modules/agents/service';
import { getWorkerRow, workerOfTask } from '../modules/workers/service';
import type { JobRow } from '../modules/agents/service';
import { settleRun } from '../modules/schedules/service';
import { jobEventId, setAlertComment } from '../notifications/alerts';
import { applyProjection } from '../projection/apply';
import { endJob, initialProjection, project } from '../projection/projector';
import type { ProjectionState } from '../projection/projector';
import { projectSkills } from '../sessions/project-skills';
import { captureWorktreeStatus } from '../sessions/worktree-status';
import { HURRY_MESSAGE } from '../sessions/messages';
import { attachComments, enqueue } from '../sessions/queue';
import { answerBtw, applyPendingClear, failBtw, failWorkingBtws } from '../sessions/btw-state';

/** Setup output and stderr are kept up to this size (the tail). */
const OUTPUT_CAP = 64 * 1024;
/** `last_activity_at` is refreshed at most this often while streaming. */
const ACTIVITY_TOUCH_MS = 10_000;

const appendCapped = (column: typeof jobs.setupOutput | typeof jobs.stderr, chunk: string) => sql`right(${column} || ${chunk}, ${OUTPUT_CAP})`;

/** The Worker Container a Runner connection belongs to. */
export interface RunnerIdentity {
  containerId: string;
  workerId: string;
  slot: number;
}

export async function handleRunnerMessage(ctx: AppContext, runner: RunnerIdentity, msg: RunnerToBackend): Promise<void> {
  if (msg.type === 'hello') return handleHello(ctx, runner, msg);
  if (msg.type === 'pong') return;
  if (msg.type === 'project_skills.result') {
    ctx.skillRequests.settle(runner.containerId, String(msg.requestId), Array.isArray(msg.files) ? msg.files : []);
    return;
  }
  if (msg.type === 'worktree.status.result') {
    const files = Array.isArray(msg.files) ? msg.files : [];
    ctx.worktreeStatus.settle(runner.containerId, String(msg.requestId), {
      files,
      total: typeof msg.total === 'number' ? msg.total : files.length,
      truncated: msg.truncated === true,
      error: msg.error ?? null,
    });
    return;
  }
  if (msg.type === 'volume.cleanup.result') return handleVolumeCleanupResult(ctx, runner, msg);
  if (typeof msg.jobId === 'string' && typeof msg.seq === 'number') return handleJobMessage(ctx, runner, msg);
  ctx.log.warn({ containerId: runner.containerId, type: (msg as { type?: string }).type }, 'unknown runner message');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** A Worker Volume's part of a Cleanup is done: it adds to the Cleanup that asked for it. */
async function handleVolumeCleanupResult(ctx: AppContext, runner: RunnerIdentity, msg: Extract<RunnerToBackend, { type: 'volume.cleanup.result' }>): Promise<void> {
  const requestId = String(msg.requestId);
  if (!UUID.test(requestId)) return;
  const [worker] = await ctx.db.select({ name: workers.name }).from(workers).where(eq(workers.id, runner.workerId));
  const error = typeof msg.error === 'string' && msg.error ? `${worker?.name ?? 'Worker'} volume: ${msg.error.slice(0, 500)}` : null;
  if (error) ctx.log.warn({ workerId: runner.workerId, cleanupId: requestId }, `cleanup: ${error}`);
  const counts = { projects: count(msg.projects), agentProfiles: count(msg.agentProfiles), reclaimedBytes: count(msg.reclaimedBytes), error };
  if (await settleVolumeCleanup(ctx.db, runner.workerId, requestId, counts)) await publishCleanup(ctx, requestId);
}

async function handleHello(ctx: AppContext, runner: RunnerIdentity, msg: Extract<RunnerToBackend, { type: 'hello' }>): Promise<void> {
  const { containerId, workerId } = runner;
  const { keep, pendingRemovals, keepSession } = await transactWithRetry(ctx, async (tx, after) => {
    await getWorkerRow(tx, workerId, { lock: true });
    const active = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.containerId, containerId), inArray(jobs.state, [...ACTIVE_JOB_STATES])))
      .for('update');
    let keep: JobRow | null = null;
    for (const job of active) {
      if (job.id === msg.activeJobId) keep = job;
      // The Runner restarted without it: the process is gone (container restart or crash).
      else await recoverJob(tx, after, job);
    }
    await tx
      .update(workerContainers)
      .set({
        runnerConnectedAt: new Date(),
        runnerDisconnectedAt: null,
        runnerVersion: String(msg.runnerVersion ?? ''),
        claudeVersion: String(msg.claudeVersion ?? ''),
        ...(keep ? {} : { idleSince: new Date() }),
      })
      .where(eq(workerContainers.id, containerId));
    // Worktree removals wait for a Runner of the Worker; the Worker Volume is shared.
    const pendingRemovals = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(tasks, eq(tasks.id, sessions.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(projects.workerId, workerId), eq(sessions.worktreeRemovalPending, true)));
    const keepSession = keep
      ? (await tx.select({ state: sessions.state }).from(sessions).where(eq(sessions.id, keep.sessionId)))[0] ?? null
      : null;
    return { keep, pendingRemovals, keepSession };
  });

  // The `hello` is the handshake: dispatch and mid-Turn writes wait for it.
  ctx.runners.markReady(containerId);
  ctx.scheduler.publishWorker(workerId);
  if (msg.activeJobId && keep) {
    ctx.runners.send(containerId, { type: 'ack', jobId: keep.id, seq: keep.lastSeq });
    // After-commit messages are fire-and-forget: replay the control intent that the
    // disconnected socket could have missed.
    if (keep.discardOutput || keep.cancelRequested) {
      ctx.runners.send(containerId, { type: 'job.cancel', jobId: keep.id });
    } else {
      const paused = keepSession?.state === 'paused';
      if (paused) ctx.runners.send(containerId, { type: 'job.interrupt', jobId: keep.id });
      if (paused || keep.state === 'finishing') ctx.runners.send(containerId, { type: 'job.end', jobId: keep.id });
    }
  } else if (msg.activeJobId) {
    // A Job we've already settled: drop its backlog and stop whatever is left of it.
    ctx.runners.send(containerId, { type: 'ack', jobId: msg.activeJobId, seq: Number.MAX_SAFE_INTEGER });
    ctx.runners.send(containerId, { type: 'job.cancel', jobId: msg.activeJobId });
  }
  for (const s of pendingRemovals) ctx.scheduler.removeWorktree(s.id);
  await ctx.scheduler.sendPendingVolumeCleanup(workerId, containerId);
  await ctx.scheduler.reconcile(workerId);
  ctx.scheduler.kick(workerId);
}

export async function handleRunnerClosed(ctx: AppContext, runner: RunnerIdentity): Promise<void> {
  // The Runner may already be back on a new connection, whose hello must not be overwritten.
  if (ctx.runners.isConnected(runner.containerId)) return;
  await ctx.db.update(workerContainers).set({ runnerDisconnectedAt: new Date() }).where(eq(workerContainers.id, runner.containerId));
  ctx.scheduler.publishWorker(runner.workerId);
}

async function handleJobMessage(ctx: AppContext, runner: RunnerIdentity, msg: RunnerJobMessage): Promise<void> {
  const { containerId, workerId } = runner;
  const [peek] = await ctx.db.select({ taskId: jobs.taskId, containerId: jobs.containerId }).from(jobs).where(eq(jobs.id, msg.jobId));
  if (!peek || peek.containerId !== containerId) {
    ctx.runners.send(containerId, { type: 'ack', jobId: msg.jobId, seq: msg.seq });
    return;
  }
  const settled = await transactWithRetry(ctx, async (tx, after) => {
    await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, peek.taskId)).for('key share');
    await getWorkerRow(tx, workerId, { lock: true });
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, msg.jobId)).for('update');
    if (!job) return true;
    const [session] = await tx.select().from(sessions).where(eq(sessions.id, job.sessionId)).for('update');
    if (msg.seq <= job.lastSeq || !(ACTIVE_JOB_STATES as readonly string[]).includes(job.state)) return true;
    if (job.discardOutput) {
      // A reset must retain the busy Job until the Runner confirms exit. No old
      // output, projection, retries or system notices may repopulate the chat.
      if (msg.type === 'job.exited' || msg.type === 'job.failed') {
        await tx.update(jobs).set({ state: 'finished', finishedAt: new Date() }).where(eq(jobs.id, job.id));
        await failWorkingBtws(tx, after, job.id, 'the agent was reset before it answered');
        after.effect((c) => {
          c.scheduler.publishJob(job.id);
          c.scheduler.jobEnded(job);
          c.runs.endJob(job.id);
        });
      }
    } else await processJobMessage(tx, after, job, session!, msg);
    await tx.update(jobs).set({ lastSeq: msg.seq }).where(eq(jobs.id, job.id));
    return true;
  });
  if (settled) ctx.runners.send(containerId, { type: 'ack', jobId: msg.jobId, seq: msg.seq });
}

async function processJobMessage(
  tx: Executor,
  after: AfterCommit,
  job: JobRow,
  session: typeof sessions.$inferSelect,
  msg: RunnerJobMessage,
): Promise<void> {
  if (job.kind === 'btw') return processBtwJobMessage(tx, after, job, msg);
  switch (msg.type) {
    case 'job.btw_event':
      return handleBtwEvent(tx, after, job, msg);

    case 'job.btw_done':
      return handleBtwDone(tx, after, job, msg);

    case 'job.worktree_ready':
      // A newly created Worktree starts clean: the changes of a previous one no longer exist.
      if (msg.created) await tx.update(sessions).set({ worktreeStatus: null }).where(eq(sessions.id, session.id));
      if (msg.created && msg.remoteBranchMissing && session.started)
        await systemComment(tx, after, job.taskId, 'The previous remote task branch was not found. The worktree was recreated from the base branch.');
      return;

    case 'job.project_skills':
      await tx.update(jobs).set({ projectSkills: projectSkills(msg.files) }).where(eq(jobs.id, job.id));
      after.effect((ctx) => ctx.scheduler.publishTask(job.taskId));
      return;

    case 'job.accepted':
      if (job.state === 'dispatched') {
        await tx.update(jobs).set({ state: 'running', startedAt: new Date() }).where(eq(jobs.id, job.id));
        after.effect((ctx) => {
          ctx.scheduler.publishJob(job.id);
          ctx.scheduler.publishTask(job.taskId);
        });
      }
      return;

    case 'job.setup_output':
      await tx
        .update(jobs)
        .set({ setupOutput: appendCapped(jobs.setupOutput, String(msg.chunk)) })
        .where(eq(jobs.id, job.id));
      after.emit(taskTopic(job.taskId), { type: 'job.setup_output', taskId: job.taskId, jobId: job.id, chunk: String(msg.chunk) });
      return;

    case 'job.stderr':
      await tx
        .update(jobs)
        .set({ stderr: appendCapped(jobs.stderr, String(msg.chunk)) })
        .where(eq(jobs.id, job.id));
      return;

    case 'job.event': {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(msg.line);
      } catch {
        parsed = { type: 'unparsed', line: String(msg.line).slice(0, 10_000) };
      }
      const [stored] = await tx
        .insert(sessionEvents)
        .values({ jobId: job.id, seq: msg.seq, payload: parsed })
        .onConflictDoNothing()
        .returning({ receivedAt: sessionEvents.receivedAt });
      if (!stored) return;
      if (!session.started) await tx.update(sessions).set({ started: true }).where(eq(sessions.id, session.id));
      // The Job's Agent may have been deleted meanwhile: its output still lands on the Timeline.
      const [agent] = job.agentId ? await tx.select().from(agents).where(eq(agents.id, job.agentId)) : [];
      const [{ name: credentialName } = { name: 'unknown' }] = agent
        ? await tx.execute<{ name: string }>(sql`select name from credentials where id = ${agent.credentialId}`).then((r) => r.rows)
        : [];
      const prev = (job.projection as ProjectionState | null) ?? initialProjection();
      const result = project(prev, parsed, { jobId: job.id, credentialName, receivedAt: stored.receivedAt.toISOString() });
      await applyProjection(tx, after, job, agent?.credentialId ?? '', result.mutations, result.broadcasts);
      if (result.state !== prev) {
        await tx
          .update(jobs)
          .set({ projection: result.state as unknown as Record<string, unknown> })
          .where(eq(jobs.id, job.id));
      }
      if (agent && (!agent.lastActivityAt || Date.now() - agent.lastActivityAt.getTime() > ACTIVITY_TOUCH_MS)) {
        await tx.update(agents).set({ lastActivityAt: new Date() }).where(eq(agents.id, agent.id));
        if (job.containerId) await tx.update(workerContainers).set({ lastActivityAt: new Date() }).where(eq(workerContainers.id, job.containerId));
      }
      if (result.mutations.some((m) => m.op === 'turn')) after.effect((ctx) => ctx.scheduler.publishJob(job.id));
      return;
    }

    case 'job.result':
      // End of a Turn: let `claude` finish what's already on stdin, then exit. Later Comments queue.
      if (job.state === 'running' || job.state === 'dispatched') {
        await tx.update(jobs).set({ state: 'finishing', hurried: false }).where(eq(jobs.id, job.id));
        // An empty Interrupt and send whose Comments `claude` read just before the interrupt: the
        // aborted Turn never answered them, and nothing left on stdin starts another Turn.
        const [unread] = job.hurried
          ? await tx.select({ id: comments.id }).from(comments).where(and(eq(comments.deliveredInJobId, job.id), eq(comments.deliveryState, 'delivered'))).limit(1)
          : [];
        const nudge = job.hurried && !unread;
        after.effect((ctx) => {
          if (job.containerId && nudge) {
            ctx.runners.send(job.containerId, { type: 'job.input', jobId: job.id, message: [{ type: 'text', text: HURRY_MESSAGE }], attachmentsToFetch: [] });
          }
          if (job.containerId) ctx.runners.send(job.containerId, { type: 'job.end', jobId: job.id });
          ctx.scheduler.publishJob(job.id);
          // The Turn can no longer be interrupted: clients hide Interrupt and send.
          ctx.scheduler.publishTask(job.taskId);
        });
      }
      return;

    case 'job.exited': {
      await settleProjection(tx, after, job);
      await failWorkingBtws(tx, after, job.id, 'the agent finished before the answer came');
      const crashed = job.state !== 'finishing' && !job.cancelRequested && msg.exitCode !== 0;
      const missing = /No conversation found/i.test(job.stderr);
      // `claude` created the session before dying without output: resume it from now on.
      const exists = !session.started && /Session ID .* is already in use/i.test(job.stderr);
      await tx
        .update(jobs)
        .set({
          state: crashed ? 'failed' : 'finished',
          exitCode: msg.exitCode,
          signal: msg.signal,
          finishedAt: new Date(),
          error: crashed ? `claude exited with ${msg.signal ? `signal ${msg.signal}` : `code ${msg.exitCode}`}` : null,
        })
        .where(eq(jobs.id, job.id));
      if (session.state === 'running')
        await tx
          .update(sessions)
          .set({ state: restingState(session) })
          .where(eq(sessions.id, session.id));
      if (!job.cancelRequested && missing) {
        // The transcript is gone (e.g. the Worker Volume was reset): the next Job starts over with the Task's history.
        // State and `started` must agree: a Session without a conversation is `pending`, not `idle`.
        await tx
          .update(sessions)
          .set({
            started: false,
            // A reopened Session may be idle while its cancelled Job exits; without a
            // transcript it must wait for the next Comment to start over.
            ...(session.state === 'closed' || session.state === 'paused' ? {} : { state: 'pending' as const }),
          })
          .where(eq(sessions.id, session.id));
        await reportJobFailure(
          tx,
          after,
          job,
          "The agent's previous conversation for this task wasn't found, so its next run starts a new conversation with the task's history.",
        );
      } else if (!job.cancelRequested && exists) {
        await tx
          .update(sessions)
          .set({ started: true, state: session.state === 'running' ? 'idle' : session.state })
          .where(eq(sessions.id, session.id));
        await reportJobFailure(
          tx,
          after,
          job,
          "The agent's conversation already existed, so its next run resumes it. Post a comment (or press **Retry**) to continue.",
        );
        if (session.state === 'running') await requeue(tx, after, job, { ...session, started: true }, { held: true });
      } else if (!crashed && !job.cancelRequested && session.state === 'running' && (job.projection as ProjectionState | null)?.reads) {
        // The CLI echoes every Message it reads: one still unread when it exits never reached the
        // Agent (an interrupt can drop what was waiting), so it goes back to the front of the Queue.
        await requeueUnread(tx, after, job, session);
      } else if (crashed) {
        await reportJobFailure(
          tx,
          after,
          job,
          `The agent's process stopped unexpectedly (${msg.signal ? `signal ${msg.signal}` : `exit code ${msg.exitCode}`}).${tail(job.stderr)}`,
        );
      }
      // A Scheduled Run ends with its first Job, unless the Job is about to start over.
      if (job.cancelRequested || (!missing && !exists)) await settleRun(tx, after, job.id);
      // The Runner is still connected: keep the Worktree's changes for the Task view.
      if (!job.cancelRequested && job.containerId) {
        const containerId = job.containerId;
        after.effect((ctx) => {
          void captureWorktreeStatus(ctx, session.id, session.worktreePath, containerId).catch((err: unknown) =>
            ctx.log.warn({ err, taskId: job.taskId }, 'could not read the worktree changes'),
          );
        });
      }
      await applyPendingClear(tx, after, session.id);
      after.effect((ctx) => {
        ctx.scheduler.publishJob(job.id);
        ctx.scheduler.publishTask(job.taskId);
        ctx.scheduler.jobEnded(job);
      });
      return;
    }

    case 'job.failed':
      if (job.cancelRequested) {
        // Cancelled before `claude` started (the Task was closed): nothing to report.
        await tx.update(jobs).set({ state: 'finished', finishedAt: new Date() }).where(eq(jobs.id, job.id));
        await applyPendingClear(tx, after, session.id);
        after.effect((ctx) => {
          ctx.scheduler.publishJob(job.id);
          ctx.scheduler.jobEnded(job);
        });
        return;
      }
      await failJob(tx, after, job, session, msg.stage, String(msg.message));
      return;
  }
}

async function failJob(
  tx: Executor,
  after: AfterCommit,
  job: JobRow,
  session: typeof sessions.$inferSelect,
  stage: JobFailureStage,
  message: string,
): Promise<void> {
  await tx.update(jobs).set({ state: 'failed', failureStage: stage, error: message, finishedAt: new Date() }).where(eq(jobs.id, job.id));
  await failWorkingBtws(tx, after, job.id, 'the agent could not start');
  const stillActive = session.state === 'running';
  if (stillActive)
    await tx
      .update(sessions)
      .set({ state: restingState(session) })
      .where(eq(sessions.id, session.id));
  const what = { worktree: 'preparing the worktree', setup: 'running the setup script', spawn: 'starting Claude Code' }[stage] ?? stage;
  await reportJobFailure(
    tx,
    after,
    job,
    `The agent couldn't start: ${what} failed.\n\n> ${message.split('\n').join('\n> ')}${tail(job.setupOutput)}\n\nFix the problem, then press **Retry** (or post a comment).`,
  );
  // Its Messages go back to the front of the Queue, waiting for a Retry instead of looping.
  if (stillActive) await requeue(tx, after, job, session, { held: true });
  await settleRun(tx, after, job.id);
  await applyPendingClear(tx, after, session.id);
  if (job.containerId) {
    const containerId = job.containerId;
    after.effect((ctx) => {
      void captureWorktreeStatus(ctx, session.id, session.worktreePath, containerId).catch((err: unknown) =>
        ctx.log.warn({ err, taskId: job.taskId }, 'could not read the worktree changes'),
      );
    });
  }
  after.effect((ctx) => {
    ctx.scheduler.publishJob(job.id);
    ctx.scheduler.publishTask(job.taskId);
    ctx.scheduler.jobEnded(job);
  });
}

/**
 * A Job whose process is gone without saying so (container restart, crash, Runner away too long):
 * it's interrupted, and the Session resumes from the front of the Queue.
 */
export async function recoverJob(tx: Executor, after: AfterCommit, job: JobRow): Promise<void> {
  // A discarded Job has no projection to settle, but its live Runs still go with it.
  if (!job.discardOutput) await settleProjection(tx, after, job);
  else after.effect((ctx) => ctx.runs.endJob(job.id));
  await tx.update(jobs).set({ state: 'interrupted', finishedAt: new Date() }).where(eq(jobs.id, job.id));
  await failWorkingBtws(tx, after, job.id, 'the agent was interrupted before it answered');
  const [session] = await tx.select().from(sessions).where(eq(sessions.id, job.sessionId)).for('update');
  if (!job.discardOutput && session?.state === 'running') {
    const workerId = await workerOfTask(tx, job.taskId);
    await tx
      .update(sessions)
      .set({ state: restingState(session) })
      .where(eq(sessions.id, session.id));
    // `lastSeq` also counts handshake messages (`job.accepted`): only stored stream
    // output proves the Turn actually started. Otherwise the Job had not run yet and
    // its Comments must go back to the Queue instead of being retired as delivered.
    if (job.projection !== null && session.started && job.state !== 'finishing') {
      await enqueue(tx, after, { workerId, taskId: job.taskId, sessionId: session.id, kind: 'resume_interrupted', front: true });
      await systemComment(tx, after, job.taskId, "The agent's container restarted in the middle of a turn. Resuming where it left off.");
    } else if (job.state !== 'finishing') {
      // Nothing ran yet: the same work goes back to the front.
      await requeue(tx, after, job, session, { held: false });
    }
  }
  if (job.kind !== 'btw') await applyPendingClear(tx, after, job.sessionId);
  after.effect((ctx) => {
    ctx.scheduler.publishJob(job.id);
    ctx.scheduler.publishTask(job.taskId);
  });
}

/** The Job is over: its tool calls still waiting for a result never get one, and its Runs' transcripts go with it. */
async function settleProjection(tx: Executor, after: AfterCommit, job: JobRow): Promise<void> {
  if (job.projection) {
    const result = endJob(job.projection as unknown as ProjectionState);
    if (result.mutations.length > 0) {
      await applyProjection(tx, after, job, '', result.mutations, result.broadcasts);
      await tx
        .update(jobs)
        .set({ projection: result.state as unknown as Record<string, unknown> })
        .where(eq(jobs.id, job.id));
    }
  }
  // After the Run settlements above, so their events still reach the browser.
  after.effect((ctx) => ctx.runs.endJob(job.id));
}

/** Puts a Job's Messages back in a Queue Entry at the front (they become `queued` again). */
async function requeue(tx: Executor, after: AfterCommit, job: JobRow, session: typeof sessions.$inferSelect, opts: { held: boolean }) {
  const entry = await enqueue(tx, after, {
    workerId: await workerOfTask(tx, job.taskId),
    taskId: job.taskId,
    sessionId: session.id,
    kind: session.started ? job.kind : 'start',
    front: true,
    held: opts.held,
  });
  // A handled Comment was read by a Turn: only the ones still waiting to be read go back.
  const delivered = await tx.select({ id: comments.id }).from(comments).where(and(eq(comments.deliveredInJobId, job.id), ne(comments.deliveryState, 'handled')));
  await attachComments(
    tx,
    after,
    entry.id,
    delivered.map((c) => c.id),
  );
}

async function requeueUnread(tx: Executor, after: AfterCommit, job: JobRow, session: typeof sessions.$inferSelect) {
  const unread = await tx
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.deliveredInJobId, job.id), eq(comments.deliveryState, 'delivered'), sql`${comments.deletedAt} is null`));
  if (unread.length === 0) return;
  const entry = await enqueue(tx, after, { workerId: await workerOfTask(tx, job.taskId), taskId: job.taskId, sessionId: session.id, kind: 'messages', front: true });
  await attachComments(tx, after, entry.id, unread.map((c) => c.id));
}

/** Between Jobs a Session is `idle`, or still `pending` if `claude` never created it. */
function restingState(session: typeof sessions.$inferSelect): 'idle' | 'pending' {
  return session.started ? 'idle' : 'pending';
}

export async function systemComment(tx: Executor, after: AfterCommit, taskId: string, body: string): Promise<string> {
  const [row] = await tx
    .insert(comments)
    .values({ taskId, kind: 'system', authorType: 'system', authorId: null, body, createdAt: sql`clock_timestamp()` })
    .returning({ id: comments.id });
  after.effect((ctx) => ctx.scheduler.publishComments([row!.id], 'created'));
  return row!.id;
}

/** The System Comment that reports a failed Job is what its "needs intervention" Alert previews. */
async function reportJobFailure(tx: Executor, after: AfterCommit, job: JobRow, body: string): Promise<void> {
  await setAlertComment(tx, jobEventId(job.id), await systemComment(tx, after, job.taskId, body));
}

function tail(output: string, lines = 20): string {
  const t = output.trimEnd().split('\n').slice(-lines).join('\n');
  return t ? `\n\n\`\`\`\n${t.replace(/```/g, "'''")}\n\`\`\`` : '';
}

/**
 * After a backend restart every Runner connection is gone, and no `close` event reports it:
 * timestamp them all, so a Runner that stays away is recovered by `recoverAbandonedJobs` and
 * recycled by the reconciler instead of leaving its Worker's Queue waiting forever.
 */
export async function markRunnerConnectionsLost(db: Executor, at = new Date()): Promise<void> {
  await db.update(workerContainers).set({ runnerDisconnectedAt: at });
}

/** Jobs whose Runner has been away longer than the timeout are treated as interrupted. */
export async function recoverAbandonedJobs(ctx: AppContext): Promise<void> {
  const cutoff = new Date(Date.now() - ctx.config.agents.runnerReconnectTimeoutMs);
  const stale = await ctx.db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(workerContainers, eq(workerContainers.id, jobs.containerId))
    .where(and(inArray(jobs.state, [...ACTIVE_JOB_STATES]), lt(workerContainers.runnerDisconnectedAt, cutoff)));
  for (const { job } of stale) {
    if (!job.containerId || !job.workerId || ctx.runners.isConnected(job.containerId)) continue;
    const containerId = job.containerId;
    const workerId = job.workerId;
    await transactWithRetry(ctx, async (tx, after) => {
      await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, job.taskId)).for('key share');
      await getWorkerRow(tx, workerId, { lock: true });
      const [container] = await tx.select().from(workerContainers).where(eq(workerContainers.id, containerId));
      // A Runner that reconnected while this transaction waited must keep its Job.
      if (!container?.runnerDisconnectedAt || container.runnerDisconnectedAt >= cutoff || ctx.runners.isConnected(containerId)) return;
      const [current] = await tx.select().from(jobs).where(eq(jobs.id, job.id)).for('update');
      if (current && (ACTIVE_JOB_STATES as readonly string[]).includes(current.state)) await recoverJob(tx, after, current);
    });
  }
}

/** One stdout line of a Btw fork. Stored with the thread; only its answer reaches the Timeline. */
async function handleBtwEvent(tx: Executor, after: AfterCommit, job: JobRow, msg: Extract<RunnerJobMessage, { type: 'job.btw_event' }>): Promise<void> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(msg.line);
    parsed = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const [thread] = UUID.test(String(msg.btwId)) ? await tx.select().from(btwThreads).where(eq(btwThreads.id, msg.btwId)).for('update') : [];
  if (!thread || thread.taskId !== job.taskId) return;
  const [stored] = await tx
    .insert(sessionEvents)
    .values({ jobId: job.id, seq: msg.seq, payload: parsed ?? { type: 'unparsed', line: String(msg.line).slice(0, 10_000) }, btwThreadId: thread.id })
    .onConflictDoNothing()
    .returning({ seq: sessionEvents.seq });
  if (!stored || thread.state !== 'working' || !parsed) return;
  const sessionId = typeof parsed.session_id === 'string' && parsed.session_id ? parsed.session_id : null;
  const forkSessionId = thread.forkSessionId ?? sessionId;
  if (forkSessionId !== thread.forkSessionId) await tx.update(btwThreads).set({ forkSessionId }).where(eq(btwThreads.id, thread.id));
  if (parsed.type !== 'result') return;
  const text = typeof parsed.result === 'string' ? parsed.result.trim() : '';
  if (parsed.is_error === true || !text) {
    const errors = Array.isArray(parsed.errors) ? parsed.errors.filter((e): e is string => typeof e === 'string').join('; ') : '';
    await failBtw(tx, after, { ...thread, forkSessionId }, errors || (text ? text : 'the answer came back empty'));
    return;
  }
  await answerBtw(tx, after, { ...thread, forkSessionId }, {
    text,
    agentId: job.agentId,
    jobId: job.id,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
    usage: parsed.usage && typeof parsed.usage === 'object' ? (parsed.usage as Record<string, unknown>) : null,
    forkSessionId,
  });
}

/** The fork ended. Without a result it never answered. */
async function handleBtwDone(tx: Executor, after: AfterCommit, job: JobRow, msg: Extract<RunnerJobMessage, { type: 'job.btw_done' }>): Promise<void> {
  const [thread] = UUID.test(String(msg.btwId)) ? await tx.select().from(btwThreads).where(eq(btwThreads.id, msg.btwId)).for('update') : [];
  if (!thread || thread.taskId !== job.taskId || thread.state !== 'working') return;
  const how = msg.signal ? `it was stopped by ${msg.signal}` : msg.exitCode !== null && msg.exitCode !== 0 ? `it exited with code ${msg.exitCode}` : 'it ended without an answer';
  await failBtw(tx, after, thread, `${how}.${tail(String(msg.stderr ?? ''), 5)}`);
}

/** A Btw Job runs one fork and nothing else: it has no Turns, no Messages and no Session state of its own. */
async function processBtwJobMessage(tx: Executor, after: AfterCommit, job: JobRow, msg: RunnerJobMessage): Promise<void> {
  const finish = async (state: 'finished' | 'failed', error: string | null) => {
    await tx.update(jobs).set({ state, error, finishedAt: new Date() }).where(eq(jobs.id, job.id));
    await failWorkingBtws(tx, after, job.id, error ?? 'the agent finished before the answer came');
    after.effect((ctx) => {
      ctx.scheduler.publishJob(job.id);
      ctx.scheduler.publishTask(job.taskId);
      ctx.scheduler.jobEnded(job);
    });
  };
  switch (msg.type) {
    case 'job.accepted':
      if (job.state === 'dispatched') {
        await tx.update(jobs).set({ state: 'running', startedAt: new Date() }).where(eq(jobs.id, job.id));
        after.effect((ctx) => ctx.scheduler.publishJob(job.id));
      }
      return;
    case 'job.btw_event':
      return handleBtwEvent(tx, after, job, msg);
    case 'job.btw_done':
      return handleBtwDone(tx, after, job, msg);
    case 'job.exited':
      return finish(msg.exitCode === 0 ? 'finished' : 'failed', msg.exitCode === 0 ? null : `claude exited with ${msg.signal ? `signal ${msg.signal}` : `code ${msg.exitCode}`}`);
    case 'job.failed':
      return finish('failed', String(msg.message));
    default:
      return;
  }
}
