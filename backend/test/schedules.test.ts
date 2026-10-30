import { sql } from 'drizzle-orm';
import type { Comment, Schedule, ScheduleRun, Task } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { TestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { createAgent, createUser, getSession, timeline } from './helpers/fixtures';
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

    const start = await runner.next('job.start');
    expect(start.taskId ?? task.id).toBe(task.id);
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
