import { workerConnection } from '../modules/hosts/service';
import { randomUUID } from 'node:crypto';
import { gitSlug, taskBranch } from '../git/branches';
import { scheduleOfProject } from '../modules/schedules/service';
import { gitOwnerTask } from '../git/owner';
// The dispatcher: turns a Worker's Queue Entries into Jobs, one per free Worker Container.
import { agentProfilePath, commandName, GIT_PROXY_PATH, MCP_PATH, RUNNER_WS_PATH } from '@claude-task/shared';
import type { JobStartMessage } from '@claude-task/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { AfterCommit, AppContext } from '../context';
import { transactWithRetry } from '../context';
import { agentProfiles, agents, btwThreads, comments, jobs, projectEnvVars, projects, queueEntries, sessions, tasks, workerContainers, workers } from '../db/schema';
import type { Executor } from '../db/client';
import { ACTIVE_JOB_STATES, getAgentRow } from '../modules/agents/service';
import { desiredContainerSpec, getWorkerRow } from '../modules/workers/service';
import type { WorkerContainerRow, WorkerRow } from '../modules/workers/service';
import { credentialEnv } from '../modules/credentials/service';
import { agentExtensions, resolvedMcp } from '../modules/extensions/service';
import { PLATFORM_SKILL_NAME } from '../modules/extensions/platform-skill';
import type { GitProvider } from '../git/provider';
import { systemComment } from '../runner/handlers';
import { newToken } from '../secrets';
import { CONTINUE_MESSAGE, RESUME_MESSAGE, agentChangeNotice, inlineBudget, renderComments, renderTaskFiles, startMessage, systemPrompt, taskSnapshot } from './messages';
import type { CommentRow, MessageParts } from './messages';
import { BTW_SYSTEM_PROMPT, failBtw, sessionIdentity } from './btw-state';
import { carriesDelivery } from './queue';

export const runnerWsUrl = (backendUrl: string) => `${backendUrl.replace(/^http/, 'ws')}${RUNNER_WS_PATH}`;
export const gitProxyUrl = (backendUrl: string, projectId: string) => `${backendUrl}${GIT_PROXY_PATH}/${projectId}.git`;

/** A Queue Entry the dispatcher may start: not held, its Task's Agent enabled, its Worktree free. */
export interface ReadyEntry {
  id: string;
  taskId: string;
  agentId: string;
  lastSlot: number | null;
}

/**
 * The Worker's entries that can start now, in Queue order. Chats of one Wiki share a Worktree, so
 * an entry whose Worktree has an active Job of this Worker waits; entries whose Agent is disabled
 * wait too, without holding up the others.
 */
export async function readyEntries(db: Executor, workerId: string): Promise<ReadyEntry[]> {
  const rows = await db
    .select({ id: queueEntries.id, taskId: queueEntries.taskId, agentId: tasks.agentId, lastSlot: sessions.lastSlot, worktreePath: sessions.worktreePath })
    .from(queueEntries)
    .innerJoin(tasks, eq(tasks.id, queueEntries.taskId))
    .innerJoin(sessions, eq(sessions.id, queueEntries.sessionId))
    .innerJoin(agents, eq(agents.id, tasks.agentId))
    .where(and(eq(queueEntries.workerId, workerId), eq(queueEntries.held, false), eq(agents.enabled, true)))
    .orderBy(asc(queueEntries.position), asc(queueEntries.id));
  if (rows.length === 0) return [];
  const busy = new Set(
    (
      await db
        .select({ worktreePath: sessions.worktreePath })
        .from(jobs)
        .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
        .where(and(eq(jobs.workerId, workerId), inArray(jobs.state, [...ACTIVE_JOB_STATES])))
    ).map((r) => r.worktreePath),
  );
  return rows.filter((r) => !busy.has(r.worktreePath)).map(({ id, taskId, agentId, lastSlot }) => ({ id, taskId, agentId: agentId!, lastSlot }));
}

/** Whether the Agent's Profile on this Worker holds its current Extensions. */
export async function profileReady(db: Executor, workerId: string, agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ applied: agentProfiles.appliedRevision, revision: agents.extensionsRevision })
    .from(agents)
    .leftJoin(agentProfiles, and(eq(agentProfiles.agentId, agents.id), eq(agentProfiles.workerId, workerId)))
    .where(eq(agents.id, agentId));
  return !!row && row.applied === row.revision;
}

/** The Worker Containers that can take a Job now, lowest slot first. */
export async function freeContainers(ctx: AppContext, db: Executor, worker: WorkerRow): Promise<WorkerContainerRow[]> {
  if (!worker.enabled) return [];
  const desired = desiredContainerSpec(worker, await workerConnection(ctx, db, worker.hostId));
  if (!desired) return [];
  const rows = await db
    .select()
    .from(workerContainers)
    .where(and(eq(workerContainers.workerId, worker.id), eq(workerContainers.containerState, 'running'), ctx.runtimes.has(worker.hostId) ? eq(workerContainers.containerSpec, desired) : undefined, eq(workerContainers.forceRecreate, false)))
    .orderBy(asc(workerContainers.slot));
  const busy = new Set(
    (await db.select({ containerId: jobs.containerId }).from(jobs).where(and(eq(jobs.workerId, worker.id), inArray(jobs.state, [...ACTIVE_JOB_STATES])))).map((r) => r.containerId),
  );
  return rows.filter((c) => c.slot <= worker.cap && !busy.has(c.id) && ctx.runners.isReady(c.id));
}

/** Dispatches the next Job of the Worker if one of its containers can take it. Returns whether it did. */
export async function dispatchNext(ctx: AppContext, workerId: string, attempt = 0): Promise<boolean> {
  const [worker] = await ctx.db.select().from(workers).where(eq(workers.id, workerId));
  if (!worker) return false;
  const free = await freeContainers(ctx, ctx.db, worker);
  if (free.length === 0) return false;
  for (const head of await readyEntries(ctx.db, workerId)) {
    if (!(await profileReady(ctx.db, workerId, head.agentId))) {
      ctx.scheduler.syncProfile(workerId, head.agentId);
      continue;
    }
    // The slot that worked the Task last still has its services' data and background processes.
    const container = free.find((c) => c.slot === head.lastSlot) ?? free[0]!;
    const result = await dispatchEntry(ctx, worker.id, container.id, head);
    if (result === 'dispatched') return true;
    if (result === 'retry') return attempt < 10 ? dispatchNext(ctx, workerId, attempt + 1) : false;
    if (result === 'not_ready') return false;
  }
  return false;
}

async function dispatchEntry(ctx: AppContext, workerId: string, containerId: string, head: ReadyEntry): Promise<'dispatched' | 'retry' | 'not_ready' | 'skip'> {
  // Peeked without locks: lock in the canonical order (task, worker) and re-check.
  return transactWithRetry(ctx, async (tx, after) => {
    await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, head.taskId)).for('key share');
    const worker = await getWorkerRow(tx, workerId, { lock: true });
    const connection = await workerConnection(ctx, tx, worker.hostId);
    const [container] = await tx.select().from(workerContainers).where(eq(workerContainers.id, containerId)).for('update');
    const desired = desiredContainerSpec(worker, connection);
    const ready =
      worker.enabled &&
      !!container &&
      container.slot <= worker.cap &&
      container.containerState === 'running' &&
      !container.forceRecreate &&
      container.containerSpec !== null &&
      (!ctx.runtimes.has(worker.hostId) || container.containerSpec === desired) &&
      ctx.runners.isReady(container.id);
    if (!ready) return 'not_ready' as const;
    const [busy] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.containerId, containerId), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
    if (busy) return 'not_ready' as const;
    const [entry] = await tx
      .select()
      .from(queueEntries)
      .where(and(eq(queueEntries.id, head.id), eq(queueEntries.workerId, workerId), eq(queueEntries.held, false)))
      .for('update', { skipLocked: true });
    if (!entry) return 'retry' as const;

    const [session] = await tx.select().from(sessions).where(eq(sessions.id, entry.sessionId)).for('update');
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, entry.taskId));
    if (!task?.agentId) return 'skip' as const;
    const agent = await getAgentRow(tx, task.agentId);
    if (!agent.enabled) return 'skip' as const;
    if (!(await profileReady(tx, workerId, agent.id))) return 'skip' as const;
    const [worktreeBusy] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
      .where(and(eq(jobs.workerId, workerId), inArray(jobs.state, [...ACTIVE_JOB_STATES]), eq(sessions.worktreePath, session!.worktreePath)));
    if (worktreeBusy) return 'skip' as const;
    if (entry.btwCommentId) return dispatchBtwJob(ctx, tx, after, { worker, container: container!, connection, entry, session: session!, task: task!, agent });
    const agentId = agent.id;
    const [project] = await tx.select().from(projects).where(eq(projects.id, task!.projectId));
    const snapshot = await taskSnapshot(tx, task!.id);
    const repository = project!.repository;
    const schedule = await scheduleOfProject(tx, project!.id);
    // A Wiki's Chats share the branch of the Wiki's first Task.
    const owner = await gitOwnerTask(tx, task!);
    const ownerSnapshot = owner.id === task!.id ? snapshot : await taskSnapshot(tx, owner.id);
    const branch = repository ? (owner.branchName ?? taskBranch(ownerSnapshot.key, ownerSnapshot.title)) : null;
    let git: GitProvider | null = null;
    let branchExists = false;
    if (repository && branch) {
      try {
        git = await ctx.git.provider(repository.connectionId);
        branchExists = await git.branchExists(repository, branch);
      } catch (err) {
        // Holding the entry lets the rest of the Queue go on; Retry (or a Comment) tries again.
        const reason = err instanceof Error ? err.message : String(err);
        await tx.update(queueEntries).set({ held: true }).where(eq(queueEntries.id, entry.id));
        await systemComment(
          tx,
          after,
          task!.id,
          `The agent couldn't start: checking the task branch on the git provider failed.\n\n> ${reason.split('\n').join('\n> ')}\n\nPress **Retry** (or post a comment) to try again.`,
        );
        after.effect((c) => {
          c.scheduler.publishQueue(workerId, [task!.id]);
          c.scheduler.publishTask(task!.id);
        });
        return 'retry' as const;
      }
    }
    if (git && repository && branch) {
      await tx
        .update(tasks)
        .set({ branchName: branch, branchUrl: git.branchWebUrl(repository, branch) })
        .where(eq(tasks.id, owner.id));
    }

    // A Session `claude` never created starts from the whole Task, whatever the entry says.
    const fresh = !session!.started;
    const attached = await tx
      .select()
      .from(comments)
      .where(and(eq(comments.queueEntryId, entry.id), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt), asc(comments.id));
    // Keep slash commands as standalone CLI inputs, in order with normal queued Comments.
    const commandIndex = attached.findIndex((c) => c.kind === 'user' && !c.noticeMessage && commandName(c.body));
    const batch = commandIndex === 0 ? attached.slice(0, 1) : commandIndex > 0 ? attached.slice(0, commandIndex) : attached;
    const remaining = new Set(attached.slice(batch.length).map((c) => c.id));
    let included: CommentRow[];
    let message: MessageParts;
    if (fresh) {
      included = (await conversation(tx, task!.id, entry.id)).filter((c) => !remaining.has(c.id));
      // `claude` runs the last text block as the input and keeps earlier blocks as context, so a
      // first command (/init, a skill) stays native when the Task context comes before it.
      const command = commandIndex === 0 ? batch[0]! : null;
      const seenFiles = new Set<string>();
      // One inline-image budget for the whole first Message.
      const budget = inlineBudget();
      const files = await renderTaskFiles(ctx, tx, task!.id, snapshot.description, seenFiles, budget);
      const context = await renderComments(ctx, tx, included.filter((c) => c.id !== command?.id), seenFiles, budget);
      message = startMessage(snapshot, context, { branch, files });
      if (command) {
        const input = await renderComments(ctx, tx, [command], seenFiles, budget);
        message = { blocks: [...message.blocks, ...input.blocks], fetch: [...message.fetch, ...input.fetch] };
      }
      // Notices made while the Session was pending are covered by the snapshot.
      included = [...included, ...batch.filter((c) => !included.some((i) => i.id === c.id))];
    } else {
      included = batch;
      message = await renderComments(ctx, tx, batch);
      if (message.blocks.length === 0) {
        message.blocks.push({ type: 'text', text: entry.kind === 'resume_interrupted' ? RESUME_MESSAGE : CONTINUE_MESSAGE });
      }
      // The Agent Change Notice: the Task's Agent is not the one that worked the conversation last.
      if (session!.lastAgentId !== agentId) {
        const [last] = await tx.select({ agentName: jobs.agentName }).from(jobs).where(eq(jobs.sessionId, session!.id)).orderBy(desc(jobs.createdAt)).limit(1);
        message.blocks.unshift({ type: 'text', text: agentChangeNotice(agent.name, last?.agentName || null) });
      }
    }

    const credential = await credentialEnv(tx, ctx.config.secrets, agent.credentialId);
    // The Agent's own environment is more specific than the Project's; the Credential's variable is reserved.
    const env: Record<string, string> = { ...(await projectEnv(ctx, tx, project!.id)), ...agent.env, ...credential.env };
    const resumeInterrupted = entry.kind === 'resume_interrupted' && !fresh;
    if (resumeInterrupted) env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = '1';

    const jobToken = newToken();
    const [job] = await tx
      .insert(jobs)
      .values({ sessionId: session!.id, agentId, agentName: agent.name, workerId, containerId, slot: container.slot, taskId: task!.id, kind: entry.kind, tokenHash: jobToken.hash })
      .returning();
    if (remaining.size) await tx.update(queueEntries).set({ kind: 'messages' }).where(eq(queueEntries.id, entry.id));
    else await tx.delete(queueEntries).where(eq(queueEntries.id, entry.id));
    // Its uuid comes back in the CLI's replay once `claude` reads it (docs/specs/agent-sessions.md).
    const initialMessageId = randomUUID();
    if (included.length > 0) {
      await tx
        .update(comments)
        .set({
          queueEntryId: null,
          deliveredInJobId: job!.id,
          deliveredMessageId: initialMessageId,
          deliveryState: sql`case when ${carriesDelivery} then 'delivered'::delivery_state else ${comments.deliveryState} end`,
          deliveryReason: null,
        })
        .where(
          inArray(
            comments.id,
            included.map((c) => c.id),
          ),
        );
    }
    const seen = Math.max(session!.lastSeenTaskVersion, fresh ? snapshot.version : 0, ...included.map((c) => c.noticeTaskVersion ?? 0));
    await tx
      .update(sessions)
      .set({ state: 'running', lastJobAt: new Date(), lastSeenTaskVersion: seen, lastAgentId: agentId, lastSlot: container.slot })
      .where(eq(sessions.id, session!.id));

    const extensions = await agentExtensions(tx, agentId);
    const start: JobStartMessage = {
      type: 'job.start',
      jobId: job!.id,
      sessionId: sessionIdentity(session!),
      mode: fresh ? 'new' : 'resume',
      resumeInterrupted,
      worktreePath: session!.worktreePath,
      agentProfilePath: agentProfilePath(agentId),
      git:
        repository && branch
          ? {
              // Agents reach git only through the Git Proxy, with their Job token (docs/specs/git-integration.md).
              cloneUrl: gitProxyUrl(connection.backendUrl!, project!.id),
              token: jobToken.token,
              repositoryId: `${repository.connectionId}/${repository.providerRepoId}`,
              baseBranch: repository.baseBranch,
              taskBranch: branch,
              branchExists,
              repoPath: `repos/${project!.id}.git`,
              commitName: `${agent.name} (claude-task)`,
              commitEmail: `${gitSlug(agent.name, 64) || 'agent'}@${ctx.config.agents.commitEmailDomain}`,
            }
          : null,
      setupScript: project!.setupScript,
      env,
      claudeArgs: {
        model: agent.model,
        effort: agent.effort,
        permissionMode: agent.permissionMode,
        appendSystemPrompt: systemPrompt({
          agentName: agent.name,
          taskKey: snapshot.key,
          projectName: snapshot.projectName,
          worktreePath: session!.worktreePath,
          branch,
          projectInstructions: project!.agentInstructions,
          agentPrompt: agent.systemPrompt,
          services: worker.services,
          boardWriteAccess: project!.kind === 'project' && !schedule && project!.boardWriteAccess,
          schedule: schedule ? { global: !repository, readOnly: schedule.readOnly } : null,
          platformSkill: extensions.skills.some((skill) => skill.name === PLATFORM_SKILL_NAME && skill.source === 'platform'),
        }),
        mcpConfig: JSON.stringify({
          mcpServers: {
            ...resolvedMcp(ctx, extensions.mcpServers),
            'claude-task': {
              type: 'http',
              url: `${connection.backendUrl!}${MCP_PATH}`,
              headers: { Authorization: `Bearer ${jobToken.token}` },
            },
          },
        }),
        // Nobody can answer Claude Code's own question dialog in a headless Job: Agents use ask_question.
        disallowedTools: ['AskUserQuestion'],
        // The Run transcripts show what a subagent writes; the Runner adds the flag where the CLI has it.
        forwardSubagentText: true,
        // Deliveries turn `handled` when the CLI echoes the Message it read.
        replayUserMessages: true,
      },
      initialMessage: message.blocks,
      initialMessageId,
      attachmentsToFetch: message.fetch,
    };
    after.effect((c) => {
      c.runners.send(containerId, start);
      c.scheduler.publishQueue(workerId, [task!.id]);
      c.scheduler.publishTask(task!.id);
      c.scheduler.publishComments(included.map((i) => i.id));
      c.scheduler.publishJob(job!.id);
      c.scheduler.publishWorker(workerId);
      c.scheduler.publishAgent(agentId);
    });
    return 'dispatched' as const;
  });
}

/** What a new Session reads first: every non-internal Comment by Users and Agents, oldest first. */
async function conversation(db: Executor, taskId: string, entryId: string): Promise<CommentRow[]> {
  return db
    .select()
    .from(comments)
    .where(
      and(
        eq(comments.taskId, taskId),
        eq(comments.internal, false),
        isNull(comments.deletedAt),
        or(eq(comments.kind, 'user'), eq(comments.kind, 'agent'), isNotNull(comments.noticeMessage)),
        // A Clear starts the Agent's conversation over: it begins after the latest Chat Cleared line,
        // with what was posted while the Clear waited, which is queued for this very Job.
        or(
          eq(comments.queueEntryId, entryId),
          sql`${comments.createdAt} > coalesce((select max(m.created_at) from comments m where m.task_id = ${taskId} and m.clear_marker and m.deleted_at is null), '-infinity'::timestamptz)`,
        ),
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

/** Project env vars, secrets decrypted: only ever sent in this Project's Job payloads. */
export async function projectEnv(ctx: AppContext, db: Executor, projectId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, projectId));
  return Object.fromEntries(rows.map((r) => [r.name, r.secret ? ctx.config.secrets.decrypt(r.valueCiphertext!) : (r.value ?? '')]));
}

/**
 * A `btw` entry becomes a Btw Job: it runs the fork in the Session's Worktree and prepares nothing
 * else. The Session stays as it is, and so does the Queue Entry of its next Job.
 */
async function dispatchBtwJob(
  ctx: AppContext,
  tx: Executor,
  after: AfterCommit,
  d: {
    worker: WorkerRow;
    container: WorkerContainerRow;
    connection: Awaited<ReturnType<typeof workerConnection>>;
    entry: typeof queueEntries.$inferSelect;
    session: typeof sessions.$inferSelect;
    task: typeof tasks.$inferSelect;
    agent: Awaited<ReturnType<typeof getAgentRow>>;
  },
): Promise<'dispatched' | 'retry'> {
  const { worker, container, entry, session, task, agent } = d;
  const [thread] = await tx.select().from(btwThreads).where(eq(btwThreads.workingCommentId, entry.btwCommentId!)).for('update');
  const [question] = await tx.select({ body: comments.body, deletedAt: comments.deletedAt }).from(comments).where(eq(comments.id, entry.btwCommentId!));
  await tx.delete(queueEntries).where(eq(queueEntries.id, entry.id));
  after.effect((c) => c.scheduler.publishQueue(worker.id, [task.id]));
  const identity = sessionIdentity(session);
  const stale = !thread || thread.originSessionId !== identity || !session.started || session.state === 'closed';
  if (stale || !question || question.deletedAt) {
    // The conversation it asked about is gone (a Clear), or the Session can no longer answer.
    if (thread) await failBtw(tx, after, thread, stale ? 'the conversation was cleared or the task closed before the agent could answer' : 'the question was deleted');
    return 'retry';
  }
  const credential = await credentialEnv(tx, ctx.config.secrets, agent.credentialId);
  const env: Record<string, string> = { ...(await projectEnv(ctx, tx, task.projectId)), ...agent.env, ...credential.env };
  const jobToken = newToken();
  const [job] = await tx
    .insert(jobs)
    .values({ sessionId: session.id, agentId: agent.id, agentName: agent.name, workerId: worker.id, containerId: container.id, slot: container.slot, taskId: task.id, kind: 'btw', tokenHash: jobToken.hash })
    .returning();
  await tx.update(btwThreads).set({ workingJobId: job!.id }).where(eq(btwThreads.id, thread.id));
  const start: JobStartMessage = {
    type: 'job.start',
    jobId: job!.id,
    sessionId: identity,
    mode: 'btw',
    resumeInterrupted: false,
    worktreePath: session.worktreePath,
    agentProfilePath: agentProfilePath(agent.id),
    git: null,
    setupScript: '',
    env,
    claudeArgs: { model: agent.model, effort: null, permissionMode: agent.permissionMode, appendSystemPrompt: '', mcpConfig: '', disallowedTools: [], forwardSubagentText: false, replayUserMessages: false },
    initialMessage: null,
    initialMessageId: null,
    attachmentsToFetch: [],
    btw: {
      id: thread.id,
      question: question.body,
      mode: thread.forkSessionId ? 'resume' : 'fork',
      sessionId: thread.forkSessionId ?? identity,
      model: agent.model,
      appendSystemPrompt: BTW_SYSTEM_PROMPT,
    },
  };
  after.effect((c) => {
    c.runners.send(container.id, start);
    c.scheduler.publishJob(job!.id);
    c.scheduler.publishWorker(worker.id);
    c.scheduler.publishAgent(agent.id);
  });
  return 'dispatched';
}
