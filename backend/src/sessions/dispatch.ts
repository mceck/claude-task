import { gitSlug, taskBranch } from '../git/branches';
// The dispatcher: turns the first Queue Entry of an idle Agent into a Job (one at a time).
import { commandName, GIT_PROXY_PATH, MCP_PATH, RUNNER_WS_PATH } from '@claude-task/shared';
import type { JobStartMessage } from '@claude-task/shared';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { transactWithRetry } from '../context';
import { comments, jobs, projectEnvVars, projects, queueEntries, sessions, tasks } from '../db/schema';
import type { Executor } from '../db/client';
import { ACTIVE_JOB_STATES, desiredContainerSpec, getAgentRow } from '../modules/agents/service';
import { credentialEnv } from '../modules/credentials/service';
import { agentExtensions, resolvedMcp } from '../modules/extensions/service';
import type { GitProvider } from '../git/provider';
import { systemComment } from '../runner/handlers';
import { newToken } from '../secrets';
import { REASSIGNED_MESSAGE, RESUME_MESSAGE, renderComments, renderTaskFiles, startMessage, systemPrompt, taskSnapshot } from './messages';
import type { CommentRow, MessageParts } from './messages';

export const runnerWsUrl = (backendUrl: string) => `${backendUrl.replace(/^http/, 'ws')}${RUNNER_WS_PATH}`;
export const gitProxyUrl = (backendUrl: string, projectId: string) => `${backendUrl}${GIT_PROXY_PATH}/${projectId}.git`;

/** Dispatches the next Job for the Agent if it can take one. Returns whether it did. */
export async function dispatchNext(ctx: AppContext, agentId: string): Promise<boolean> {
  // Peek without locks, then lock in the canonical order (task, agent) and re-check.
  const [head] = await nextEntry(ctx.db, agentId);
  if (!head) return false;
  const result = await transactWithRetry(ctx, async (tx, after) => {
    await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, head.taskId)).for('key share');
    const agent = await getAgentRow(tx, agentId, { lock: true });
    const ready =
      agent.enabled &&
      agent.extensionsRevision === agent.configuredExtensionsRevision &&
      ctx.runners.isConnected(agentId) &&
      agent.containerState === 'running' &&
      agent.containerSpec !== null &&
      agent.containerSpec === desiredContainerSpec(agent);
    if (!ready) return 'not_ready' as const;
    const [busy] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.agentId, agentId), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
    if (busy) return 'not_ready' as const;
    const [entry] = await nextEntry(tx, agentId, true);
    if (!entry || entry.id !== head.id) return 'retry' as const;

    const [session] = await tx.select().from(sessions).where(eq(sessions.id, entry.sessionId)).for('update');
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, entry.taskId));
    const [project] = await tx.select().from(projects).where(eq(projects.id, task!.projectId));
    const snapshot = await taskSnapshot(tx, task!.id);
    const repository = project!.repository;
    const branch = repository ? (task!.branchName ?? taskBranch(snapshot.key, snapshot.title)) : null;
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
          c.scheduler.publishQueue(agentId, [task!.id]);
          c.scheduler.publishTask(task!.id);
        });
        return 'retry' as const;
      }
    }
    if (git && repository && branch) {
      await tx
        .update(tasks)
        .set({ branchName: branch, branchUrl: git.branchWebUrl(repository, branch) })
        .where(eq(tasks.id, task!.id));
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
      included = (await conversation(tx, task!.id)).filter((c) => !remaining.has(c.id));
      // `claude` runs the last text block as the input and keeps earlier blocks as context, so a
      // first command (/init, a skill) stays native when the Task context comes before it.
      const command = commandIndex === 0 ? batch[0]! : null;
      const previousAgent = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.taskId, task!.id), ne(sessions.agentId, agentId), eq(sessions.started, true)));
      const seenFiles = new Set<string>();
      const files = await renderTaskFiles(ctx, tx, task!.id, snapshot.description, seenFiles);
      const context = await renderComments(ctx, tx, included.filter((c) => c.id !== command?.id), seenFiles);
      message = startMessage(snapshot, context, { branch, previousAgent: previousAgent.length > 0, files });
      if (command) {
        const input = await renderComments(ctx, tx, [command]);
        message = { blocks: [...message.blocks, ...input.blocks], fetch: [...message.fetch, ...input.fetch] };
      }
      // Notices made while the Session was pending are covered by the snapshot.
      included = [...included, ...batch.filter((c) => !included.some((i) => i.id === c.id))];
    } else {
      included = batch;
      message = await renderComments(ctx, tx, batch);
      if (message.blocks.length === 0) {
        message.blocks.push({ type: 'text', text: entry.kind === 'resume_interrupted' ? RESUME_MESSAGE : REASSIGNED_MESSAGE });
      }
    }

    const credential = await credentialEnv(tx, ctx.config.secrets, agent.credentialId);
    const env: Record<string, string> = { ...(await projectEnv(ctx, tx, project!.id)), ...credential.env };
    const resumeInterrupted = entry.kind === 'resume_interrupted' && !fresh;
    if (resumeInterrupted) env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = '1';

    const jobToken = newToken();
    const [job] = await tx.insert(jobs).values({ sessionId: session!.id, agentId, taskId: task!.id, kind: entry.kind, tokenHash: jobToken.hash }).returning();
    if (remaining.size) await tx.update(queueEntries).set({ kind: 'messages' }).where(eq(queueEntries.id, entry.id));
    else await tx.delete(queueEntries).where(eq(queueEntries.id, entry.id));
    if (included.length > 0) {
      await tx
        .update(comments)
        .set({
          queueEntryId: null,
          deliveredInJobId: job!.id,
          deliveryState: sql`case when ${comments.kind} = 'user' or ${comments.noticeMessage} is not null then 'delivered'::delivery_state else ${comments.deliveryState} end`,
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
    await tx.update(sessions).set({ state: 'running', lastJobAt: new Date(), lastSeenTaskVersion: seen }).where(eq(sessions.id, session!.id));

    const extensions = await agentExtensions(tx, agentId);
    const start: JobStartMessage = {
      type: 'job.start',
      jobId: job!.id,
      sessionId: session!.id,
      mode: fresh ? 'new' : 'resume',
      resumeInterrupted,
      worktreePath: session!.worktreePath,
      git:
        repository && branch
          ? {
              // Agents reach git only through the Git Proxy, with their Job token (ADR 0006).
              cloneUrl: gitProxyUrl(ctx.config.agents.backendUrl, project!.id),
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
        }),
        mcpConfig: JSON.stringify({
          mcpServers: {
            ...resolvedMcp(ctx, extensions.mcpServers),
            'claude-task': {
              type: 'http',
              url: `${ctx.config.agents.backendUrl}${MCP_PATH}`,
              headers: { Authorization: `Bearer ${jobToken.token}` },
            },
          },
        }),
      },
      initialMessage: message.blocks,
      attachmentsToFetch: message.fetch,
    };
    after.effect((c) => {
      c.runners.send(agentId, start);
      c.scheduler.publishQueue(agentId, [task!.id]);
      c.scheduler.publishTask(task!.id);
      c.scheduler.publishComments(included.map((i) => i.id));
      c.scheduler.publishJob(job!.id);
    });
    return 'dispatched' as const;
  });
  if (result === 'retry') return dispatchNext(ctx, agentId);
  return result === 'dispatched';
}

function nextEntry(db: Executor, agentId: string, lock = false) {
  const query = db
    .select()
    .from(queueEntries)
    .where(and(eq(queueEntries.agentId, agentId), eq(queueEntries.held, false)))
    .orderBy(asc(queueEntries.position), asc(queueEntries.id))
    .limit(1);
  return lock ? query.for('update', { skipLocked: true }) : query;
}

/** What a new Session reads first: every non-internal Comment by Users and Agents, oldest first. */
async function conversation(db: Executor, taskId: string): Promise<CommentRow[]> {
  return db
    .select()
    .from(comments)
    .where(
      and(eq(comments.taskId, taskId), eq(comments.internal, false), isNull(comments.deletedAt), or(eq(comments.kind, 'user'), eq(comments.kind, 'agent'))),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

/** Project env vars, secrets decrypted: only ever sent in this Project's Job payloads. */
export async function projectEnv(ctx: AppContext, db: Executor, projectId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, projectId));
  return Object.fromEntries(rows.map((r) => [r.name, r.secret ? ctx.config.secrets.decrypt(r.valueCiphertext!) : (r.value ?? '')]));
}
