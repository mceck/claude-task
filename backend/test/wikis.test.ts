import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { taskTopic } from '@claude-task/shared';
import type { InputBlock, Wiki, WikiChat } from '@claude-task/shared';
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

  const chats = async (client: { get: (path: string) => Promise<{ body: any }> }, wiki: Wiki) =>
    (await client.get(`/wikis/${wiki.id}/chats`)).body.chats as WikiChat[];
  const newChat = async (client: { post: (path: string, body?: unknown) => Promise<{ status: number; body: any }> }, wiki: Wiki) => {
    const res = await client.post(`/wikis/${wiki.id}/chats`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.chat as WikiChat;
  };

  it('keeps several Chats, each with its own Claude conversation, in one Worktree on one branch', async () => {
    const { admin, wiki, runner } = await setup();
    expect(await chats(admin, wiki)).toEqual([]);
    await comment(admin, wiki.taskId, 'How do we onboard people?');
    const s = new Stream();
    const first = await runner.runJob([s.init(), s.text('Start with the handbook'), s.result()]);

    const chat = await newChat(admin, wiki);
    expect(chat.id).not.toBe(wiki.taskId);
    // A Chat appears in the list with its first Comment.
    expect((await chats(admin, wiki)).map((c) => c.title)).toEqual(['How do we onboard people?']);
    await comment(admin, chat.id, 'And how do we offboard them?');
    const second = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(second).toMatchObject({ mode: 'new', worktreePath: first.worktreePath, git: { taskBranch: first.git!.taskBranch } });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(texts(second.initialMessage)).toContain('offboard');
    expect(texts(second.initialMessage)).not.toContain('onboard people');
    runner.accept(second.jobId);
    await runner.play(second.jobId, [s.init(), s.text('Collect the laptop'), s.result()]);
    await runner.exit(second.jobId, 0);

    const list = await chats(admin, wiki);
    expect(list.map((c) => c.title)).toEqual(['And how do we offboard them?', 'How do we onboard people?']);
    expect(list.every((c) => c.agentId === wiki.agentId)).toBe(true);

    // Writing in the older Chat resumes its own conversation.
    await comment(admin, wiki.taskId, 'Thanks, one more thing about onboarding');
    const resumed = await runner.next('job.start', (m) => m.jobId !== first.jobId && m.jobId !== second.jobId);
    expect(resumed).toMatchObject({ mode: 'resume', sessionId: first.sessionId, worktreePath: first.worktreePath });
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
    // The tools that would change the Chat's Task are not offered at all.
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const name of ['update_task', 'set_status', 'create_task']) expect(names).not.toContain(name);
    expect(names).toEqual(expect.arrayContaining(['get_task', 'search_comments', 'send_files', 'ask_question', 'open_pull_request']));
    expect((await call('update_task', { title: 'Renamed' })).isError).toBe(true);
    await mcp.close();
  });

  it('lets multiple members chat and tells everyone when a Chat is deleted', async () => {
    const { admin, wiki, runner } = await setup();
    const { client } = await createUser(app, admin);
    const ws = await WsTestClient.connect(app.url, client.cookie);
    await ws.subscribe(taskTopic(wiki.taskId), 'wikis');
    try {
      await comment(admin, wiki.taskId, 'A question from Ada');
      await comment(client, wiki.taskId, 'A question from another member');
      // The Chat list refreshes (last activity, unread) as the conversation moves.
      expect(await ws.next('wiki.changed')).toMatchObject({ topic: 'wikis', event: { wikiId: wiki.id } });
      expect((await timeline(client, wiki.taskId)).filter((i) => i.type === 'comment')).toHaveLength(2);
      expect((await client.delete(`/wikis/${wiki.id}/chats/${wiki.taskId}`)).status).toBe(204);
      await ws.next('timeline.reset');
      expect(await chats(admin, wiki)).toEqual([]);
      expect(await timeline(admin, wiki.taskId)).toEqual([]);
      expect(await timeline(client, wiki.taskId)).toEqual([]);
      expect((await client.get(`/wikis/${wiki.id}`)).body.wiki.repository).toEqual(wiki.repository);
      await runner.next('job.cancel');
    } finally {
      ws.close();
    }
  });

  it('starts a new Claude session in a deleted Chat while retaining the checkout and branch', async () => {
    const { admin, wiki, runner } = await setup();
    await comment(admin, wiki.taskId, 'Secret old chat context');
    const s = new Stream();
    const first = await runner.runJob([s.init(), s.text('Old answer'), s.result()]);
    await comment(admin, wiki.taskId, 'Continue');
    const second = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(second.mode).toBe('resume');
    runner.accept(second.jobId);
    await runner.play(second.jobId, [s.init()]);
    expect((await admin.delete(`/wikis/${wiki.id}/chats/${wiki.taskId}`)).status).toBe(204);
    await runner.next('job.cancel', (m) => m.jobId === second.jobId);
    expect(await newChat(admin, wiki)).toMatchObject({ id: wiki.taskId });
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

  it('announces a Chat title change when its first Comment is edited', async () => {
    const { admin, wiki } = await setup();
    const first = await comment(admin, wiki.taskId, 'Old title');
    const ws = await WsTestClient.connect(app.url, admin.cookie);
    await ws.subscribe('wikis');
    try {
      expect((await admin.patch(`/comments/${first.id}`, { body: 'New title' })).status).toBe(200);
      expect((await ws.next('wiki.changed')).event).toMatchObject({ wikiId: wiki.id });
      expect((await chats(admin, wiki))[0]!.title).toBe('New title');
    } finally {
      ws.close();
    }
  });

  it('renames a Chat, and keeps the others when one is deleted', async () => {
    const { admin, wiki, runner } = await setup();
    await comment(admin, wiki.taskId, 'First chat question');
    const first = await runner.next('job.start');
    const chat = await newChat(admin, wiki);
    await comment(admin, chat.id, '   Second\n chat   question  ');
    expect((await chats(admin, wiki)).map((c) => c.title).sort()).toEqual(['First chat question', 'Second chat question']);
    const renamed = await admin.patch(`/wikis/${wiki.id}/chats/${chat.id}`, { title: 'Onboarding plan' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.chat.title).toBe('Onboarding plan');
    expect((await chats(admin, wiki))[0]!.title).toBe('Onboarding plan');
    expect((await admin.patch(`/wikis/${wiki.id}/chats/${chat.id}`, { title: '  ' })).status).toBe(400);

    expect((await admin.delete(`/wikis/${wiki.id}/chats/${chat.id}`)).status).toBe(204);
    expect((await chats(admin, wiki)).map((c) => c.title)).toEqual(['First chat question']);
    expect((await timeline(admin, wiki.taskId)).filter((i) => i.type === 'comment')).toHaveLength(1);
    expect((await timeline(admin, chat.id)).filter((i) => i.type === 'comment')).toHaveLength(0);
    expect((await admin.delete(`/wikis/${wiki.id}/chats/${chat.id}`)).status).toBe(404);
    // The emptied Chat is handed out again, without the old title.
    expect((await newChat(admin, wiki)).id).toBe(chat.id);
    expect(runner.messages('job.cancel').map((m) => m.jobId)).not.toContain(first.jobId);
  });

  it('hands out an empty Chat on the Wiki current Agent after a switch', async () => {
    const { admin, wiki } = await setup();
    const { agent: next } = await createAgent(app, admin, { name: 'Bea Bot' });
    const empty = await newChat(admin, wiki);
    expect(empty.agentId).toBe(wiki.agentId);
    expect((await admin.patch(`/wikis/${wiki.id}`, { agentId: next.id })).status).toBe(200);
    const again = await newChat(admin, wiki);
    expect(again).toMatchObject({ id: empty.id, agentId: next.id });
    await comment(admin, again.id, 'Start here.');
  });

  it('refuses deleting the Agent that runs a Wiki', async () => {
    const { admin, wiki } = await setup();
    const { agent: next } = await createAgent(app, admin, { name: 'Bea Bot' });
    expect((await admin.patch(`/wikis/${wiki.id}`, { agentId: next.id })).status).toBe(200);
    const deleted = await admin.delete(`/agents/${next.id}`);
    expect(deleted.status).toBe(409);
    expect(deleted.body.error.message).toMatch(/Wiki/);
    expect((await admin.get(`/wikis/${wiki.id}`)).body.wiki.agentId).toBe(next.id);
  });

  it('keeps the unread indicator for a muted Wiki', async () => {
    const { admin, wiki } = await setup();
    const { client } = await createUser(app, admin);
    await admin.patch(`/tasks/${wiki.taskId}/preferences`, { muted: true });
    await comment(client, wiki.taskId, 'Activity while muted');
    expect((await chats(admin, wiki))[0]).toMatchObject({ unread: true });
  });

  it('announces Agent Comments on the Wikis topic', async () => {
    const { admin, wiki, runner } = await setup();
    await comment(admin, wiki.taskId, 'A question');
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const ws = await WsTestClient.connect(app.url, admin.cookie);
    await ws.subscribe('wikis');
    try {
      const s = new Stream(start.sessionId);
      await runner.play(start.jobId, [s.init(), s.text('The answer.'), s.result()]);
      expect((await ws.next('wiki.changed')).event).toMatchObject({ wikiId: wiki.id });
    } finally {
      ws.close();
    }
    await runner.exit(start.jobId);
  });

  it('titles a Chat from its first User Comment even when it is an Internal Note', async () => {
    const { admin, wiki } = await setup();
    await comment(admin, wiki.taskId, 'Internal planning', true);
    await comment(admin, wiki.taskId, 'Public follow-up');
    expect((await chats(admin, wiki))[0]!.title).toBe('Internal planning');
  });

  it('keeps a Chat with the Agent that runs it when the Wiki changes Agent', async () => {
    const { admin, wiki, agent, runner } = await setup();
    await comment(admin, wiki.taskId, 'Original conversation');
    const s = new Stream();
    const first = await runner.runJob([s.init(), s.text('Before the change'), s.result()]);
    const spare = await newChat(admin, wiki);
    const { agent: other, runner: otherRunner } = await createAgent(app, admin);

    expect((await admin.patch(`/wikis/${wiki.id}`, { agentId: other.id })).status).toBe(200);
    expect((await admin.get(`/wikis/${wiki.id}`)).body.wiki.agentId).toBe(other.id);
    // The old Chat stays readable, paused, and cannot be continued by the new Agent.
    expect(await getSession(admin, wiki.taskId)).toMatchObject({ state: 'paused' });
    expect((await chats(admin, wiki)).find((c) => c.id === wiki.taskId)).toMatchObject({ agentId: agent.id });
    const refused = await admin.post(`/tasks/${wiki.taskId}/comments`, { body: 'Can you continue?' });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(agent.name);
    expect((await timeline(admin, wiki.taskId)).filter((i) => i.type === 'comment')).toHaveLength(2);

    // A Chat created now belongs to the new Agent; the unused one moves to it too.
    await comment(admin, spare.id, 'A question for the new agent');
    const other1 = await otherRunner.next('job.start');
    expect(other1.mode).toBe('new');
    expect(texts(other1.initialMessage)).not.toContain('Original conversation');
    expect((await chats(admin, wiki)).find((c) => c.id === spare.id)).toMatchObject({ agentId: other.id });

    // Back to the first Agent: its Chat continues the Claude conversation it had.
    expect((await admin.patch(`/wikis/${wiki.id}`, { agentId: agent.id })).status).toBe(200);
    expect(await getSession(admin, wiki.taskId)).toMatchObject({ state: 'idle' });
    await comment(admin, wiki.taskId, 'Continuing with you again');
    const resumed = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(resumed).toMatchObject({ mode: 'resume', sessionId: first.sessionId });
    expect((await admin.patch(`/wikis/${wiki.id}`, { agentId: randomUUID() })).status).toBe(400);
  });

  it('applies the Wiki\'s name, description, follow and mute choices to every Chat', async () => {
    const { admin, wiki } = await setup();
    await comment(admin, wiki.taskId, 'First');
    const chat = await newChat(admin, wiki);
    await comment(admin, chat.id, 'Second');
    expect((await admin.patch(`/wikis/${wiki.id}`, { name: 'Renamed wiki', description: 'New description' })).status).toBe(200);
    expect((await admin.get(`/tasks/${chat.id}`)).body.task).toMatchObject({ title: 'Renamed wiki', description: 'New description' });

    expect((await admin.patch(`/tasks/${wiki.taskId}/preferences`, { following: false, muted: true })).status).toBe(200);
    expect((await admin.get(`/tasks/${chat.id}/preferences`)).body.preference).toMatchObject({ following: false, muted: true });
    // A Chat created later starts with the choices made on the Wiki.
    const later = await newChat(admin, wiki);
    await comment(admin, later.id, 'Third');
    expect((await admin.get(`/tasks/${later.id}/preferences`)).body.preference).toMatchObject({ following: false, muted: true });
  });

  it('deletes the Wiki with all its Chats, but not while one of them is running', async () => {
    const { admin, wiki, runner } = await setup();
    await comment(admin, wiki.taskId, 'First');
    const chat = await newChat(admin, wiki);
    await comment(admin, chat.id, 'Second');
    const job = await runner.next('job.start');
    runner.accept(job.jobId);
    await runner.drain();
    expect((await admin.delete(`/wikis/${wiki.id}`)).status).toBe(409);
    expect((await admin.get(`/tasks/${chat.id}`)).status).toBe(200);
    await runner.exit(job.jobId, 0);
    const next = await runner.next('job.start', (m) => m.jobId !== job.jobId);
    runner.accept(next.jobId);
    await runner.exit(next.jobId, 0);
    expect((await admin.delete(`/wikis/${wiki.id}`)).status).toBe(204);
    expect((await admin.get(`/tasks/${chat.id}`)).status).toBe(404);
    expect((await admin.get(`/tasks/${wiki.taskId}`)).status).toBe(404);
  });

  it('opens one pull request for the Wiki whichever Chat the Agent works in', async () => {
    const { admin, wiki, runner } = await setup();
    await comment(admin, wiki.taskId, 'Edit the handbook');
    const first = await runner.runJob([new Stream().init(), new Stream().result()]);
    const chat = await newChat(admin, wiki);
    await comment(admin, chat.id, 'Fix the glossary');
    const second = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    runner.accept(second.jobId);
    await runner.play(second.jobId, [new Stream(second.sessionId).init()]);
    app.git.branches.get('1')!.add(second.git!.taskBranch);
    const server = JSON.parse(second.claudeArgs.mcpConfig).mcpServers['claude-task'];
    const mcp = new Client({ name: 'test', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/api/v1/mcp`), { requestInit: { headers: server.headers } }));
    const result = (await mcp.callTool({ name: 'open_pull_request', arguments: { title: 'Update wiki', body: 'Two small fixes.' } })) as { isError?: boolean };
    await mcp.close();
    expect(result.isError ?? false).toBe(false);
    // The pull request belongs to the Wiki's first Task, which the Wiki view shows.
    expect((await admin.get(`/tasks/${wiki.taskId}`)).body.task.pullRequest).toMatchObject({ state: 'open' });
    expect((await admin.get(`/tasks/${chat.id}`)).body.task.pullRequest).toBeNull();
  });

  it('restarts a Chat from its own history when its Claude conversation is gone', async () => {
    const { admin, wiki, runner } = await setup();
    await comment(admin, wiki.taskId, 'We use pnpm everywhere');
    const s = new Stream();
    const first = await runner.runJob([s.init(), s.text('Noted, pnpm it is'), s.result()]);
    await comment(admin, wiki.taskId, 'Which package manager again?');
    const resume = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(resume.mode).toBe('resume');
    runner.accept(resume.jobId);
    runner.sendJob({ type: 'job.stderr', jobId: resume.jobId, chunk: `No conversation found with session ID: ${resume.sessionId}\n` });
    await runner.exit(resume.jobId, 1);
    await comment(admin, wiki.taskId, 'Are you there?');
    const restart = await runner.next('job.start', (m) => m.jobId !== first.jobId && m.jobId !== resume.jobId);
    expect(restart.mode).toBe('new');
    expect(texts(restart.initialMessage)).toContain('We use pnpm everywhere');
    expect(texts(restart.initialMessage)).toContain('Noted, pnpm it is');
    expect(texts(restart.initialMessage)).toContain('Which package manager again?');
    expect(texts(restart.initialMessage)).toContain('Are you there?');
    const notes = (await timeline(admin, wiki.taskId)).flatMap((i) => (i.type === 'comment' && i.comment.kind === 'system' ? [i.comment.body] : []));
    expect(notes.join('\n')).toContain("previous conversation");
  });

  it('follows the whole Wiki when someone comments in any Chat, and lists a Chat from its first User Comment', async () => {
    const { admin, wiki } = await setup();
    const { client: member } = await createUser(app, admin);
    await comment(admin, wiki.taskId, 'First');
    const chat = await newChat(member, wiki);
    // An empty Chat is not listed, and following it is following the Wiki.
    expect(await chats(member, wiki)).toHaveLength(1);
    await comment(member, chat.id, 'From a member');
    expect((await member.get(`/tasks/${wiki.taskId}/preferences`)).body.preference).toMatchObject({ following: true });
    expect((await member.get(`/tasks/${chat.id}/preferences`)).body.preference).toMatchObject({ following: true });
  });

  it('takes Internal Notes in a Chat run by another Agent, and lets a Chat whose Agent was deleted continue', async () => {
    const { admin, wiki, agent, runner } = await setup();
    await comment(admin, wiki.taskId, 'Original conversation');
    await runner.next('job.start');
    const { agent: other } = await createAgent(app, admin);
    expect((await admin.patch(`/wikis/${wiki.id}`, { agentId: other.id })).status).toBe(200);
    // Internal Notes are never delivered to an Agent, so they are fine in any Chat.
    expect((await admin.post(`/tasks/${wiki.taskId}/comments`, { body: 'Note to self', internal: true })).status).toBe(201);
    expect((await admin.post(`/tasks/${wiki.taskId}/comments`, { body: 'To the agent' })).status).toBe(409);
    // With its Agent gone, the Chat carries on with the Wiki's current one.
    expect((await admin.delete(`/agents/${agent.id}`)).status).toBe(204);
    expect((await admin.post(`/tasks/${wiki.taskId}/comments`, { body: 'Anyone there?' })).status).toBe(201);
    expect((await chats(admin, wiki)).find((c) => c.id === wiki.taskId)).toMatchObject({ agentId: other.id });
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
    await comment(admin, wiki.taskId, 'Queued before deletion');
    expect((await admin.get(`/agents/${agent.id}/queue`)).body.entries).toHaveLength(1);
    expect((await admin.delete(`/wikis/${wiki.id}/chats/${wiki.taskId}`)).status).toBe(204);
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
