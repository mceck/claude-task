import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { taskTopic } from '@claude-task/shared';
import type { InputBlock, Wiki } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import { comment, createAgent, createUser, getSession, timeline } from './helpers/fixtures';
import { Stream } from './helpers/stream';
import { FakeRunner } from './helpers/runner';
import { WsTestClient } from './helpers/ws';

const texts = (blocks: InputBlock[] | null) =>
  (blocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

describe('Wikis', () => {
  const app = useTestApp();
  async function setup() {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const result = await admin.post('/wikis', {
      name: 'Team wiki',
      description: 'Shared knowledge',
      agentId: agent.id,
      repository: { connectionId: 'env-github', providerRepoId: '1' },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return { admin, agent, runner, wiki: result.body.wiki as Wiki };
  }

  it('creates a Wiki with a repository and Agent, separate from Projects, waiting for the first Comment', async () => {
    const { admin, agent, runner, wiki } = await setup();
    expect(wiki).toMatchObject({
      name: 'Team wiki',
      agentId: agent.id,
      repository: { owner: 'acme', name: 'example', baseBranch: 'main' },
    });
    expect((await admin.get('/projects')).body.projects).toEqual([]);
    expect((await admin.get('/wikis')).body.wikis).toEqual([wiki]);
    expect(await getSession(admin, wiki.taskId)).toMatchObject({ state: 'pending' });
    expect(await runner.none('job.start')).toBe(true);
    await comment(admin, wiki.taskId, 'Read the repository wiki skills.');
    const start = await runner.next('job.start');
    expect(start.mode).toBe('new');
    expect(start.git?.repositoryId).toBe('env-github/1');
    expect(start.claudeArgs.appendSystemPrompt).toContain('repository skills');
  });

  it('keeps the Wiki Project and its Backing Task out of the Project, Status, Tag and Task APIs', async () => {
    const { admin, runner, wiki } = await setup();
    const { client: member } = await createUser(app, admin);
    const task = (await admin.get(`/tasks/${wiki.taskId}`)).body.task;
    const attempts: [string, string, unknown?][] = [
      ['GET', `/projects/${wiki.id}`],
      ['PATCH', `/projects/${wiki.id}`, { name: 'Renamed' }],
      ['POST', `/projects/${wiki.id}/archive`],
      ['GET', `/projects/${wiki.id}/tasks`],
      ['POST', `/projects/${wiki.id}/tasks`, { title: 'Stray task' }],
      ['GET', `/projects/${wiki.id}/statuses`],
      ['POST', `/projects/${wiki.id}/statuses`, { name: 'Extra', color: '#888888', category: 'active' }],
      ['GET', `/projects/${wiki.id}/tags`],
      ['PATCH', `/projects/${wiki.id}/agent-settings`, { agentInstructions: 'Something else' }],
      ['PUT', `/projects/${wiki.id}/repository`, { repository: null }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await member.request(method, path, { body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await admin.patch(`/tasks/${wiki.taskId}`, { version: task.version, title: 'Renamed' })).status).toBe(403);
    expect((await admin.post(`/tasks/${wiki.taskId}/move`, { statusId: task.statusId })).status).toBe(403);
    expect((await admin.delete(`/tasks/${wiki.taskId}`)).status).toBe(403);
    expect((await admin.get(`/wikis/${wiki.id}`)).body.wiki).toEqual(wiki);

    // The conversation keeps working, and the Agent reads its Task but doesn't change it.
    await comment(member, wiki.taskId, 'Summarise the onboarding page.');
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();
    const server = JSON.parse(start.claudeArgs.mcpConfig).mcpServers['claude-task'];
    const mcp = new Client({ name: 'test', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url.replace('http://backend.test', app.url)), { requestInit: { headers: server.headers } }));
    const call = (name: string, args: Record<string, unknown> = {}) =>
      mcp.callTool({ name, arguments: args }) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    expect((await call('get_task')).isError ?? false).toBe(false);
    for (const [name, args] of [
      ['update_task', { title: 'Renamed' }],
      ['set_status', { status_name: 'Done' }],
      ['create_task', { title: 'Stray task' }],
    ] as const) {
      const res = await call(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.content[0]!.text).toContain('belongs to a Wiki');
    }
    await mcp.close();
  });

  it('lets multiple members chat and broadcasts resets to everyone', async () => {
    const { admin, wiki, runner } = await setup();
    const { client } = await createUser(app, admin);
    const ws = await WsTestClient.connect(app.url, client.cookie);
    await ws.subscribe(taskTopic(wiki.taskId), 'wikis');
    try {
      await comment(admin, wiki.taskId, 'A question from Ada');
      await comment(client, wiki.taskId, 'A question from another member');
      expect((await timeline(client, wiki.taskId)).filter((i) => i.type === 'comment')).toHaveLength(2);
      expect((await client.post(`/wikis/${wiki.id}/reset`)).status).toBe(200);
      await ws.next('timeline.reset');
      expect(await timeline(admin, wiki.taskId)).toEqual([]);
      expect(await timeline(client, wiki.taskId)).toEqual([]);
      expect((await client.get(`/wikis/${wiki.id}`)).body.wiki.repository).toEqual(wiki.repository);
      await runner.next('job.cancel');
    } finally {
      ws.close();
    }
  });

  it('starts a new Claude session after reset while retaining the checkout and branch', async () => {
    const { admin, wiki, runner } = await setup();
    await comment(admin, wiki.taskId, 'Secret old chat context');
    const s = new Stream();
    const first = await runner.runJob([s.init(), s.text('Old answer'), s.result()]);
    await comment(admin, wiki.taskId, 'Continue');
    const second = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(second.mode).toBe('resume');
    runner.accept(second.jobId);
    await runner.play(second.jobId, [s.init()]);
    expect((await admin.post(`/wikis/${wiki.id}/reset`)).status).toBe(200);
    await runner.next('job.cancel', (m) => m.jobId === second.jobId);
    await comment(admin, wiki.taskId, 'New context only');
    expect(runner.messages('job.input')).toHaveLength(0);
    expect(runner.messages('job.start')).toHaveLength(2);
    // Buffered output from the cancelled process must not recreate deleted messages.
    await runner.play(second.jobId, [s.text('Late old output'), s.result()]);
    expect((await timeline(admin, wiki.taskId)).filter((i) => i.type === 'comment')).toHaveLength(1);
    await runner.exit(second.jobId, null, 'SIGTERM');
    const fresh = await runner.next('job.start', (m) => m.jobId !== first.jobId && m.jobId !== second.jobId);
    expect(fresh).toMatchObject({ mode: 'new', worktreePath: first.worktreePath, git: { taskBranch: first.git!.taskBranch } });
    expect(fresh.sessionId).not.toBe(first.sessionId);
    expect(texts(fresh.initialMessage)).toContain('New context only');
    expect(texts(fresh.initialMessage)).not.toContain('Secret old chat context');
    expect(texts(fresh.initialMessage)).not.toContain('Old answer');
    expect(runner.messages('worktree.remove')).toHaveLength(0);
    expect((await admin.get(`/tasks/${wiki.taskId}`)).body.task.chatGeneration).toBe(1);
  });

  it('resets previously assigned Agents too', async () => {
    const { admin, wiki, agent, runner } = await setup();
    await comment(admin, wiki.taskId, 'Original conversation');
    const s = new Stream();
    const first = await runner.runJob([s.init(), s.text('Before reset'), s.result()]);
    const { agent: other } = await createAgent(app, admin);
    expect((await admin.patch(`/wikis/${wiki.id}`, { agentId: other.id })).status).toBe(200);
    expect((await admin.post(`/wikis/${wiki.id}/reset`)).status).toBe(200);
    expect((await admin.patch(`/wikis/${wiki.id}`, { agentId: agent.id, name: 'Renamed wiki' })).status).toBe(200);
    await comment(admin, wiki.taskId, 'Fresh after reassignment');
    const next = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(next.mode).toBe('new');
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(texts(next.initialMessage)).not.toContain('Original conversation');
    expect((await admin.get(`/wikis/${wiki.id}`)).body.wiki.name).toBe('Renamed wiki');
  });

  it('rejects missing or inaccessible repositories and invalid Agents without leaving partial Wikis', async () => {
    const { admin, agent } = await setup();
    for (const body of [
      { name: 'No repository', agentId: agent.id },
      { name: 'Missing repository', agentId: agent.id, repository: { connectionId: 'env-github', providerRepoId: '9999' } },
      { name: 'Missing agent', agentId: randomUUID(), repository: { connectionId: 'env-github', providerRepoId: '1' } },
    ])
      expect((await admin.post('/wikis', body)).status).toBe(400);
    expect((await admin.get('/wikis')).body.wikis).toHaveLength(1);
    expect((await admin.get('/projects')).body.projects).toHaveLength(0);
    expect((await app.client().get('/wikis')).status).toBe(401);
  });

  it('clears queued comments while the Agent is offline and cancels on reconnect', async () => {
    const { admin, wiki, runner, agent } = await setup();
    await comment(admin, wiki.taskId, 'Running before disconnect');
    const job = await runner.next('job.start');
    runner.accept(job.jobId);
    await runner.drain();
    await runner.close();
    await comment(admin, wiki.taskId, 'Queued before reset');
    expect((await admin.get(`/agents/${agent.id}/queue`)).body.entries).toHaveLength(1);
    expect((await admin.post(`/wikis/${wiki.id}/reset`)).status).toBe(200);
    expect((await admin.get(`/agents/${agent.id}/queue`)).body.entries).toEqual([]);
    const reconnected = await FakeRunner.connect(app, agent.id, { activeJobId: job.jobId });
    await reconnected.next('job.cancel', (m) => m.jobId === job.jobId);
    await reconnected.exit(job.jobId);
    expect(await timeline(admin, wiki.taskId)).toEqual([]);
    expect(await reconnected.none('job.start')).toBe(true);
  });

  it('deletes the Wiki and its shared conversation', async () => {
    const { admin, wiki } = await setup();
    expect((await admin.delete(`/wikis/${wiki.id}`)).status).toBe(204);
    expect((await admin.get('/wikis')).body.wikis).toEqual([]);
    expect((await admin.get(`/tasks/${wiki.taskId}`)).status).toBe(404);
  });
});
