import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JobStartMessage } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { TestApp } from './helpers/app';
import { assignAgent, comment, createAgent, createLabel, createProject, createTask, getSession, statusByName, timeline } from './helpers/fixtures';
import { Stream } from './helpers/stream';

/** Connects like `claude` does: the URL and bearer header from the Job's MCP config. */
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

async function setup(app: TestApp) {
  const admin = await app.admin();
  const bundle = await createProject(admin, { name: 'Payments' });
  await createLabel(admin, bundle.project.id, 'bug');
  const { agent, runner } = await createAgent(app, admin, { name: 'Ada Bot' });
  const task = await createTask(admin, bundle.project.id, { title: 'Fix login', description: '- [ ] repro' });
  const other = await createTask(admin, bundle.project.id, { title: 'Unrelated' });
  await assignAgent(admin, task.id, agent.id);
  const start = await runner.next('job.start');
  runner.accept(start.jobId);
  await runner.drain();
  return { admin, bundle, agent, runner, task, other, start, client: await mcpClient(app, start) };
}

describe('Task Tools (MCP)', () => {
  const app = useTestApp();

  it('lists the tools', async () => {
    const { client } = await setup(app);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_task', 'get_task', 'list_tasks', 'set_status', 'update_task']);
  });

  it('reads the own Task with statuses, labels and non-internal comments', async () => {
    const { admin, client, task } = await setup(app);
    await comment(admin, task.id, 'Visible to the agent');
    await comment(admin, task.id, 'Not for the agent', true);
    const { json } = await call(client, 'get_task');
    expect(json.task).toMatchObject({ key: task.key, title: 'Fix login', description: '- [ ] repro', status: 'Backlog', yours: true });
    expect(json.statuses).toContainEqual({ name: 'Closed', category: 'closed' });
    expect(json.labels).toEqual(['bug']);
    expect(json.comments.map((c: { body: string }) => c.body)).toEqual(['Visible to the agent']);
  });

  it('reading the own Task clears Unseen Changes', async () => {
    const { admin, client, task, runner, start } = await setup(app);
    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [s.init()]);
    const current = (await admin.get(`/tasks/${task.id}`)).body.task;
    await admin.patch(`/tasks/${task.id}`, { version: current.version, description: 'new spec' });
    expect((await getSession(admin, task.id))!.unseenChanges).toBe(true);
    await call(client, 'get_task');
    await app.settle();
    expect((await getSession(admin, task.id))!.unseenChanges).toBe(false);
  });

  it('pages through older comments', async () => {
    const { admin, client, task } = await setup(app);
    for (let i = 0; i < 55; i++) await comment(admin, task.id, `c${i}`);
    const first = (await call(client, 'get_task')).json;
    expect(first.comments).toHaveLength(50);
    expect(first.comments.at(-1).body).toBe('c54');
    const older = (await call(client, 'get_task', { comments_before: first.commentsBefore })).json;
    expect(older.comments.map((c: { body: string }) => c.body)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(older.commentsBefore).toBeNull();
  });

  it('reads and lists other Tasks of the same Project only', async () => {
    const { admin, client, other } = await setup(app);
    const elsewhere = await createTask(admin, (await createProject(admin)).project.id);
    expect((await call(client, 'get_task', { key: other.key })).json.task).toMatchObject({ title: 'Unrelated', yours: false });
    expect((await call(client, 'get_task', { key: elsewhere.key })).isError).toBe(true);
    const listed = (await call(client, 'list_tasks')).json.tasks;
    expect(listed.map((t: { title: string }) => t.title).sort()).toEqual(['Fix login', 'Unrelated']);
  });

  it('updates the own Task, recorded as a Revision by the Agent', async () => {
    const { admin, client, task, agent } = await setup(app);
    const res = await call(client, 'update_task', { description: '- [x] repro', labels: ['bug'], priority: 'high' });
    expect(res.isError).toBe(false);
    const updated = (await admin.get(`/tasks/${task.id}`)).body.task;
    expect(updated).toMatchObject({ description: '- [x] repro', priority: 'high', labelIds: [expect.any(String)] });
    const revision = (await timeline(admin, task.id)).filter((i) => i.type === 'revision').at(-1)!;
    expect(revision).toMatchObject({ revision: { actor: { type: 'agent', id: agent.id, displayName: 'Ada Bot' } } });

    const bad = await call(client, 'update_task', { labels: ['nope'] });
    expect(bad).toMatchObject({ isError: true, text: expect.stringContaining('No label named "nope"') });
  });

  it('moves the own Task but never to a closed Status', async () => {
    const { admin, bundle, client, task } = await setup(app);
    expect((await call(client, 'set_status', { status_name: 'ready for review' })).json).toMatchObject({ status: 'Ready for Review' });
    expect((await admin.get(`/tasks/${task.id}`)).body.task.statusId).toBe(statusByName(bundle, 'Ready for Review').id);
    const closed = await call(client, 'set_status', { status_name: 'Closed' });
    expect(closed).toMatchObject({ isError: true, text: expect.stringContaining('only humans can close tasks') });
    expect((await call(client, 'set_status', { status_name: 'Nowhere' })).text).toContain('Available: Backlog');
  });

  it('creates unassigned Tasks in the same Project, created by the Agent', async () => {
    const { admin, bundle, client, agent } = await setup(app);
    const { json } = await call(client, 'create_task', { title: 'Flaky test in CI', labels: ['bug'] });
    const tasks = (await admin.get(`/projects/${bundle.project.id}/tasks`)).body.tasks;
    const created = tasks.find((t: { key: string }) => t.key === json.created);
    expect(created).toMatchObject({ title: 'Flaky test in CI', assigneeIds: [], agentId: null, statusId: statusByName(bundle, 'Backlog').id });
    expect((await admin.get(`/tasks/${created.id}`)).body.task.createdBy).toEqual({ type: 'agent', id: agent.id, displayName: 'Ada Bot' });
  });

  it('rejects unknown tokens and tokens of finished Jobs', async () => {
    const { runner, start } = await setup(app);
    const bad = { ...start, claudeArgs: { ...start.claudeArgs, mcpConfig: JSON.stringify({ mcpServers: { 'claude-task': { url: 'http://backend.test/api/v1/mcp', headers: { Authorization: 'Bearer wrong' } } } }) } };
    await expect(mcpClient(app, bad)).rejects.toThrow();

    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [s.result()]);
    await runner.exit(start.jobId);
    await expect(mcpClient(app, start)).rejects.toThrow();
  });
});
