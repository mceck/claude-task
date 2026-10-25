import { projectTopic, taskTopic, taskKey } from '@claude-task/shared';
import type { Actor, PullRequest, RepositorySettings } from '@claude-task/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AfterCommit, AppContext } from '../context';
import { transact } from '../context';
import type { Executor } from '../db/client';
import { comments, jobs, projects, sessions, taskRevisions, tasks } from '../db/schema';
import { badRequest, conflict } from '../errors';
import { getProject, serializeProject } from '../modules/projects/service';
import { emitTasksChanged, getTaskRow } from '../modules/tasks/service';
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

export async function linkRepository(ctx: AppContext, projectId: string, body: { providerRepoId: string; baseBranch?: string }): Promise<void> {
  const available = await ctx.git.listAccessibleRepositories();
  const ref = available.find((r) => r.providerRepoId === body.providerRepoId);
  if (!ref) throw badRequest('Choose a repository accessible to the GitHub App');
  const repo = await ctx.git.getRepository(ref);
  const baseBranch = body.baseBranch ?? repo.defaultBranch;
  if (!(await ctx.git.branchExists(repo, baseBranch))) throw badRequest(`The base branch "${baseBranch}" does not exist in this repository`);
  const protection = await ctx.git.checkBaseBranchProtection(repo, baseBranch);
  await transact(ctx, async (tx, after) => {
    const p = await getProject(tx, projectId, { lock: true });
    const changed = p.repository?.providerRepoId !== repo.providerRepoId;
    if (changed && (await repositorySettings(tx, p.id)).hasOpenSessions)
      throw conflict('Unassigning only pauses sessions. Close every non-closed session before changing the repository.');
    const [updated] = await tx
      .update(projects)
      .set({ repository: { ...repo, baseBranch, protection }, updatedAt: new Date() })
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
  const repository = { ...p.repository, protection: await ctx.git.checkBaseBranchProtection(p.repository, p.repository.baseBranch) };
  await transact(ctx, async (tx, after) => {
    const current = await getProject(tx, p.id, { lock: true });
    if (current.repository?.providerRepoId !== repository.providerRepoId || current.repository.baseBranch !== repository.baseBranch) return;
    const [updated] = await tx.update(projects).set({ repository }).where(eq(projects.id, p.id)).returning();
    after.emit(projectTopic(p.id), { type: 'project.updated', project: serializeProject(updated!) });
  });
}

export async function recordPullRequest(tx: Executor, after: AfterCommit, task: TaskRow, pullRequest: PullRequest, actor: Actor): Promise<void> {
  const before = task.pullRequest;
  const changed = !before || ['number', 'url', 'state', 'draft'].some((key) => before[key as keyof PullRequest] !== pullRequest[key as keyof PullRequest]);
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
    const task = await getTaskRow(tx, scope.taskId, { lock: true });
    const [job] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, scope.jobId), eq(jobs.agentId, scope.agentId), inArray(jobs.state, ['running', 'finishing'])));
    if (!job) throw conflict('The job is no longer active');
    if (!p.repository || !task.branchName) throw conflict('This task has no repository and task branch yet');
    if (!(await ctx.git.branchExists(p.repository, task.branchName))) throw badRequest(`Push the branch \`${task.branchName}\` before opening a pull request.`);
    const key = taskKey(p.key, task.number);
    const taskUrl = `${ctx.config.webUrl ?? 'http://localhost:3000'}/t/${key}`;
    const body = `${input.body.trim()}\n\n---\nTask: [${key}](${taskUrl}) · Agent: ${scope.actor.displayName.replace(/[\r\n]/g, ' ')}`;
    const pr = {
      ...(await ctx.git.upsertPullRequest(p.repository, {
        head: task.branchName,
        base: p.repository.baseBranch,
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
        taskId: task.id,
        kind: 'system',
        authorType: 'system',
        body: `Pull request [#${pr.number}](${pr.url}) ${task.pullRequest?.number === pr.number ? 'updated' : 'opened'}.`,
        createdAt: sql`clock_timestamp()`,
      })
      .returning();
    after.effect((c) => c.scheduler.publishComments([notice!.id], 'created'));
    return { number: pr.number, url: pr.url, state: pr.state, draft: pr.draft };
  });
}

/** Only the Agent's accepted active Job may request its own repository token. */
export async function repositoryToken(ctx: AppContext, agentId: string, jobId: string, repository: string) {
  const active = async () =>
    (
      await ctx.db
        .select({ repository: projects.repository })
        .from(jobs)
        .innerJoin(tasks, eq(tasks.id, jobs.taskId))
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(eq(jobs.id, jobId), eq(jobs.agentId, agentId), inArray(jobs.state, ['running', 'finishing'])))
    )[0]?.repository;
  const repo = await active();
  if (!repo || repository.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) throw conflict('No active task for this repository');
  const token = await ctx.git.issueRepositoryToken(repo);
  if ((await active())?.providerRepoId !== repo.providerRepoId) throw conflict('No active task for this repository');
  return token;
}
