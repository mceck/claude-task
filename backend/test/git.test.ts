import { sql } from 'drizzle-orm';
import { generateKeyPairSync } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { taskTopic, projectTopic } from '@claude-task/shared';
import { describe, expect, it, vi } from 'vitest';
import { useTestApp } from './helpers/app';
import { assignAgent, assignAndStart, createAgent, createProject, createTask, createUser, getSession, moveToStatus, statusByName, timeline } from './helpers/fixtures';
import { Stream } from './helpers/stream';
import { WsTestClient } from './helpers/ws';
import { FakeGitProvider } from '../src/git/fake-provider';
import { REPOSITORY_LIST_CACHE_MS } from '../src/git/connections';
import { GitProviderError } from '../src/git/provider';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

describe('Git integration through the public API', () => {
  const app = useTestApp();
  async function setup() {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    expect((await admin.put(`/projects/${bundle.project.id}/repository`, { connectionId: 'env-github', providerRepoId: '1' })).status).toBe(200);
    const { agent, runner } = await createAgent(app, admin, { name: 'Adà Developer' });
    const task = await createTask(admin, bundle.project.id, { title: 'Fix café login / redirect!' });
    return { admin, bundle, agent, runner, task };
  }
  async function running() {
    const s = await setup();
    await assignAndStart(s.admin, s.task.id, s.agent.id);
    const start = await s.runner.next('job.start');
    s.runner.accept(start.jobId);
    await s.runner.play(start.jobId, [new Stream(start.sessionId).init()]);
    return { ...s, start };
  }
  async function clientFor(start: Awaited<ReturnType<typeof running>>['start']) {
    const config = JSON.parse(start.claudeArgs.mcpConfig).mcpServers['claude-task'];
    const client = new Client({ name: 'git-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/api/v1/mcp`), { requestInit: { headers: config.headers } }));
    return client;
  }
  async function callPR(client: Client, body = 'Fixes the login.', draft = false) {
    const result = await client.callTool({ name: 'open_pull_request', arguments: { title: 'Fix login', body, draft } });
    return { error: result.isError === true, text: (result.content as { text: string }[])[0]!.text };
  }

  it('manages Git Connections as admins only, with write-only secrets and read-only environment connections', async () => {
    const admin = await app.admin();
    const member = (await createUser(app, admin)).client;
    expect((await member.get('/git/connections')).status).toBe(403);
    expect((await member.post('/git/connections', { provider: 'gitlab', name: 'GitLab', token: 'glpat-secret' })).status).toBe(403);
    expect((await admin.post('/git/connections', { provider: 'github', name: 'Bad', appId: '123', privateKey: 'invalid key' })).status).toBe(400);
    const github = await admin.post('/git/connections', { provider: 'github', name: 'Acme App', appId: '123', privateKey });
    expect(github.status).toBe(201);
    expect(github.body.connection).toMatchObject({ provider: 'github', name: 'Acme App', host: 'github.com', source: 'database', appId: '123', secretLast4: null });
    const gitlab = await admin.post('/git/connections', { provider: 'gitlab', name: 'Self-managed', baseUrl: 'https://gitlab.example.com/', token: 'glpat-supersecret-9876' });
    expect(gitlab.body.connection).toMatchObject({
      provider: 'gitlab',
      host: 'gitlab.example.com',
      baseUrl: 'https://gitlab.example.com',
      secretLast4: '9876',
      access: [{ label: 'claude-task-bot' }],
      health: { state: 'ok' },
    });
    expect(gitlab.body.connection.expiresAt).toBeTruthy();
    const listed = (await admin.get('/git/connections')).body.connections;
    expect(listed.map((c: { id: string }) => c.id)).toEqual(['env-github', github.body.connection.id, gitlab.body.connection.id]);
    expect(listed[0]).toMatchObject({ source: 'environment', appId: '1' });
    const raw = JSON.stringify(listed);
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('supersecret');
    expect((await admin.patch('/git/connections/env-github', { name: 'Renamed' })).status).toBe(409);
    expect((await admin.delete('/git/connections/env-github')).status).toBe(409);
    expect((await admin.patch(`/git/connections/${gitlab.body.connection.id}`, { name: 'GitLab EU' })).body.connection).toMatchObject({ name: 'GitLab EU', secretLast4: '9876' });
    expect((await admin.patch(`/git/connections/${gitlab.body.connection.id}`, { token: 'glpat-rotated-1111' })).body.connection.secretLast4).toBe('1111');
    expect((await admin.patch(`/git/connections/${github.body.connection.id}`, { token: 'nope' })).status).toBe(400);
    expect((await admin.post('/git/connections', { provider: 'gitlab', name: 'Plain', baseUrl: 'ftp://gitlab.example.com', token: 't' })).status).toBe(400);
    app.gitlab.invalid = 'The GitLab token needs the write_repository scope';
    const refused = await admin.post('/git/connections', { provider: 'gitlab', name: 'Weak', token: 'glpat-weak' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('write_repository');
    expect((await admin.get('/git/connections')).body.connections.find((c: { id: string }) => c.id === gitlab.body.connection.id).health).toMatchObject({
      state: 'error',
      message: expect.stringContaining('write_repository'),
    });
    expect((await admin.delete(`/git/connections/${github.body.connection.id}`)).status).toBe(204);
    expect((await admin.get('/git/connections')).body.connections).toHaveLength(2);
  });

  it('lists repositories grouped by connection, and a broken connection does not hide the others', async () => {
    const admin = await app.admin();
    const member = (await createUser(app, admin)).client;
    const gitlab = (await admin.post('/git/connections', { provider: 'gitlab', name: 'GitLab', token: 'glpat-x' })).body.connection;
    let groups = (await member.get('/git/repositories')).body.groups;
    expect(groups.map((g: { connection: { id: string } }) => g.connection.id)).toEqual(['env-github', gitlab.id]);
    expect(groups[1].repositories.map((r: { owner: string; name: string; connectionId: string }) => [r.owner, r.name, r.connectionId])).toContainEqual([
      'acme/platform',
      'service',
      gitlab.id,
    ]);
    app.git.unreachable = 'GitHub could not be reached. Try again later.';
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + REPOSITORY_LIST_CACHE_MS + 1);
    groups = (await member.get('/git/repositories')).body.groups;
    expect(groups[0]).toMatchObject({ repositories: [], error: 'GitHub could not be reached. Try again later.' });
    expect(groups[1].repositories).toHaveLength(2);
    clock.mockRestore();
  });

  it('shares concurrent Repository list requests, caches successes for 60 seconds and validates saves freshly', async () => {
    const admin = await app.admin();
    const list = vi.spyOn(app.git, 'listAccessibleRepositories');
    const snapshots = await Promise.all([admin.get('/git/repositories'), admin.get('/git/repositories')]);
    expect(snapshots.every((r) => r.status === 200)).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    app.git.addRepository('3', 'acme', 'new-repository');
    expect((await admin.get('/git/repositories')).body.groups[0].repositories).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(1);
    const result = await admin.post('/projects', {
      key: 'FRESH', name: 'Fresh Repository', repository: { connectionId: 'env-github', providerRepoId: '3' },
    });
    expect(result.status).toBe(201);
    expect(result.body.project.repository.name).toBe('new-repository');
    expect(list).toHaveBeenCalledTimes(2);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + REPOSITORY_LIST_CACHE_MS + 1);
    try {
      expect((await admin.get('/git/repositories')).body.groups[0].repositories).toHaveLength(3);
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
      list.mockRestore();
    }
  });

  it('invalidates cached Repository lists on connection updates and removes deleted connections', async () => {
    const admin = await app.admin();
    const connection = (await admin.post('/git/connections', { provider: 'gitlab', name: 'Cache test', token: 'glpat-cache' })).body.connection;
    const githubList = vi.spyOn(app.git, 'listAccessibleRepositories');
    const gitlabList = vi.spyOn(app.gitlab, 'listAccessibleRepositories');
    await admin.get('/git/repositories');
    await admin.get('/git/repositories');
    expect(githubList).toHaveBeenCalledTimes(1);
    expect(gitlabList).toHaveBeenCalledTimes(1);
    app.gitlab.addRepository('103', 'acme', 'new-repository');
    await admin.patch(`/git/connections/${connection.id}`, { token: 'glpat-updated' });
    const groups = (await admin.get('/git/repositories')).body.groups;
    expect(groups.find((g: { connection: { id: string } }) => g.connection.id === connection.id).repositories).toHaveLength(3);
    expect(githubList).toHaveBeenCalledTimes(1);
    expect(gitlabList).toHaveBeenCalledTimes(2);
    expect((await admin.delete(`/git/connections/${connection.id}`)).status).toBe(204);
    expect((await admin.get('/git/repositories')).body.groups).toHaveLength(1);
    githubList.mockRestore();
    gitlabList.mockRestore();
  });

  it('retries failed Repository lists immediately while keeping healthy connections cached', async () => {
    const admin = await app.admin();
    await admin.post('/git/connections', { provider: 'gitlab', name: 'Healthy', token: 'glpat-cache' });
    app.git.unreachable = 'Temporarily unavailable';
    const groups = (await admin.get('/git/repositories')).body.groups;
    expect(groups[0].error).toBe('Temporarily unavailable');
    expect(groups[1].repositories).toHaveLength(2);
    const gitlabList = vi.spyOn(app.gitlab, 'listAccessibleRepositories');
    app.git.unreachable = null;
    const recovered = (await admin.get('/git/repositories')).body.groups;
    expect(recovered[0].error).toBeNull();
    expect(recovered[0].repositories).toHaveLength(2);
    expect(gitlabList).not.toHaveBeenCalled();
    gitlabList.mockRestore();
  });

  it('links GitLab repositories in nested groups and opens merge requests with GitLab vocabulary', async () => {
    const admin = await app.admin();
    const gitlab = (await admin.post('/git/connections', { provider: 'gitlab', name: 'GitLab', token: 'glpat-x' })).body.connection;
    const bundle = await createProject(admin);
    const linked = await admin.put(`/projects/${bundle.project.id}/repository`, { connectionId: gitlab.id, providerRepoId: '101' });
    expect(linked.body.repository).toMatchObject({ connectionId: gitlab.id, provider: 'gitlab', owner: 'acme/platform', name: 'service', baseBranch: 'main' });
    expect((await admin.delete(`/git/connections/${gitlab.id}`)).status).toBe(409);
    const { agent, runner } = await createAgent(app, admin);
    const task = await createTask(admin, bundle.project.id, { title: 'Ship it' });
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    expect(start.git).toMatchObject({ repositoryId: `${gitlab.id}/101`, cloneUrl: `http://backend.test/git/${bundle.project.id}.git` });
    runner.accept(start.jobId);
    await runner.play(start.jobId, [new Stream(start.sessionId).init()]);
    expect((await admin.get(`/tasks/${task.id}`)).body.task.branchUrl).toContain(`/acme/platform/service/-/tree/${start.git!.taskBranch}`);
    app.gitlab.branches.get('101')!.add(start.git!.taskBranch);
    const client = await clientFor(start);
    const mr = JSON.parse((await callPR(client, 'Body', true)).text);
    expect(mr).toMatchObject({ number: 1, draft: true });
    expect((await admin.get(`/tasks/${task.id}`)).body.task.pullRequest).toMatchObject({ provider: 'gitlab', number: 1 });
    expect((await timeline(admin, task.id)).some((i) => i.type === 'comment' && i.comment.body.startsWith('Merge request [!1]'))).toBe(true);
    await client.close();
  });

  it('never links a repository of a Git Connection deleted meanwhile', async () => {
    const admin = await app.admin();
    const gitlab = (await admin.post('/git/connections', { provider: 'gitlab', name: 'GitLab', token: 'glpat-x' })).body.connection;
    const bundle = await createProject(admin);
    let linked!: Promise<{ status: number }>;
    // The deletion holds the connection's lock while the link runs its provider checks.
    await app.server.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-connection:${gitlab.id}`}))`);
      linked = admin.put(`/projects/${bundle.project.id}/repository`, { connectionId: gitlab.id, providerRepoId: '101' });
      await new Promise((r) => setTimeout(r, 300));
      await tx.execute(sql`delete from git_connections where id = ${gitlab.id}::uuid`);
    });
    expect((await linked).status).toBe(400);
    expect((await admin.get(`/projects/${bundle.project.id}/repository`)).body.repository).toBeNull();
  });

  it('links accessible repositories as a member, defaults and validates the base branch, and rechecks protection', async () => {
    const admin = await app.admin();
    const member = (await createUser(app, admin)).client;
    const { project } = await createProject(admin);
    expect((await member.put(`/projects/${project.id}/repository`, { connectionId: 'env-github', providerRepoId: '999' })).status).toBe(400);
    expect((await member.put(`/projects/${project.id}/repository`, { connectionId: 'missing', providerRepoId: '1' })).status).toBe(400);
    expect((await member.put(`/projects/${project.id}/repository`, { connectionId: 'env-github', providerRepoId: '1', baseBranch: 'missing' })).status).toBe(400);
    app.git.protection.set('1', false);
    const linked = await member.put(`/projects/${project.id}/repository`, { connectionId: 'env-github', providerRepoId: '1' });
    expect(linked.body.repository).toMatchObject({ owner: 'acme', name: 'example', baseBranch: 'main', protection: { protected: false } });
    expect((await member.get(`/projects/${project.id}`)).body.project.repository.baseBranch).toBe('main');
    app.git.protection.set('1', true);
    expect((await member.post(`/projects/${project.id}/repository/check-protection`)).body.repository.protection.protected).toBe(true);
    app.git.branches.get('1')!.add('develop');
    expect((await member.put(`/projects/${project.id}/repository`, { connectionId: 'env-github', providerRepoId: '1', baseBranch: 'develop' })).body.repository.baseBranch).toBe('develop');
  });

  it('blocks repository changes for non-closed sessions, including paused ones; allows changes after close', async () => {
    const { admin, bundle, agent, runner, task } = await setup();
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    expect((await admin.put(`/projects/${bundle.project.id}/repository`, { connectionId: 'env-github', providerRepoId: '2' })).status).toBe(409);
    const gitlab = (await admin.post('/git/connections', { provider: 'gitlab', name: 'GitLab', token: 'glpat-x' })).body.connection;
    // Same provider repository id, another connection: still a different Repository.
    app.gitlab.addRepository('1', 'acme', 'example');
    expect((await admin.put(`/projects/${bundle.project.id}/repository`, { connectionId: gitlab.id, providerRepoId: '1' })).status).toBe(409);
    await assignAgent(admin, task.id, null);
    await runner.exit(start.jobId);
    expect((await admin.get(`/projects/${bundle.project.id}/repository`)).body.hasOpenSessions).toBe(true);
    expect((await admin.put(`/projects/${bundle.project.id}/repository`, { connectionId: 'env-github', providerRepoId: '2' })).status).toBe(409);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    expect((await admin.put(`/projects/${bundle.project.id}/repository`, { connectionId: 'env-github', providerRepoId: '2' })).status).toBe(200);
  });

  it('dispatches stable ASCII task branches and worktree/commit configuration, preserving names across renames and reassignment', async () => {
    const { admin, bundle, agent, runner, task, start } = await running();
    const branch = `task/${task.key.toLowerCase()}-fix-cafe-login-redirect`;
    expect(start.git).toMatchObject({
      cloneUrl: `http://backend.test/git/${bundle.project.id}.git`,
      repositoryId: 'env-github/1',
      baseBranch: 'main',
      taskBranch: branch,
      branchExists: false,
      repoPath: `repos/${bundle.project.id}.git`,
      commitName: 'Adà Developer (claude-task)',
      commitEmail: 'ada-developer@agents.test',
    });
    expect(start.claudeArgs.appendSystemPrompt).toContain(branch);
    expect(start.claudeArgs.appendSystemPrompt).toContain('open_pull_request');
    const current = (await admin.get(`/tasks/${task.id}`)).body.task;
    expect(current.branchName).toBe(branch);
    expect(current.branchUrl).toContain(`/tree/${branch}`);
    await admin.patch(`/tasks/${task.id}`, { version: current.version, title: 'Entirely different title' });
    await runner.play(start.jobId, [new Stream().result()]);
    await runner.exit(start.jobId);
    const other = await createAgent(app, admin);
    app.git.branches.get('1')!.add(branch);
    await assignAndStart(admin, task.id, other.agent.id);
    const reassigned = await other.runner.next('job.start');
    expect(reassigned.git).toMatchObject({ taskBranch: branch, branchExists: true });
    expect(reassigned.worktreePath).toBe(start.worktreePath);
  });

  it.each([
    { title: '!!! 🐛 !!!', suffix: '' },
    { title: 'a'.repeat(80), suffix: '-' + 'a'.repeat(40) },
    { title: 'Привет мир', suffix: '-privet-mir' },
  ])('names branches for title $title', async ({ title, suffix }) => {
    const { admin, agent, runner, task } = await setup();
    const current = (await admin.get(`/tasks/${task.id}`)).body.task;
    await admin.patch(`/tasks/${task.id}`, { version: current.version, title });
    await assignAndStart(admin, task.id, agent.id);
    expect((await runner.next('job.start')).git!.taskBranch).toBe(`task/${task.key.toLowerCase()}${suffix}`);
  });

  it('opens and updates PRs through MCP, adds the task footer, records the agent Revision, and creates a new PR after closure', async () => {
    const { admin, task, agent, start } = await running();
    const client = await clientFor(start);
    const missing = await callPR(client);
    expect(missing.error).toBe(true);
    expect(missing.text).toContain('Push the branch');
    app.git.branches.get('1')!.add(start.git!.taskBranch);
    const first = await callPR(client, 'Initial body', true);
    expect(first.error).toBe(false);
    const pr = JSON.parse(first.text);
    expect(pr).toMatchObject({ number: 1, draft: true });
    expect((await admin.get(`/tasks/${task.id}`)).body.task.pullRequest).toMatchObject(pr);
    const remote = app.git.pullRequests.get('1')![0]!;
    expect(remote.input.body).toContain(`/t/${task.key}`);
    expect(remote.input.body).toContain('Adà Developer');
    expect(
      (await timeline(admin, task.id)).some((i) => i.type === 'revision' && i.revision.actor.id === agent.id && i.revision.changes[0]?.field === 'pullRequest'),
    ).toBe(true);
    expect((await timeline(admin, task.id)).some((i) => i.type === 'comment' && i.comment.body.includes('Pull request [#1]'))).toBe(true);
    expect(JSON.parse((await callPR(client, 'Updated body')).text).number).toBe(1);
    expect(remote.input.body).toContain('Updated body');
    remote.state = 'closed';
    expect(JSON.parse((await callPR(client)).text).number).toBe(2);
    await client.close();
  });

  it('merges the open PR from the task with one call, refuses drafts and provider refusals, and records who merged', async () => {
    const { admin, task, start } = await running();
    app.git.branches.get('1')!.add(start.git!.taskBranch);
    const client = await clientFor(start);
    expect((await admin.post(`/tasks/${task.id}/pull-request/merge`, {})).status).toBe(409);
    await callPR(client, 'Draft work', true);
    expect((await admin.post(`/tasks/${task.id}/pull-request/merge`, {})).status).toBe(409);
    const remote = app.git.pullRequests.get('1')![0]!;
    remote.draft = false;
    await app.server.ctx.gitSync.refreshTask(task.id, 0);
    app.git.mergeRefusal = 'conflicts';
    const refused = await admin.post(`/tasks/${task.id}/pull-request/merge`, {});
    expect(refused.status).toBe(409);
    expect(remote.state).toBe('open');
    app.git.mergeRefusal = null;
    const merged = await admin.post(`/tasks/${task.id}/pull-request/merge`, {});
    expect(merged.status).toBe(200);
    expect(merged.body.task.pullRequest).toMatchObject({ number: 1, state: 'merged' });
    expect(remote.state).toBe('merged');
    const items = await timeline(admin, task.id);
    expect(items.some((i) => i.type === 'revision' && i.revision.actor.type === 'user' && i.revision.changes[0]?.field === 'pullRequest')).toBe(true);
    expect(items.some((i) => i.type === 'comment' && i.comment.body.includes('merged by'))).toBe(true);
    expect((await admin.post(`/tasks/${task.id}/pull-request/merge`, {})).status).toBe(409);
    // A merged PR frees the slot: the next open_pull_request creates a new one.
    expect(JSON.parse((await callPR(client)).text).number).toBe(2);
    await client.close();
  });

  it('refreshes PR state on opening a task and broadcasts card changes without moving status or ending the session', async () => {
    const { admin, bundle, runner, task, start } = await running();
    app.git.branches.get('1')!.add(start.git!.taskBranch);
    const client = await clientFor(start);
    await callPR(client);
    const socket = await WsTestClient.connect(app.url, admin.cookie);
    await socket.subscribe(projectTopic(bundle.project.id));
    app.git.pullRequests.get('1')![0]!.state = 'merged';
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60000 + 1);
    try {
      const updated = (await admin.get(`/tasks/${task.id}`)).body.task;
      expect(updated.pullRequest.state).toBe('merged');
      expect(updated.statusId).toBe(task.statusId);
      expect((await getSession(admin, task.id))!.state).toBe('running');
      expect((await socket.next('task.updated', (e) => e.task.pullRequest?.state === 'merged')).event.task.id).toBe(task.id);
    } finally {
      time.mockRestore();
      socket.close();
      await client.close();
    }
    await runner.exit(start.jobId);
  });

  it('polls open/draft PRs every five minutes and protection daily', async () => {
    const { admin, bundle, task, start } = await running();
    app.git.branches.get('1')!.add(start.git!.taskBranch);
    const client = await clientFor(start);
    await callPR(client, 'Draft work', true);
    app.git.pullRequests.get('1')![0]!.state = 'closed';
    app.git.protection.set('1', false);
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 3600000 + 1);
    try {
      await app.server.ctx.gitSync.tick();
      expect((await admin.get(`/projects/${bundle.project.id}`)).body.project.repository.protection.protected).toBe(false);
      expect((await admin.get(`/projects/${bundle.project.id}/tasks`)).body.tasks.find((t: { id: string }) => t.id === task.id).pullRequest.state).toBe(
        'closed',
      );
    } finally {
      time.mockRestore();
      await client.close();
    }
  });

  it('removes the registered Git worktree on close and reports missing remote branches on recreation', async () => {
    const { admin, bundle, runner, task, start } = await running();
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    expect(await runner.next('worktree.remove')).toMatchObject({ worktreePath: start.worktreePath, repoPath: `repos/${bundle.project.id}.git` });
    await runner.exit(start.jobId);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Todo').id);
    await admin.post(`/tasks/${task.id}/comments`, { body: 'Continue' });
    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    expect(next.git!.taskBranch).toBe(start.git!.taskBranch);
    runner.accept(next.jobId);
    runner.sendJob({ type: 'job.worktree_ready', jobId: next.jobId, created: true, remoteBranchMissing: true });
    await runner.drain();
    expect((await timeline(admin, task.id)).some((i) => i.type === 'comment' && i.comment.body.includes('previous remote task branch was not found'))).toBe(
      true,
    );
  });

  it('a git provider outage holds that Task for Retry instead of blocking the Agent Queue', async () => {
    const { admin, agent, runner, task } = await setup();
    const other = await createProject(admin);
    const plain = await createTask(admin, other.project.id, { title: 'No repository' });
    app.git.branchExists = async () => {
      throw new GitProviderError('GitHub is unavailable', 503);
    };
    await assignAndStart(admin, task.id, agent.id);
    await assignAndStart(admin, plain.id, agent.id);

    const start = await runner.next('job.start');
    expect(start.git).toBeNull();
    const system = (await timeline(admin, task.id)).filter((i) => i.type === 'comment' && i.comment.kind === 'system');
    expect(system.map((i) => (i.type === 'comment' ? i.comment.body : ''))).toEqual([expect.stringContaining('GitHub is unavailable')]);
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'pending', held: true });

    app.git.branchExists = FakeGitProvider.prototype.branchExists;
    await runner.exit(start.jobId);
    expect((await admin.post(`/tasks/${task.id}/session/retry`)).status).toBe(200);
    const retried = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    expect(retried.git!.taskBranch).toBeTruthy();
  });
});
