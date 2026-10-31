import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import type { Comment, JobStartMessage, Schedule, ScheduleRun, Task } from '@claude-task/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { TestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { createAgent, createProject, createTag, createTask, createUser, getSession, statusByName, timeline } from './helpers/fixtures';
import { Stream } from './helpers/stream';

const MINUTE = 60_000;

async function setup(app: TestApp, body: Record<string, unknown> = {}) {
  const admin = await app.admin();
  const { agent, runner } = await createAgent(app, admin, { name: 'Night Bot' });
  const created = await admin.post('/schedules', {
    name: 'Nightly review',
    agentId: agent.id,
    cron: '0 3 * * *',
    timeZone: 'Europe/Rome',
    prompt: 'Review the open pull requests.',
    ...body,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { admin, agent, runner, schedule: created.body.schedule as Schedule };
}

/** Ticks the scheduler at `at`, as the 30-second tick would. */
async function tickAt(app: TestApp, at: Date) {
  await app.server.ctx.scheduler.runSchedules(at);
  await app.settle();
}

const afterDue = (schedule: Schedule, ms = 5_000) => new Date(new Date(schedule.nextRunAt!).getTime() + ms);

const runsOf = async (admin: ApiClient, schedule: Schedule) => (await admin.get(`/schedules/${schedule.id}/runs`)).body.runs as ScheduleRun[];

describe('Schedules', () => {
  const app = useTestApp();

  it('lets Admins configure a Schedule and every User read it', async () => {
    const { admin, agent, schedule } = await setup(app);
    expect(schedule).toMatchObject({
      name: 'Nightly review',
      agentId: agent.id,
      cron: '0 3 * * *',
      timeZone: 'Europe/Rome',
      repository: null,
      readOnly: false,
      enabled: true,
      lastRun: null,
    });
    expect(new Date(schedule.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    const { client: member } = await createUser(app, admin);
    expect((await member.get('/schedules')).body.schedules).toHaveLength(1);
    expect((await member.get(`/schedules/${schedule.id}`)).status).toBe(200);
    expect((await member.get(`/schedules/${schedule.id}/runs`)).body.runs).toEqual([]);
    const body = { name: 'Other', agentId: agent.id, cron: '0 3 * * *', prompt: 'x' };
    expect((await member.post('/schedules', body)).status).toBe(403);
    expect((await member.patch(`/schedules/${schedule.id}`, { enabled: false })).status).toBe(403);
    expect((await member.post(`/schedules/${schedule.id}/run`)).status).toBe(403);
    expect((await member.delete(`/schedules/${schedule.id}`)).status).toBe(403);
  });

  it('rejects invalid Schedules without storing anything', async () => {
    const { admin, agent } = await setup(app);
    const base = { name: 'Another', agentId: agent.id, cron: '0 3 * * *', prompt: 'Go.' };
    expect((await admin.post('/schedules', { ...base, cron: '61 * * * *' })).status).toBe(400);
    expect((await admin.post('/schedules', { ...base, cron: '* * * *' })).status).toBe(400);
    expect((await admin.post('/schedules', { ...base, timeZone: 'Mars/Olympus' })).status).toBe(400);
    expect((await admin.post('/schedules', { ...base, prompt: '  ' })).status).toBe(400);
    expect((await admin.post('/schedules', { ...base, name: '' })).status).toBe(400);
    expect((await admin.post('/schedules', { ...base, agentId: crypto.randomUUID() })).status).toBe(400);
    expect((await admin.post('/schedules', { ...base, name: 'nightly REVIEW' })).status).toBe(409);
    await admin.patch(`/agents/${agent.id}`, { enabled: false });
    expect((await admin.post('/schedules', { ...base, name: 'Disabled agent' })).status).toBe(400);
    expect((await admin.get('/schedules')).body.schedules).toHaveLength(1);
  });

  it('keeps Schedule Projects out of the Projects list', async () => {
    const { admin, schedule } = await setup(app);
    expect((await admin.get('/projects')).body.projects).toEqual([]);
    expect((await admin.get(`/projects/${schedule.projectId}`)).status).toBe(404);
  });

  it('starts a run when the Schedule is due: a Task, the Agent and the prompt as the first Comment', async () => {
    const { admin, agent, runner, schedule } = await setup(app);
    await tickAt(app, new Date(new Date(schedule.nextRunAt!).getTime() - MINUTE));
    expect(await runsOf(admin, schedule)).toEqual([]);

    await tickAt(app, afterDue(schedule));
    const [run] = await runsOf(admin, schedule);
    expect(run).toMatchObject({ state: 'running', manual: false, skipReason: null });
    const task = (await admin.get(`/tasks/${run!.taskId}`)).body.task as Task;
    expect(task).toMatchObject({ agentId: agent.id, createdBy: { type: 'system' } });
    expect(task.title).toMatch(/^Nightly review · /);
    const [first] = (await timeline(admin, task.id)).filter((i) => i.type === 'comment').map((i) => (i as { comment: Comment }).comment);
    expect(first).toMatchObject({ kind: 'user', body: 'Review the open pull requests.', author: { type: 'system' } });

    await runner.next('job.start');
    const after = (await admin.get(`/schedules/${schedule.id}`)).body.schedule as Schedule;
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(afterDue(schedule).getTime());
    expect(after.lastRun?.state).toBe('running');
  });

  it('closes the run as Succeeded when its Job ends, which ends the Session', async () => {
    const { admin, runner, schedule } = await setup(app);
    await tickAt(app, afterDue(schedule));
    const s = new Stream();
    await runner.runJob([s.init(), s.text('Reviewed 3 pull requests.'), s.result()]);
    await app.settle();
    const [run] = await runsOf(admin, schedule);
    expect(run).toMatchObject({ state: 'succeeded' });
    expect(run!.finishedAt).not.toBeNull();
    expect(await getSession(admin, run!.taskId!)).toMatchObject({ state: 'closed' });
  });

  it('closes the run as Failed when its Job fails', async () => {
    const { admin, runner, schedule } = await setup(app);
    await tickAt(app, afterDue(schedule));
    const start = await runner.next('job.start');
    runner.sendJob({ type: 'job.failed', jobId: start.jobId, stage: 'setup', message: 'setup script exited with code 1' });
    await runner.drain();
    const [run] = await runsOf(admin, schedule);
    expect(run).toMatchObject({ state: 'failed' });
    expect(await getSession(admin, run!.taskId!)).toMatchObject({ state: 'closed' });
  });

  it('closes the run as Failed when the Turn ends in error', async () => {
    const { admin, runner, schedule } = await setup(app);
    await tickAt(app, afterDue(schedule));
    const s = new Stream();
    await runner.runJob([s.init(), s.text('Could not finish.'), s.result({ isError: true })]);
    await app.settle();
    expect((await runsOf(admin, schedule))[0]).toMatchObject({ state: 'failed' });
  });

  it('skips a due run while the previous one is still active, and starts again once it ended', async () => {
    const { admin, runner, schedule } = await setup(app);
    await tickAt(app, afterDue(schedule));
    const second = (await admin.get(`/schedules/${schedule.id}`)).body.schedule as Schedule;
    await tickAt(app, afterDue(second));
    let runs = await runsOf(admin, schedule);
    expect(runs.map((r) => r.state)).toEqual(['skipped', 'running']);
    expect(runs[0]).toMatchObject({ skipReason: 'previous run still active', taskId: null, taskKey: null });

    const s = new Stream();
    await runner.runJob([s.init(), s.text('Done.'), s.result()]);
    await app.settle();
    const third = (await admin.get(`/schedules/${schedule.id}`)).body.schedule as Schedule;
    expect(third.consecutiveSkips).toBe(1);
    await tickAt(app, afterDue(third));
    runs = await runsOf(admin, schedule);
    expect(runs.map((r) => r.state)).toEqual(['running', 'skipped', 'succeeded']);
    expect(((await admin.get(`/schedules/${schedule.id}`)).body.schedule as Schedule).consecutiveSkips).toBe(0);
  });

  it('starts a single catch-up run after a short delay and skips a run missed by its whole period', async () => {
    const { admin, runner, schedule } = await setup(app, { cron: '*/10 * * * *', timeZone: 'UTC' });
    // Overdue by less than the 10 minute period: one catch-up run.
    await tickAt(app, afterDue(schedule, 5 * MINUTE));
    expect((await runsOf(admin, schedule)).map((r) => r.state)).toEqual(['running']);
    const s = new Stream();
    await runner.runJob([s.init(), s.result()]);
    await app.settle();
    // The backend was down for far longer than the period: the overdue run is skipped.
    const current = (await admin.get(`/schedules/${schedule.id}`)).body.schedule as Schedule;
    await tickAt(app, afterDue(current, 3 * 60 * MINUTE));
    expect((await runsOf(admin, schedule))[0]).toMatchObject({ state: 'skipped', skipReason: 'missed' });
    const next = (await admin.get(`/schedules/${schedule.id}`)).body.schedule as Schedule;
    expect(new Date(next.nextRunAt!).getTime()).toBeGreaterThan(afterDue(current, 3 * 60 * MINUTE).getTime());
  });

  it('skips runs when the Agent is disabled', async () => {
    const { admin, agent, schedule } = await setup(app);
    expect((await admin.patch(`/agents/${agent.id}`, { enabled: false })).status).toBe(200);
    await tickAt(app, afterDue(schedule));
    expect((await runsOf(admin, schedule))[0]).toMatchObject({ state: 'skipped', skipReason: 'agent unavailable' });
    expect((await admin.post(`/schedules/${schedule.id}/run`)).status).toBe(409);
  });

  it('runs on demand without moving the next run, even while another run is active', async () => {
    const { admin, schedule } = await setup(app);
    const first = await admin.post(`/schedules/${schedule.id}/run`);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.run).toMatchObject({ state: 'running', manual: true });
    expect((await admin.post(`/schedules/${schedule.id}/run`)).status).toBe(201);
    const after = (await admin.get(`/schedules/${schedule.id}`)).body.schedule as Schedule;
    expect(after.nextRunAt).toBe(schedule.nextRunAt);
    expect(await runsOf(admin, schedule)).toHaveLength(2);
  });

  it('pauses, resumes, edits and deletes a Schedule', async () => {
    const { admin, schedule } = await setup(app);
    const paused = await admin.patch(`/schedules/${schedule.id}`, { enabled: false });
    expect(paused.body.schedule).toMatchObject({ enabled: false, nextRunAt: null });
    await tickAt(app, new Date(Date.now() + 48 * 60 * MINUTE));
    expect(await runsOf(admin, schedule)).toEqual([]);

    const edited = await admin.patch(`/schedules/${schedule.id}`, { enabled: true, cron: '30 6 * * 1', name: 'Weekly review', timeZone: 'UTC' });
    expect(edited.body.schedule).toMatchObject({ name: 'Weekly review', cron: '30 6 * * 1', timeZone: 'UTC' });
    expect(new Date(edited.body.schedule.nextRunAt).getUTCDay()).toBe(1);
    expect((await admin.patch(`/schedules/${schedule.id}`, { cron: 'nope' })).status).toBe(400);

    await admin.post(`/schedules/${schedule.id}/run`);
    const rows = await app.server.ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from tasks`);
    expect(rows.rows[0]!.n).toBe(1);
    expect((await admin.delete(`/schedules/${schedule.id}`)).status).toBe(409);
  });

  it('refuses people editing, moving or deleting the Task of a run', async () => {
    const { admin, schedule } = await setup(app);
    const run = (await admin.post(`/schedules/${schedule.id}/run`)).body.run as ScheduleRun;
    const task = (await admin.get(`/tasks/${run.taskId}`)).body.task as Task;
    expect((await admin.patch(`/tasks/${task.id}`, { version: task.version, title: 'Mine' })).status).toBe(403);
    expect((await admin.delete(`/tasks/${task.id}`)).status).toBe(403);
    expect((await admin.post(`/tasks/${task.id}/move`, { statusId: task.statusId })).status).toBe(403);
  });
});

let appUrl = '';
async function mcpClient(start: JobStartMessage): Promise<Client> {
  const server = JSON.parse(start.claudeArgs.mcpConfig).mcpServers['claude-task'];
  const url = new URL(server.url.replace('http://backend.test', appUrl));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: server.headers } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content[0]!.text;
  return { isError: res.isError ?? false, text, json: res.isError ? null : JSON.parse(text) };
}

const GLOBAL_TOOLS = ['assign_task_to_me', 'create_task_in_project', 'list_projects', 'set_task_status', 'start_task', 'update_task_by_key'];

describe('Scheduled runs and the Task Tools', () => {
  const app = useTestApp();
  beforeAll(() => {
    appUrl = app.url;
  });

  async function started(body: Record<string, unknown> = {}) {
    const ctx = await setup(app, body);
    const run = (await ctx.admin.post(`/schedules/${ctx.schedule.id}/run`)).body.run as ScheduleRun;
    const start = await ctx.runner.next('job.start');
    ctx.runner.accept(start.jobId);
    await ctx.runner.drain();
    return { ...ctx, run, start, client: await mcpClient(start) };
  }

  it('gives a global Schedule the global tools and no way to ask people', async () => {
    const { client } = await started();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...GLOBAL_TOOLS, 'get_task', 'list_tasks', 'send_files']));
    expect(names).not.toContain('ask_question');
    expect(names).not.toContain('create_survey');
  });

  it('gives a tied Schedule its own Project tools only, and no way to ask people', async () => {
    const { client } = await started({ repository: { connectionId: 'env-github', providerRepoId: '1' } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const global of GLOBAL_TOOLS) expect(names).not.toContain(global);
    expect(names).not.toContain('ask_question');
    expect(names).toContain('open_pull_request');
  });

  it('tells the Agent it works unattended, and what it can do on every board or in git', async () => {
    const global = await started({ readOnly: true });
    const prompt = global.start.claudeArgs.appendSystemPrompt;
    expect(prompt).toContain('scheduled run and you work unattended');
    expect(prompt).toContain('assign_task_to_me');
    expect(prompt).toContain('read-only for git');
    expect(prompt).not.toContain('`ask_question`');
    expect(global.start.git).toBeNull();
    expect(global.start.claudeArgs.disallowedTools).toContain('AskUserQuestion');
  });

  it('lets the scheduler, not the Agent, move and edit the Task of a run', async () => {
    const { client } = await started();
    expect((await call(client, 'set_status', { status_name: 'Succeeded' })).isError).toBe(true);
    expect((await call(client, 'update_task', { title: 'Mine' })).isError).toBe(true);
    expect((await call(client, 'create_task', { title: 'Mine' })).isError).toBe(true);
  });

  it('lets a global Agent read every board, edit Tasks, create Tasks, and assign itself and start them', async () => {
    const admin = await app.admin();
    const payments = await createProject(admin, { name: 'Payments', key: 'PAY' });
    const web = await createProject(admin, { name: 'Web', key: 'WEB' });
    await createTag(admin, web.project.id, 'bug');
    const idle = await createTask(admin, payments.project.id, { title: 'Refund flow' });
    const bug = await createTask(admin, web.project.id, { title: 'Broken footer' });
    const { runner, agent, start, client } = await started();

    const projects = await call(client, 'list_projects');
    expect(projects.json.projects.map((p: { key: string }) => p.key)).toEqual(['PAY', 'WEB']);
    expect((await call(client, 'list_tasks', { project: 'WEB' })).json.tasks.map((t: { key: string }) => t.key)).toEqual([bug.key]);
    expect((await call(client, 'list_tasks', { project: 'NOPE' })).isError).toBe(true);
    const read = await call(client, 'get_task', { key: bug.key });
    expect(read.json.task).toMatchObject({ key: bug.key, title: 'Broken footer', yours: false });
    expect(read.json.tags).toEqual(['bug']);

    expect((await call(client, 'update_task_by_key', { key: bug.key, priority: 'high', tags: ['bug'] })).isError).toBe(false);
    expect(((await admin.get(`/tasks/${bug.id}`)).body.task as Task).priority).toBe('high');
    const revisions = (await admin.get(`/tasks/${bug.id}/timeline?limit=50`)).body.items;
    expect(JSON.stringify(revisions)).toContain(agent.name);

    const doing = statusByName(web, 'In Progress');
    expect((await call(client, 'set_task_status', { key: bug.key, status_name: 'In Progress' })).isError).toBe(false);
    expect(((await admin.get(`/tasks/${bug.id}`)).body.task as Task).statusId).toBe(doing.id);
    expect((await call(client, 'set_task_status', { key: bug.key, status_name: 'Closed' })).isError).toBe(true);

    const created = await call(client, 'create_task_in_project', { project: 'PAY', title: 'Follow-up' });
    expect(created.json.created).toMatch(/^PAY-/);
    expect((await call(client, 'create_task_in_project', { project: 'ZZZ', title: 'x' })).isError).toBe(true);

    expect((await call(client, 'start_task', { key: idle.key, prompt: 'Go' })).isError).toBe(true);
    expect((await call(client, 'assign_task_to_me', { key: idle.key })).isError).toBe(false);
    expect(await getSession(admin, idle.id)).toMatchObject({ state: 'pending' });
    expect(((await admin.get(`/tasks/${idle.id}`)).body.task as Task).agentId).toBe(agent.id);
    expect((await call(client, 'start_task', { key: idle.key, prompt: 'Implement refunds.' })).isError).toBe(false);

    // The started Task runs as an ordinary Task in the same Agent's Queue, after the run's own Job.
    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [s.init(), s.text('Started PAY work.'), s.result()]);
    await runner.next('job.end', (m) => m.jobId === start.jobId);
    await runner.exit(start.jobId);
    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    expect(next.jobId).not.toBe(start.jobId);
    expect(JSON.stringify(next.initialMessage)).toContain('Implement refunds.');
  });

  it('refuses a global Agent a Task that another Agent works on, and Tasks of Wikis and Schedules', async () => {
    const admin = await app.admin();
    const board = await createProject(admin, { name: 'Payments', key: 'PAY' });
    const { agent: other } = await createAgent(app, admin, { name: 'Other Bot' });
    const task = await createTask(admin, board.project.id, { title: 'Taken' });
    await admin.patch(`/tasks/${task.id}`, { version: task.version, agentId: other.id });
    const { client, run } = await started();
    const taken = await call(client, 'assign_task_to_me', { key: task.key });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain('Other Bot');
    const own = (await admin.get(`/tasks/${run.taskId}`)).body.task as Task;
    expect((await call(client, 'update_task_by_key', { key: own.key, title: 'x' })).isError).toBe(true);
  });
});
