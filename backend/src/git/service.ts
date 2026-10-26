import { projectTopic, pullRequestNoun, pullRequestRef, taskTopic, taskKey } from '@claude-task/shared';
import type { Actor, PullRequest, RepositoryBody, RepositorySettings } from '@claude-task/shared';
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

export async function linkRepository(ctx: AppContext, projectId: string, body: RepositoryBody): Promise<void> {
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
  await transact(ctx, async (tx, after) => {
    const p = await getProject(tx, projectId, { lock: true });
    const changed = p.repository?.connectionId !== repo.connectionId || p.repository?.providerRepoId !== repo.providerRepoId;
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
    const task = await getTaskRow(tx, scope.taskId, { lock: true });
    const [job] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, scope.jobId), eq(jobs.agentId, scope.agentId), inArray(jobs.state, ['running', 'finishing'])));
    if (!job) throw conflict('The job is no longer active');
    if (!p.repository || !task.branchName) throw conflict('This task has no repository and task branch yet');
    const git = await ctx.git.provider(p.repository.connectionId);
    if (!(await git.branchExists(p.repository, task.branchName))) throw badRequest(`Push the branch \`${task.branchName}\` before opening a pull request.`);
    const key = taskKey(p.key, task.number);
    const taskUrl = `${ctx.config.webUrl ?? 'http://localhost:3000'}/t/${key}`;
    const body = `${input.body.trim()}\n\n---\nTask: [${key}](${taskUrl}) · Agent: ${scope.actor.displayName.replace(/[\r\n]/g, ' ')}`;
    const pr = {
      ...(await git.upsertPullRequest(p.repository, {
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
        body: `${capitalize(pullRequestNoun(pr.provider))} [${pullRequestRef(pr)}](${pr.url}) ${task.pullRequest?.number === pr.number && task.pullRequest.provider === pr.provider ? 'updated' : 'opened'}.`,
        createdAt: sql`clock_timestamp()`,
      })
      .returning();
    after.effect((c) => c.scheduler.publishComments([notice!.id], 'created'));
    return { number: pr.number, url: pr.url, state: pr.state, draft: pr.draft };
  });
}

const capitalize = (text: string) => text[0]!.toUpperCase() + text.slice(1);
