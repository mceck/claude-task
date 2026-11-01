import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JobStartMessage } from '@claude-task/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { TestApp } from './helpers/app';
import { assignAgent, assignAndStart, comment, createAgent, createProject, createTask, moveToStatus, statusByName, timeline } from './helpers/fixtures';
import type { FakeRunner } from './helpers/runner';
import { seedPlatformSkill } from '../src/modules/extensions/platform-skill';

async function mcpClient(app: TestApp, start: JobStartMessage): Promise<Client> {
  const server = JSON.parse(start.claudeArgs.mcpConfig).mcpServers['claude-task'];
  const url = new URL(server.url.replace('http://backend.test', app.url));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: server.headers } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content[0]!.text;
  return { isError: res.isError ?? false, text, json: res.isError ? null : JSON.parse(text) };
}

/** A Job of `agent` running on a fresh Task of the Project, connected as `claude` would be. */
async function runningJob(app: TestApp, admin: Awaited<ReturnType<TestApp['admin']>>, projectId: string, agent: { id: string }, runner: FakeRunner, title: string) {
  const task = await createTask(admin, projectId, { title });
  await assignAndStart(admin, task.id, agent.id);
  const start = await runner.next('job.start');
  runner.accept(start.jobId);
  await runner.drain();
  return { task, start, client: await mcpClient(app, start) };
}

async function setup(app: TestApp) {
  const admin = await app.admin();
  const bundle = await createProject(admin, { name: 'Payments' });
  const { agent, runner } = await createAgent(app, admin, { name: 'Ada Bot' });
  const job = await runningJob(app, admin, bundle.project.id, agent, runner, 'Parent task');
  const enableWrites = () => admin.patch(`/projects/${bundle.project.id}/agent-settings`, { boardWriteAccess: true });
  return { admin, bundle, agent, runner, ...job, enableWrites };
}

describe('Comment search and reading (MCP)', () => {
  const app = useTestApp();

  it('searches Tasks by title, description and key, with every word required', async () => {
    const { admin, bundle, client } = await setup(app);
    const repro = await createTask(admin, bundle.project.id, { title: 'Fix login', description: 'the repro fails on CI' });
    await createTask(admin, bundle.project.id, { title: 'Unrelated work' });
    const keys = async (text: string) => (await call(client, 'list_tasks', { text })).json.tasks.map((t: { key: string }) => t.key);
    expect(await keys('repro')).toEqual([repro.key]);
    expect(await keys('login repro')).toEqual([repro.key]);
    expect(await keys('repro unrelated')).toEqual([]);
    expect(await keys(repro.key.toLowerCase())).toEqual([repro.key]);
  });

  it('does not fold accents in Task searches', async () => {
    const { admin, bundle, client } = await setup(app);
    const accented = await createTask(admin, bundle.project.id, { title: 'Perché il login fallisce' });
    expect((await call(client, 'list_tasks', { text: 'perche' })).json.tasks.map((t: { key: string }) => t.key)).toEqual([]);
    expect((await call(client, 'list_tasks', { text: 'perché' })).json.tasks.map((t: { key: string }) => t.key)).toEqual([accented.key]);
  });

  it('filters Tasks by assignee, priority and last change', async () => {
    const { admin, bundle, client } = await setup(app);
    const me = (await admin.get('/auth/me')).body.user;
    const mine = await createTask(admin, bundle.project.id, { title: 'Mine', priority: 'high', assigneeIds: [me.id] });
    const free = await createTask(admin, bundle.project.id, { title: 'Free', priority: 'low' });
    const keys = async (args: Record<string, unknown>) =>
      (await call(client, 'list_tasks', args)).json.tasks.map((t: { key: string }) => t.key).sort();
    expect(await keys({ assignee: me.displayName.toUpperCase() })).toEqual([mine.key]);
    expect(await keys({ assignee: 'none' })).toContain(free.key);
    expect(await keys({ priority: 'high' })).toEqual([mine.key]);
    expect(await keys({ updated_since: '2000-01-01T00:00:00Z' })).toEqual(expect.arrayContaining([mine.key, free.key]));
    expect(await keys({ updated_since: '2999-01-01T00:00:00Z' })).toEqual([]);
    expect((await call(client, 'list_tasks', { updated_since: 'not a date' })).isError).toBe(true);
    expect((await call(client, 'list_tasks', { assignee: 'Nobody At All' })).isError).toBe(true);
  });

  it('searches Comments, excluding Internal Notes and deleted Comments', async () => {
    const { admin, bundle, client } = await setup(app);
    const task = await createTask(admin, bundle.project.id, { title: 'Resume work' });
    const both = await comment(admin, task.id, 'the resume limit hit us');
    const onlyResume = await comment(admin, task.id, 'resume elsewhere');
    const internal = await comment(admin, task.id, 'resume internal', true);
    const deleted = await comment(admin, task.id, 'resume deleted');
    await admin.delete(`/comments/${deleted.id}`);

    const hits = (await call(client, 'search_comments', { query: 'resume' })).json.hits as { commentId: string }[];
    const ids = hits.map((h) => h.commentId);
    expect(ids).toContain(both.id);
    expect(ids).toContain(onlyResume.id);
    expect(ids).not.toContain(internal.id);
    expect(ids).not.toContain(deleted.id);

    const exact = (await call(client, 'search_comments', { query: 'resume limit' })).json.hits as { commentId: string }[];
    expect(exact.map((h) => h.commentId)).toEqual([both.id]);
  });

  it('returns a snippet and the ids to read around a hit', async () => {
    const { admin, bundle, client } = await setup(app);
    const task = await createTask(admin, bundle.project.id, { title: 'Snippet' });
    await comment(admin, task.id, `${'x'.repeat(400)} untraceableword ${'y'.repeat(400)}`);
    const hit = (await call(client, 'search_comments', { query: 'untraceableword' })).json.hits[0];
    expect(hit.snippet).toContain('untraceableword');
    expect(hit.snippet.length).toBeLessThan(400);
    expect(hit.task).toMatchObject({ key: task.key, title: 'Snippet' });
    expect(hit.attachments).toEqual([]);
  });

  it('leaves closed Tasks out unless asked, in both searches', async () => {
    const { admin, bundle, client } = await setup(app);
    const open = await createTask(admin, bundle.project.id, { title: 'zettaword open' });
    await comment(admin, open.id, 'zettaword comment');
    const closed = await createTask(admin, bundle.project.id, { title: 'zettaword closed' });
    await comment(admin, closed.id, 'zettaword old decision');
    await moveToStatus(admin, closed.id, statusByName(bundle, 'Closed').id);

    const taskKeys = async (args: Record<string, unknown>) => (await call(client, 'list_tasks', args)).json.tasks.map((t: { key: string }) => t.key);
    expect(await taskKeys({ text: 'zettaword' })).toEqual([open.key]);
    expect(await taskKeys({ text: 'zettaword', status_category: 'closed' })).toEqual([closed.key]);

    const commentTasks = async (args: Record<string, unknown>) =>
      (await call(client, 'search_comments', args)).json.hits.map((h: { task: { key: string } }) => h.task.key);
    expect(await commentTasks({ query: 'zettaword' })).toEqual([open.key]);
    expect(await commentTasks({ query: 'zettaword', status_category: 'closed' })).toEqual([closed.key]);
  });

  it('keeps Comment searches inside the Project', async () => {
    const { admin, client } = await setup(app);
    const elsewhere = await createProject(admin, { name: 'Elsewhere' });
    const other = await createTask(admin, elsewhere.project.id, { title: 'Other project' });
    await comment(admin, other.id, 'quarantineword in another project');
    expect((await call(client, 'search_comments', { query: 'quarantineword' })).json.hits).toEqual([]);
  });

  it('reads the conversation around a comment with both sides and their bounds', async () => {
    const { admin, bundle, client } = await setup(app);
    const task = await createTask(admin, bundle.project.id, { title: 'Window' });
    const first = await comment(admin, task.id, 'first');
    const anchor = await comment(admin, task.id, 'anchor');
    const last = await comment(admin, task.id, 'last');
    await comment(admin, task.id, 'internal', true);

    const window = (await call(client, 'read_comments', { comment_id: anchor.id, before: 1, after: 1 })).json;
    expect(window.comments.map((c: { body: string }) => c.body)).toEqual(['first', 'anchor', 'last']);
    expect(window.comments.map((c: { id: string }) => c.id)).toEqual([first.id, anchor.id, last.id]);
    expect(window).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false });
    expect(window.task).toMatchObject({ key: task.key, title: 'Window' });

    const narrow = (await call(client, 'read_comments', { comment_id: anchor.id, before: 0, after: 0 })).json;
    expect(narrow.comments.map((c: { body: string }) => c.body)).toEqual(['anchor']);
  });

  it('refuses an internal, deleted or foreign comment', async () => {
    const { admin, bundle, client } = await setup(app);
    const task = await createTask(admin, bundle.project.id, { title: 'Hidden' });
    const internal = await comment(admin, task.id, 'secret', true);
    expect((await call(client, 'read_comments', { comment_id: internal.id })).isError).toBe(true);
    const deleted = await comment(admin, task.id, 'gone');
    await admin.delete(`/comments/${deleted.id}`);
    expect((await call(client, 'read_comments', { comment_id: deleted.id })).isError).toBe(true);
    const elsewhere = await createProject(admin, { name: 'Elsewhere' });
    const other = await createTask(admin, elsewhere.project.id, { title: 'Other' });
    const foreign = await comment(admin, other.id, 'elsewhere');
    expect((await call(client, 'read_comments', { comment_id: foreign.id })).isError).toBe(true);
  });
});

describe('Board Write Access (MCP)', () => {
  const app = useTestApp();

  it('offers the write tools only in a Project that allows them', async () => {
    const { client, enableWrites } = await setup(app);
    const names = async () => (await client.listTools()).tools.map((t) => t.name);
    expect(await names()).not.toContain('start_agent');
    await enableWrites();
    const withWrites = await names();
    expect(withWrites).toEqual(expect.arrayContaining(['update_task_by_key', 'set_task_status', 'comment_on_task', 'start_agent', 'list_agents']));
  });

  it('edits and moves another Task of the Project, never a closed one', async () => {
    const { admin, bundle, client, enableWrites } = await setup(app);
    await enableWrites();
    const target = await createTask(admin, bundle.project.id, { title: 'Target' });
    expect((await call(client, 'update_task_by_key', { key: target.key, title: 'Renamed', priority: 'high' })).isError).toBe(false);
    expect((await admin.get(`/tasks/${target.id}`)).body.task).toMatchObject({ title: 'Renamed', priority: 'high' });
    expect((await call(client, 'set_task_status', { key: target.key, status_name: 'Ready for Review' })).json).toMatchObject({ status: 'Ready for Review' });
    expect((await call(client, 'set_task_status', { key: target.key, status_name: 'Closed' })).isError).toBe(true);

    await moveToStatus(admin, target.id, statusByName(bundle, 'Closed').id);
    expect((await call(client, 'update_task_by_key', { key: target.key, title: 'Too late' })).isError).toBe(true);
    expect((await admin.get(`/tasks/${target.id}`)).body.task.title).toBe('Renamed');
  });

  it('writes in another Task and delivers the message to its Agent', async () => {
    const { admin, bundle, client, enableWrites } = await setup(app);
    await enableWrites();
    const { agent: bob, runner: bobRunner } = await createAgent(app, admin, { name: 'Bob Bot' });
    const target = await createTask(admin, bundle.project.id, { title: 'Bob works here' });
    await assignAndStart(admin, target.id, bob.id);
    const bobStart = await bobRunner.next('job.start');
    bobRunner.accept(bobStart.jobId);
    await bobRunner.drain();

    const res = await call(client, 'comment_on_task', { key: target.key, body: 'Please also cover the edge case.' });
    expect(res.isError).toBe(false);
    const items = await timeline(admin, target.id);
    const posted = items
      .flatMap((item) => (item.type === 'comment' ? [item.comment] : []))
      .filter((c) => c.body === 'Please also cover the edge case.')
      .at(-1)!;
    expect(posted).toMatchObject({ kind: 'agent', author: { type: 'agent', displayName: 'Ada Bot' }, delivery: { state: 'delivered' } });
  });

  it('refuses to comment on its own Task or on a closed Task', async () => {
    const { admin, bundle, client, task, enableWrites } = await setup(app);
    await enableWrites();
    expect((await call(client, 'comment_on_task', { key: task.key, body: 'own' })).isError).toBe(true);
    const closed = await createTask(admin, bundle.project.id, { title: 'Closed target' });
    await moveToStatus(admin, closed.id, statusByName(bundle, 'Closed').id);
    expect((await call(client, 'comment_on_task', { key: closed.key, body: 'closed' })).isError).toBe(true);
  });

  it('assigns an agent to an unassigned Task and starts its Session', async () => {
    const { admin, bundle, client, enableWrites } = await setup(app);
    await enableWrites();
    const { agent: bob } = await createAgent(app, admin, { name: 'Bob Bot' });
    const target = await createTask(admin, bundle.project.id, { title: 'Bob starts' });

    const res = await call(client, 'start_agent', { key: target.key, agent: 'bob bot', prompt: 'Take this over.' });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ started: target.key, agent: 'Bob Bot', sessionStarted: true });
    expect((await admin.get(`/tasks/${target.id}`)).body.task.agentId).toBe(bob.id);
    const session = (await admin.get(`/tasks/${target.id}/session`)).body.session;
    expect(session).toMatchObject({ agent: { id: bob.id } });
    const items = await timeline(admin, target.id);
    const posted = items
      .flatMap((item) => (item.type === 'comment' ? [item.comment] : []))
      .filter((c) => c.body === 'Take this over.')
      .at(-1)!;
    expect(posted).toMatchObject({ kind: 'agent', author: { type: 'agent', displayName: 'Ada Bot' } });
    const { rows } = await app.server.ctx.db.$client.query('select started_agent_id from comments where id = $1', [posted.id]);
    expect(rows[0].started_agent_id).toBe(bob.id);
  });

  it('refuses its own Task, a Task of another Agent, itself and disabled Agents', async () => {
    const { admin, bundle, client, agent, task, enableWrites } = await setup(app);
    await enableWrites();
    const { agent: bob } = await createAgent(app, admin, { name: 'Bob Bot' });
    expect((await call(client, 'start_agent', { key: task.key, agent: 'Bob Bot', prompt: 'x' })).isError).toBe(true);

    const taken = await createTask(admin, bundle.project.id, { title: 'Bob has it' });
    await assignAgent(admin, taken.id, bob.id);
    expect((await call(client, 'start_agent', { key: taken.key, agent: 'Bob Bot', prompt: 'x' })).isError).toBe(false);
    const free = await createTask(admin, bundle.project.id, { title: 'Free' });
    expect((await call(client, 'start_agent', { key: free.key, agent: 'Ada Bot', prompt: 'x' })).isError).toBe(true);

    expect((await admin.patch(`/agents/${bob.id}`, { enabled: false })).status).toBe(200);
    const res = await call(client, 'start_agent', { key: free.key, agent: 'Bob Bot', prompt: 'x' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('disabled');
  });

  it('starts at most three agents per Job', async () => {
    const { admin, bundle, client, enableWrites } = await setup(app);
    await enableWrites();
    const { agent: bob } = await createAgent(app, admin, { name: 'Bob Bot' });
    for (let i = 0; i < 3; i++) {
      const target = await createTask(admin, bundle.project.id, { title: `Work ${i}` });
      expect((await call(client, 'start_agent', { key: target.key, agent: 'Bob Bot', prompt: 'go' })).isError, `start ${i}`).toBe(false);
    }
    const fourth = await createTask(admin, bundle.project.id, { title: 'Fourth' });
    const res = await call(client, 'start_agent', { key: fourth.key, agent: 'Bob Bot', prompt: 'go' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('3 agents');
    expect((await admin.get(`/tasks/${fourth.id}`)).body.task.agentId).toBeNull();
  });

  it('lists enabled agents with their state and queue', async () => {
    const { admin, client, enableWrites } = await setup(app);
    await enableWrites();
    await createAgent(app, admin, { name: 'Bob Bot' });
    const listed = (await call(client, 'list_agents')).json.agents as { name: string; state: string; queueLength: number; currentTask: unknown }[];
    expect(listed.find((a) => a.name === 'Bob Bot')).toMatchObject({ state: 'idle', queueLength: 0, currentTask: null });
  });
});

describe('Platform skill', () => {
  const app = useTestApp();

  beforeEach(async () => {
    // The test app truncates every table before each test; the backend seeds the skill at startup.
    await seedPlatformSkill(app.server.ctx);
  });

  it('seeds the catalog entry and gives it to new agents', async () => {
    const admin = await app.admin();
    const platform = (await admin.get('/skills')).body.skills.find((s: { name: string }) => s.name === 'claude-task');
    expect(platform).toMatchObject({ source: 'platform', userInvocable: true });
    expect(platform.description).toContain('Claude Task');

    const { agent } = await createAgent(app, admin, { name: 'Ada Bot' });
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.skillIds).toContain(platform.id);
  });

  it('assigns it once to agents that already existed', async () => {
    const admin = await app.admin();
    // Start from a fresh install: no platform skill in the catalog, then an Agent, then the seed.
    await app.server.ctx.db.$client.query('delete from agent_skills');
    await app.server.ctx.db.$client.query("delete from skills where name = 'claude-task'");
    const { agent } = await createAgent(app, admin, { name: 'Ada Bot' });
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.skillIds).toEqual([]);
    await seedPlatformSkill(app.server.ctx);
    const platform = (await admin.get('/skills')).body.skills.find((s: { name: string }) => s.name === 'claude-task');
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.skillIds).toContain(platform.id);
  });

  it('cannot be deleted from the catalog', async () => {
    const admin = await app.admin();
    const platform = (await admin.get('/skills')).body.skills.find((s: { name: string }) => s.name === 'claude-task');
    const res = await admin.delete(`/skills/${platform.id}`);
    expect(res.status).toBe(409);
    expect((await admin.get('/skills')).body.skills.map((s: { name: string }) => s.name)).toContain('claude-task');
  });
});

describe('Project Board Write Access setting', () => {
  const app = useTestApp();

  it('is off by default and toggles from the Agent settings', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin, { name: 'Settings' });
    expect((await admin.get(`/projects/${bundle.project.id}/agent-settings`)).body.settings.boardWriteAccess).toBe(false);
    const on = await admin.patch(`/projects/${bundle.project.id}/agent-settings`, { boardWriteAccess: true });
    expect(on.body.settings.boardWriteAccess).toBe(true);
    const off = await admin.patch(`/projects/${bundle.project.id}/agent-settings`, { boardWriteAccess: false });
    expect(off.body.settings.boardWriteAccess).toBe(false);
  });
});
