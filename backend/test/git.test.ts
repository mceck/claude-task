import { generateKeyPairSync } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { taskTopic, projectTopic } from '@claude-task/shared';
import { describe, expect, it, vi } from 'vitest';
import { useTestApp } from './helpers/app';
import { assignAgent, assignAndStart, createAgent, createProject, createTask, createUser, getSession, moveToStatus, statusByName, timeline } from './helpers/fixtures';
import { Stream } from './helpers/stream';
import { WsTestClient } from './helpers/ws';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

describe('Git integration through the public API', () => {
  const app = useTestApp();
  async function setup() {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    expect((await admin.put(`/projects/${bundle.project.id}/repository`, { providerRepoId: '1' })).status).toBe(200);
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

  it('keeps App keys write-only and lets only admins configure the App and list installations', async () => {
    const admin = await app.admin();
    const member = (await createUser(app, admin)).client;
    expect((await member.get('/git/github')).status).toBe(403);
    expect((await member.put('/git/github', { appId: '123', privateKey })).status).toBe(403);
    expect((await admin.put('/git/github', { appId: '123', privateKey: 'invalid key' })).status).toBe(400);
    const saved = await admin.put('/git/github', { appId: '123', privateKey });
    expect(saved.body.settings).toEqual({ appId: '123', configured: true, privateKeyConfigured: true, source: 'database' });
    expect(JSON.stringify((await admin.get('/git/github')).body)).not.toContain('PRIVATE KEY');
    expect((await admin.put('/git/github', { appId: '123' })).status).toBe(200);
    expect((await admin.get('/git/installations')).body.installations[0].account).toBe('acme');
    expect((await member.get('/git/installations')).status).toBe(403);
    expect((await member.get('/git/repositories')).body.repositories).toHaveLength(2);
  });

  it('links accessible repositories as a member, defaults and validates the base branch, and rechecks protection', async () => {
    const admin = await app.admin();
    const member = (await createUser(app, admin)).client;
    const { project } = await createProject(admin);
    expect((await member.put(`/projects/${project.id}/repository`, { providerRepoId: '999' })).status).toBe(400);
    expect((await member.put(`/projects/${project.id}/repository`, { providerRepoId: '1', baseBranch: 'missing' })).status).toBe(400);
    app.git.protection.set('1', false);
    const linked = await member.put(`/projects/${project.id}/repository`, { providerRepoId: '1' });
    expect(linked.body.repository).toMatchObject({ owner: 'acme', name: 'example', baseBranch: 'main', protection: { protected: false } });
    expect((await member.get(`/projects/${project.id}`)).body.project.repository.baseBranch).toBe('main');
    app.git.protection.set('1', true);
    expect((await member.post(`/projects/${project.id}/repository/check-protection`)).body.repository.protection.protected).toBe(true);
    app.git.branches.get('1')!.add('develop');
    expect((await member.put(`/projects/${project.id}/repository`, { providerRepoId: '1', baseBranch: 'develop' })).body.repository.baseBranch).toBe('develop');
  });

  it('blocks repository changes for non-closed sessions, including paused ones; allows changes after close', async () => {
    const { admin, bundle, agent, runner, task } = await setup();
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    expect((await admin.put(`/projects/${bundle.project.id}/repository`, { providerRepoId: '2' })).status).toBe(409);
    await assignAgent(admin, task.id, null);
    await runner.exit(start.jobId);
    expect((await admin.get(`/projects/${bundle.project.id}/repository`)).body.hasOpenSessions).toBe(true);
    expect((await admin.put(`/projects/${bundle.project.id}/repository`, { providerRepoId: '2' })).status).toBe(409);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    expect((await admin.put(`/projects/${bundle.project.id}/repository`, { providerRepoId: '2' })).status).toBe(200);
  });

  it('dispatches stable ASCII task branches and worktree/commit configuration, preserving names across renames and reassignment', async () => {
    const { admin, bundle, agent, runner, task, start } = await running();
    const branch = `task/${task.key.toLowerCase()}-fix-cafe-login-redirect`;
    expect(start.git).toMatchObject({
      cloneUrl: 'https://github.com/acme/example.git',
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

  it('grants tokens only for the accepted active job and its single repository, including while finishing', async () => {
    const { admin, agent, runner, task } = await setup();
    const request = async (id: string, jobId: string, repository: string) => {
      runner.send({ type: 'git.token_request', requestId: id, jobId, repository });
      return runner.next('git.token', (m) => m.requestId === id);
    };
    expect((await request('idle', '00000000-0000-0000-0000-000000000000', 'acme/example')).error).toBeTruthy();
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    expect((await request('dispatched', start.jobId, 'acme/example')).error).toBeTruthy();
    runner.accept(start.jobId);
    await runner.drain();
    const granted = await request('running', start.jobId, 'ACME/EXAMPLE');
    expect(granted.token).toContain('fake-git-token-1-');
    expect((await request('other-repository', start.jobId, 'acme/other')).error).toBeTruthy();
    expect((await request('path-traversal', start.jobId, 'acme/example/../other')).error).toBeTruthy();
    await runner.play(start.jobId, [new Stream().result()]);
    expect((await request('finishing', start.jobId, 'acme/example')).token).toBeTruthy();
    await runner.exit(start.jobId);
    expect((await request('finished', start.jobId, 'acme/example')).error).toBeTruthy();
    for (const path of [`/tasks/${task.id}`, `/agents/${agent.id}/jobs`, `/agents/${agent.id}/logs`])
      expect(JSON.stringify((await admin.get(path)).body)).not.toContain(granted.token);
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
});
