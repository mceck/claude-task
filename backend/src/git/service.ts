import { projectTopic, pullRequestNoun, pullRequestRef, taskTopic, taskKey } from '@claude-task/shared';
import type { Actor, PullRequest, RepositoryBody, RepositorySettings } from '@claude-task/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AfterCommit, AppContext } from '../context';
import { transact } from '../context';
import type { Executor } from '../db/client';
import { comments, jobs, projects, sessions, taskRevisions, tasks } from '../db/schema';
import { badRequest, conflict } from '../errors';
import { GitProviderError } from './provider';
import { gitOwnerTask } from './owner';
import { getProject, serializeProject } from '../modules/projects/service';
import { advanceTaskStatus, emitTasksChanged, getTaskRow } from '../modules/tasks/service';
import type { TaskRow } from '../modules/tasks/service';

export async function repositorySettings(db: Executor, projectId: string): Promise<RepositorySettings> {
  const p = await getProject(db, projectId);
  const [open] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(tasks, eq(tasks.id, sessions.taskId))
    .where(and(eq(tasks.projectId, p.id), ne(sessions.state, 'closed')))
    .limit(1);
  return { repository: p.repository, hasOpenSessions: !!open };
}

export async function resolveRepository(ctx: AppContext, body: RepositoryBody) {
  const connection = await ctx.git.find(body.connectionId);
  if (!connection) throw badRequest('Choose a repository of an existing Git Connection');
  const git = ctx.git.providerFor(connection);
  const available = await git.listAccessibleRepositories();
  const ref = available.find((r) => r.providerRepoId === body.providerRepoId);
  if (!ref) throw badRequest('Choose a repository accessible to this Git Connection');
  const repo = await git.getRepository(ref);
  const baseBranch = body.baseBranch ?? repo.defaultBranch;
  if (!(await git.branchExists(repo, baseBranch))) throw badRequest(`The base branch "${baseBranch}" does not exist in this repository`);
  const protection = await git.checkBaseBranchProtection(repo, baseBranch);
  return { ...repo, baseBranch, protection };
}

export async function linkRepository(ctx: AppContext, projectId: string, body: RepositoryBody): Promise<void> {
  const repository = await resolveRepository(ctx, body);
  const { connectionId } = repository;
  await transact(ctx, async (tx, after) => {
    // The connection's lock orders this against its deletion, which must see the link (or vice versa).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-connection:${connectionId}`}))`);
    if (!(await ctx.git.find(connectionId, tx))) throw badRequest('Choose a repository of an existing Git Connection');
    const p = await getProject(tx, projectId, { lock: true });
    const changed = p.repository?.connectionId !== repository.connectionId || p.repository?.providerRepoId !== repository.providerRepoId;
    if (changed && (await repositorySettings(tx, p.id)).hasOpenSessions)
      throw conflict('Unassigning only pauses sessions. Close every non-closed session before changing the repository.');
    const [updated] = await tx
      .update(projects)
      .set({ repository, updatedAt: new Date() })
      .where(eq(projects.id, p.id))
      .returning();
    // A PR belongs to its repository, while the Task Branch name stays stable.
    if (changed) {
      const affected = await tx.update(tasks).set({ pullRequest: null, branchUrl: null }).where(eq(tasks.projectId, p.id)).returning({ id: tasks.id });
      await emitTasksChanged(
        tx,
        after,
        affected.map((t) => t.id),
        'task.updated',
      );
    }
    after.emit(projectTopic(p.id), { type: 'project.updated', project: serializeProject(updated!) });
  });
}

export async function recheckProtection(ctx: AppContext, projectId: string): Promise<void> {
  const p = await getProject(ctx.db, projectId);
  if (!p.repository) throw conflict('Link a repository first');
  const git = await ctx.git.provider(p.repository.connectionId);
  const repository = { ...p.repository, protection: await git.checkBaseBranchProtection(p.repository, p.repository.baseBranch) };
  await transact(ctx, async (tx, after) => {
    const current = await getProject(tx, p.id, { lock: true });
    if (
      current.repository?.connectionId !== repository.connectionId ||
      current.repository.providerRepoId !== repository.providerRepoId ||
      current.repository.baseBranch !== repository.baseBranch
    )
      return;
    const [updated] = await tx.update(projects).set({ repository }).where(eq(projects.id, p.id)).returning();
    after.emit(projectTopic(p.id), { type: 'project.updated', project: serializeProject(updated!) });
  });
}

export async function recordPullRequest(tx: Executor, after: AfterCommit, task: TaskRow, pullRequest: PullRequest, actor: Actor): Promise<void> {
  const before = task.pullRequest;
  const changed = !before || ['provider', 'number', 'url', 'state', 'draft'].some((key) => before[key as keyof PullRequest] !== pullRequest[key as keyof PullRequest]);
  await tx
    .update(tasks)
    .set({ pullRequest, ...(changed ? { version: task.version + 1, updatedAt: new Date() } : {}) })
    .where(eq(tasks.id, task.id));
  if (!changed) return;
  const [revision] = await tx
    .insert(taskRevisions)
    .values({
      taskId: task.id,
      version: task.version + 1,
      actorType: actor.type,
      actorId: actor.id,
      changes: [{ field: 'pullRequest', before, after: pullRequest }],
    })
    .returning();
  after.emit(taskTopic(task.id), {
    type: 'revision.created',
    revision: { id: revision!.id, taskId: task.id, version: task.version + 1, actor, changes: revision!.changes, createdAt: revision!.createdAt.toISOString() },
  });
  await emitTasksChanged(tx, after, [task.id], 'task.updated');
}

export async function openPullRequest(
  ctx: AppContext,
  scope: { taskId: string; jobId: string; agentId: string; actor: Actor },
  input: { title: string; body: string; draft?: boolean },
) {
  return transact(ctx, async (tx, after) => {
    const peek = await getTaskRow(tx, scope.taskId);
    const p = await getProject(tx, peek.projectId);
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, p.id)).for('share');
    // The Base Branch may have changed while the share lock was waited for.
    const project = await getProject(tx, p.id);
    const jobTask = await getTaskRow(tx, scope.taskId, { lock: true });
    // A Wiki's Chats share the branch and the pull request of the Wiki's first Task.
    const ownerId = (await gitOwnerTask(tx, jobTask)).id;
    const task = ownerId === jobTask.id ? jobTask : await getTaskRow(tx, ownerId, { lock: true });
    const [job] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
      .where(
        and(
          eq(jobs.id, scope.jobId),
          eq(jobs.agentId, scope.agentId),
          inArray(jobs.state, ['running', 'finishing']),
          eq(jobs.cancelRequested, false),
          eq(sessions.state, 'running'),
        ),
      );
    if (!job) throw conflict('The job is no longer active');
    if (!project.repository || !task.branchName) throw conflict('This task has no repository and task branch yet');
    const git = await ctx.git.provider(project.repository.connectionId);
    if (!(await git.branchExists(project.repository, task.branchName))) throw badRequest(`Push the branch \`${task.branchName}\` before opening a pull request.`);
    const key = taskKey(project.key, task.number);
    const taskUrl = `${ctx.config.webUrl ?? 'http://localhost:3000'}/t/${key}`;
    const body = `${input.body.trim()}\n\n---\nTask: [${key}](${taskUrl}) · Agent: ${scope.actor.displayName.replace(/[\r\n]/g, ' ')}`;
    const pr = {
      ...(await git.upsertPullRequest(project.repository, {
        head: task.branchName,
        base: project.repository.baseBranch,
        title: input.title,
        body,
        draft: input.draft ?? false,
      })),
      checkedAt: new Date().toISOString(),
    };
    await recordPullRequest(tx, after, task, pr, scope.actor);
    const [notice] = await tx
      .insert(comments)
      .values({
        taskId: jobTask.id,
        kind: 'system',
        authorType: 'system',
        body: `${capitalize(pullRequestNoun(pr.provider))} [${pullRequestRef(pr)}](${pr.url}) ${task.pullRequest?.number === pr.number && task.pullRequest.provider === pr.provider ? 'updated' : 'opened'}.`,
        createdAt: sql`clock_timestamp()`,
      })
      .returning();
    after.effect((c) => c.scheduler.publishComments([notice!.id], 'created'));
    return { number: pr.number, url: pr.url, state: pr.state, draft: pr.draft };
  });
}

/** A human merges the Task's open Pull Request from the Task view. The merge uses the provider's default method and its own rules. */
export async function mergePullRequest(ctx: AppContext, taskId: string, actor: Actor): Promise<void> {
  const task = await getTaskRow(ctx.db, taskId);
  const p = await getProject(ctx.db, task.projectId);
  const current = task.pullRequest;
  if (!p.repository || !current) throw conflict('This task has no pull request');
  const noun = pullRequestNoun(current.provider);
  if (current.state !== 'open') throw conflict(`This ${noun} is ${current.state}, not open`);
  if (current.draft) throw conflict(`This ${noun} is a draft. Mark it ready first`);
  const git = await ctx.git.provider(p.repository.connectionId);
  let merged: Omit<PullRequest, 'checkedAt'>;
  try {
    merged = await git.mergePullRequest(p.repository, current.number);
  } catch (err) {
    if (err instanceof GitProviderError && [405, 406, 409, 422].includes(err.status))
      throw conflict(`The provider refused to merge this ${noun}: it may have conflicts, failing checks or missing approvals.`);
    throw err;
  }
  const pr = { ...merged, checkedAt: new Date().toISOString() };
  await transact(ctx, async (tx, after) => {
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, p.id)).for('share');
    const locked = await getTaskRow(tx, taskId, { lock: true });
    const project = await getProject(tx, p.id);
    // The merge already happened on the provider: only skip recording when the Task no longer points to this Pull Request.
    if (
      project.repository?.connectionId !== p.repository?.connectionId ||
      project.repository?.providerRepoId !== p.repository?.providerRepoId ||
      locked.pullRequest?.number !== pr.number
    )
      return;
    await recordPullRequest(tx, after, locked, pr, actor);
    if (pr.state !== 'merged') return;
    const [notice] = await tx
      .insert(comments)
      .values({
        taskId,
        kind: 'system',
        authorType: 'system',
        body: `${capitalize(pullRequestNoun(pr.provider))} [${pullRequestRef(pr)}](${pr.url}) merged by ${actor.displayName}.`,
        createdAt: sql`clock_timestamp()`,
      })
      .returning();
    after.effect((c) => c.scheduler.publishComments([notice!.id], 'created'));
    await advanceTaskStatus(tx, after, taskId, actor);
  });
}

const capitalize = (text: string) => text[0]!.toUpperCase() + text.slice(1);
