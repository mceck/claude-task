import type { Comment, InputBlock, ScheduledMessage, TimelineItem } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { TestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import type { FakeRunner } from './helpers/runner';
import { assignAgent, assignAndStart, createAgent, createProject, createTask, createUser, getSession, moveToStatus, statusByName, timeline } from './helpers/fixtures';
import { Stream } from './helpers/stream';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const texts = (blocks: InputBlock[] | null) => (blocks ?? []).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
const commentsOf = (items: TimelineItem[]) => items.filter((i) => i.type === 'comment').map((i) => (i as { comment: Comment }).comment);

let agents = 0;
async function setup(app: TestApp) {
  const admin = await app.admin();
  const bundle = await createProject(admin, { name: `Payments ${++agents}` });
  const { agent, runner } = await createAgent(app, admin, { name: `Ada Bot ${agents}` });
  return { admin, bundle, project: bundle.project, agent, runner };
}

/** Plays the next new Job of the Runner to its end. */
async function playNewJob(runner: FakeRunner, known: Set<string>, events: unknown[]) {
  const start = await runner.next('job.start', (m) => !known.has(m.jobId));
  runner.accept(start.jobId);
  await runner.play(start.jobId, events as never);
  await runner.next('job.end', (m) => m.jobId === start.jobId);
  await runner.exit(start.jobId);
  return start;
}
const knownJobs = (runner: FakeRunner) => new Set(runner.messages('job.start').map((m) => m.jobId));

/** An Agent with a finished first Turn, so the Session is idle. */
async function idleTask(app: TestApp) {
  const ctx = await setup(app);
  const task = await createTask(ctx.admin, ctx.project.id);
  await assignAndStart(ctx.admin, task.id, ctx.agent.id);
  const s = new Stream();
  await ctx.runner.runJob([s.init(), s.text('On it.'), s.result()]);
  await app.settle();
  return { ...ctx, task };
}

const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const schedule = async (client: ApiClient, taskId: string, body: Record<string, unknown> = {}) => {
  const res = await client.post(`/tasks/${taskId}/scheduled-messages`, { body: 'Later', dueAt: at(2 * HOUR), ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.message as ScheduledMessage;
};
const list = async (client: ApiClient, taskId: string) => (await client.get(`/tasks/${taskId}/scheduled-messages`)).body.messages as ScheduledMessage[];
/** Ticks the scheduler at `when`, as the 30-second tick would. */
async function tick(app: TestApp, when: Date) {
  await app.server.ctx.scheduler.runSchedules(when);
  await app.settle();
}
const dueTick = (m: ScheduledMessage, ms = 1_000) => new Date(new Date(m.dueAt).getTime() + ms);

function limitTurn(resetsAt: Date, s = new Stream()) {
  return [
    s.init(),
    s.rateLimit({ status: 'rejected', resetsAt: Math.floor(resetsAt.getTime() / 1000), rateLimitType: 'five_hour' }),
    s.synthetic("You've hit your limit · resets 6pm"),
    s.result({ isError: true, result: "You've hit your limit · resets 6pm" }),
  ];
}

describe('Scheduled Messages', () => {
  const app = useTestApp();

  it('lists, edits and cancels a scheduled message, shared by every User of the Task', async () => {
    const { admin, project } = await setup(app);
    const task = await createTask(admin, project.id);
    const { client: mia } = await createUser(app, admin, { displayName: 'Mia' });
    const message = await schedule(mia, task.id, { body: 'Remind me' });
    expect(message).toMatchObject({ kind: 'user', state: 'pending', body: 'Remind me', internal: false, author: { displayName: 'Mia' }, commentId: null });
    expect((await list(admin, task.id)).map((m) => m.id)).toEqual([message.id]);
    // Scheduled messages are not Comments yet.
    expect(commentsOf(await timeline(admin, task.id))).toEqual([]);

    const newDue = at(5 * HOUR);
    const edited = await admin.patch(`/scheduled-messages/${message.id}`, { body: 'Reworded', dueAt: newDue });
    expect(edited.status).toBe(200);
    expect(edited.body.message).toMatchObject({ body: 'Reworded', dueAt: newDue.replace('Z', 'Z') });

    const cancelled = await admin.delete(`/scheduled-messages/${message.id}`);
    expect(cancelled.body.message).toMatchObject({ state: 'cancelled', cancelReason: 'Cancelled by Ada Admin' });
    expect((await admin.patch(`/scheduled-messages/${message.id}`, { body: 'x' })).status).toBe(409);
    expect((await admin.delete(`/scheduled-messages/${message.id}`)).status).toBe(409);
    expect((await admin.post(`/scheduled-messages/${message.id}/send`)).status).toBe(409);
    expect((await list(admin, task.id)).map((m) => m.state)).toEqual(['cancelled']);
  });

  it('validates the body and the due time', async () => {
    const { admin, project } = await setup(app);
    const task = await createTask(admin, project.id);
    const post = (body: Record<string, unknown>) => admin.post(`/tasks/${task.id}/scheduled-messages`, body);
    expect((await post({ body: '  ', dueAt: at(HOUR) })).status).toBe(400);
    expect((await post({ body: 'x', dueAt: at(10_000) })).status).toBe(400);
    expect((await post({ body: 'x', dueAt: at(-HOUR) })).status).toBe(400);
    expect((await post({ body: 'x', dueAt: at(400 * 24 * HOUR) })).status).toBe(400);
    expect((await post({ body: 'x', dueAt: 'tomorrow' })).status).toBe(400);
    expect((await admin.post(`/tasks/${crypto.randomUUID()}/scheduled-messages`, { body: 'x', dueAt: at(HOUR) })).status).toBe(404);
    expect(await list(admin, task.id)).toEqual([]);
    const message = await schedule(admin, task.id);
    expect((await admin.patch(`/scheduled-messages/${message.id}`, {})).status).toBe(400);
    expect((await admin.patch(`/scheduled-messages/${message.id}`, { body: ' ' })).status).toBe(400);
    expect((await admin.patch(`/scheduled-messages/${message.id}`, { dueAt: at(5_000) })).status).toBe(400);
  });

  it('publishes a due message once as a Comment of its author, delivered to the Agent', async () => {
    const { admin, agent, runner, task } = await idleTask(app);
    const { client: mia } = await createUser(app, admin, { displayName: 'Mia' });
    const message = await schedule(mia, task.id, { body: 'Please add tests.' });

    await tick(app, new Date(new Date(message.dueAt).getTime() - MINUTE));
    expect(commentsOf(await timeline(admin, task.id)).some((c) => c.body === 'Please add tests.')).toBe(false);

    await tick(app, dueTick(message));
    await tick(app, dueTick(message, 2_000));
    const published = commentsOf(await timeline(admin, task.id)).filter((c) => c.body === 'Please add tests.');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 'user', author: { displayName: 'Mia' }, internal: false });
    expect((await list(admin, task.id))[0]).toMatchObject({ state: 'sent', commentId: published[0]!.id });

    const start = await runner.next('job.start', (m) => m.mode === 'resume');
    expect(texts(start.initialMessage)).toContain('Please add tests.');
    expect(agent.id).toBeTruthy();
  });

  it('publishes a message that came due while the backend was down on the next tick', async () => {
    const { admin, task } = await idleTask(app);
    const message = await schedule(admin, task.id, { body: 'Catch up' });
    await tick(app, new Date(new Date(message.dueAt).getTime() + 6 * HOUR));
    expect(commentsOf(await timeline(admin, task.id)).some((c) => c.body === 'Catch up')).toBe(true);
  });

  it('never delivers a scheduled Internal Note to the Agent', async () => {
    const { admin, runner, task } = await idleTask(app);
    const message = await schedule(admin, task.id, { body: 'team only', internal: true });
    await tick(app, dueTick(message));
    const published = commentsOf(await timeline(admin, task.id)).find((c) => c.body === 'team only')!;
    expect(published).toMatchObject({ internal: true, delivery: null });
    expect(await runner.none('job.start', (m) => m.type === 'job.start' && m.mode === 'resume')).toBe(true);
  });

  it('publishes on a closed Task as not delivered, and on a Task without an Agent', async () => {
    const { admin, bundle, task } = await idleTask(app);
    const message = await schedule(admin, task.id, { body: 'too late' });
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    await tick(app, dueTick(message));
    const closed = commentsOf(await timeline(admin, task.id)).find((c) => c.body === 'too late')!;
    expect(closed.delivery).toMatchObject({ state: 'not_delivered', reason: 'task closed' });

    const other = await createTask(admin, bundle.project.id);
    const bare = await schedule(admin, other.id, { body: 'no agent here' });
    await tick(app, dueTick(bare));
    expect(commentsOf(await timeline(admin, other.id)).find((c) => c.body === 'no agent here')).toMatchObject({ kind: 'user', delivery: null });
  });

  it('moves the files of a scheduled message to its Comment', async () => {
    const { admin, project } = await setup(app);
    const task = await createTask(admin, project.id);
    const form = new FormData();
    form.set('body', 'see file');
    form.set('dueAt', at(HOUR));
    form.append('files', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
    const res = await admin.request('POST', `/tasks/${task.id}/scheduled-messages`, { form });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const message = res.body.message as ScheduledMessage;
    expect(message.attachments).toHaveLength(1);
    expect((await admin.get(message.attachments[0]!.url.replace('/api/v1', ''))).status).toBe(200);

    await tick(app, dueTick(message, HOUR + 1000));
    const comment = commentsOf(await timeline(admin, task.id)).find((c) => c.body === 'see file')!;
    expect(comment.attachments).toMatchObject([{ filename: 'notes.txt' }]);
    expect((await admin.get(comment.attachments[0]!.url.replace('/api/v1', ''))).status).toBe(200);
    expect((await list(admin, task.id))[0]!.attachments).toEqual([]);
  });

  it('drops the files of a cancelled message', async () => {
    const { admin, project } = await setup(app);
    const task = await createTask(admin, project.id);
    const form = new FormData();
    form.set('body', 'see file');
    form.set('dueAt', at(HOUR));
    form.append('files', new Blob(['hello']), 'notes.txt');
    const message = (await admin.request('POST', `/tasks/${task.id}/scheduled-messages`, { form })).body.message as ScheduledMessage;
    const url = message.attachments[0]!.url.replace('/api/v1', '');
    await admin.delete(`/scheduled-messages/${message.id}`);
    expect((await admin.get(url)).status).toBe(404);
  });

  it('sends now exactly once, even when the request races the tick', async () => {
    const { admin, task } = await idleTask(app);
    const message = await schedule(admin, task.id, { body: 'right now' });
    const results = await Promise.all([
      admin.post(`/scheduled-messages/${message.id}/send`),
      admin.post(`/scheduled-messages/${message.id}/send`),
      tick(app, dueTick(message, 3 * HOUR)),
    ]);
    expect([results[0], results[1]].map((r) => (r as { status: number }).status).sort()).toEqual([200, 409]);
    expect(commentsOf(await timeline(admin, task.id)).filter((c) => c.body === 'right now')).toHaveLength(1);
  });

  it('announces changes on the Task topic', async () => {
    const { admin, project } = await setup(app);
    const task = await createTask(admin, project.id);
    const hub = app.server.ctx.hub;
    const events: { type: string; message?: ScheduledMessage }[] = [];
    const publish = hub.publish.bind(hub);
    hub.publish = ((topic: string, event: { type: string }) => {
      if (topic === `task:${task.id}`) events.push(event);
      return publish(topic as never, event as never);
    }) as typeof hub.publish;
    try {
      const message = await schedule(admin, task.id);
      await admin.delete(`/scheduled-messages/${message.id}`);
    } finally {
      hub.publish = publish;
    }
    const updates = events.filter((e) => e.type === 'scheduled_message.updated');
    expect(updates.map((e) => e.message!.state)).toEqual(['pending', 'cancelled']);
  });
});

describe('Limit Resume', () => {
  const app = useTestApp();

  async function limited(automatic = false) {
    const ctx = await setup(app);
    const task = await createTask(ctx.admin, ctx.project.id);
    if (automatic) expect((await ctx.admin.put(`/tasks/${task.id}/auto-resume`, { enabled: true })).status).toBe(200);
    await assignAndStart(ctx.admin, task.id, ctx.agent.id);
    const resetsAt = new Date(Date.now() + 3 * HOUR);
    await ctx.runner.runJob(limitTurn(resetsAt));
    await app.settle();
    const offer = commentsOf(await timeline(ctx.admin, task.id)).find((c) => c.limitResume)!;
    return { ...ctx, task, resetsAt, offer };
  }

  it('offers to resume on the System Comment that reports the limit', async () => {
    const { admin, task, resetsAt, offer } = await limited();
    expect(offer).toMatchObject({ kind: 'system', body: expect.stringContaining('hit your limit') });
    expect(offer.limitResume).toMatchObject({ state: 'open', decidedBy: null, scheduledMessageId: null });
    expect(new Date(offer.limitResume!.resetsAt).getTime()).toBe(Math.floor(resetsAt.getTime() / 1000) * 1000);
    expect(await list(admin, task.id)).toEqual([]);
  });

  it('schedules the resume one minute after the reset, and the first answer decides', async () => {
    const { admin, runner, task, resetsAt, offer } = await limited();
    const { client: mia } = await createUser(app, admin, { displayName: 'Mia' });
    const answered = await mia.post(`/comments/${offer.id}/limit-resume`, { schedule: true });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.comment.limitResume).toMatchObject({ state: 'scheduled', decidedBy: { displayName: 'Mia' } });
    const [resume] = await list(admin, task.id);
    expect(resume).toMatchObject({ kind: 'limit_resume', state: 'pending', author: { type: 'system' } });
    expect(new Date(resume!.dueAt).getTime()).toBe(Math.floor(resetsAt.getTime() / 1000) * 1000 + MINUTE);
    expect(answered.body.comment.limitResume.scheduledMessageId).toBe(resume!.id);

    const late = await admin.post(`/comments/${offer.id}/limit-resume`, { schedule: false });
    expect(late.status).toBe(409);
    expect(late.body.error.message).toContain('Mia');
    expect((await admin.patch(`/scheduled-messages/${resume!.id}`, { body: 'other text' })).status).toBe(400);

    await tick(app, dueTick(resume!));
    const start = await runner.next('job.start', (m) => m.mode === 'resume');
    expect(texts(start.initialMessage)).toContain('usage limit has been reset');
    expect((await list(admin, task.id))[0]).toMatchObject({ state: 'sent' });
    expect((await getSession(admin, task.id))!.state).toMatch(/running|queued|idle/);
  });

  it('closes the offer when declined', async () => {
    const { admin, task, offer } = await limited();
    const res = await admin.post(`/comments/${offer.id}/limit-resume`, { schedule: false });
    expect(res.body.comment.limitResume).toMatchObject({ state: 'declined', decidedBy: { displayName: 'Ada Admin' } });
    expect(await list(admin, task.id)).toEqual([]);
  });

  it('schedules the resume without asking when the Task resumes automatically', async () => {
    const { admin, task, offer } = await limited(true);
    expect(offer.limitResume).toMatchObject({ state: 'scheduled', decidedBy: null });
    const [resume] = await list(admin, task.id);
    expect(resume).toMatchObject({ kind: 'limit_resume', state: 'pending' });
    expect(offer.limitResume!.scheduledMessageId).toBe(resume!.id);
  });

  it('does not offer anything when the limit has no usable reset time', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const s = new Stream();
    await runner.runJob([s.init(), s.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' }), s.synthetic('You have hit your limit'), s.result({ isError: true })]);
    await app.settle();
    const items = commentsOf(await timeline(admin, task.id));
    expect(items.some((c) => c.kind === 'system' && c.body.includes('hit your limit'))).toBe(true);
    expect(items.every((c) => c.limitResume === null)).toBe(true);
  });

  it('replaces the pending resume when a new limit reports another reset time', async () => {
    const { admin, runner, task, offer } = await limited(true);
    const [first] = await list(admin, task.id);
    // The Agent is woken by a Comment, and hits the limit again later.
    const known = knownJobs(runner);
    await admin.post(`/tasks/${task.id}/comments`, { body: 'try again' });
    await playNewJob(runner, known, limitTurn(new Date(Date.now() + 8 * HOUR)));
    await app.settle();
    const messages = await list(admin, task.id);
    expect(messages.filter((m) => m.state === 'pending')).toHaveLength(1);
    expect(messages.find((m) => m.id === first!.id)).toMatchObject({ state: 'cancelled', cancelReason: expect.stringContaining('Replaced') });
    expect(offer.id).toBeTruthy();
  });

  it('cancels the pending resume and closes the offer once the Agent worked again', async () => {
    const { admin, runner, task, offer } = await limited();
    await admin.post(`/comments/${offer.id}/limit-resume`, { schedule: true });
    const second = await limited();
    // On the first Task a User writes and the Agent answers without error.
    const known = knownJobs(runner);
    await admin.post(`/tasks/${task.id}/comments`, { body: 'continue now' });
    const s = new Stream();
    await playNewJob(runner, known, [s.init(), s.text('Back at it.'), s.result()]);
    await app.settle();
    expect((await list(admin, task.id))[0]).toMatchObject({ state: 'cancelled', cancelReason: 'The agent worked again' });
    // An offer nobody answered closes the same way.
    const knownSecond = knownJobs(second.runner);
    await admin.post(`/tasks/${second.task.id}/comments`, { body: 'continue now' });
    await playNewJob(second.runner, knownSecond, [s.init(), s.text('Back at it.'), s.result()]);
    await app.settle();
    const closed = commentsOf(await timeline(admin, second.task.id)).find((c) => c.limitResume)!;
    expect(closed.limitResume).toMatchObject({ state: 'unneeded' });
    expect((await admin.post(`/comments/${closed.id}/limit-resume`, { schedule: true })).status).toBe(409);
  });

  it('cancels the pending resume when the Task is closed or the Agent unassigned', async () => {
    const closing = await limited(true);
    await moveToStatus(closing.admin, closing.task.id, statusByName(closing.bundle, 'Closed').id);
    expect((await list(closing.admin, closing.task.id))[0]).toMatchObject({ state: 'cancelled', cancelReason: 'The task was closed' });

    const unassigning = await limited(true);
    await assignAgent(unassigning.admin, unassigning.task.id, null);
    expect((await list(unassigning.admin, unassigning.task.id))[0]).toMatchObject({ state: 'cancelled' });
  });

  it('closes an offer nobody answered once the reset has passed', async () => {
    const { admin, resetsAt, offer } = await limited();
    await tick(app, new Date(resetsAt.getTime() + 2 * MINUTE));
    const [fresh] = commentsOf(await timeline(admin, offer.taskId)).filter((c) => c.id === offer.id);
    expect(fresh!.limitResume).toMatchObject({ state: 'unneeded' });
  });

  it('copies the Project switch to new Tasks, and the Task keeps its own', async () => {
    const { admin, project } = await setup(app);
    expect((await admin.get(`/projects/${project.id}/agent-settings`)).body.settings.autoResume).toBe(false);
    const patched = await admin.patch(`/projects/${project.id}/agent-settings`, { autoResume: true });
    expect(patched.body.settings.autoResume).toBe(true);
    const task = await createTask(admin, project.id);
    expect(task.autoResume).toBe(true);
    const off = await admin.put(`/tasks/${task.id}/auto-resume`, { enabled: false });
    expect(off.body.task.autoResume).toBe(false);
    expect(off.body.task.version).toBe(task.version);
    await admin.patch(`/projects/${project.id}/agent-settings`, { autoResume: false });
    expect(((await admin.get(`/tasks/${task.id}`)).body.task).autoResume).toBe(false);
    expect((await createTask(admin, project.id)).autoResume).toBe(false);
  });
});
