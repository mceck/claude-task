import type { BtwSpec, Comment, InputBlock } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from './helpers/client';
import { useTestApp } from './helpers/app';
import type { FakeRunner } from './helpers/runner';
import { assignAgent, assignAndStart, comment, createAgent, createProject, createTask, getSession, moveToStatus, statusByName, timeline } from './helpers/fixtures';
import { Stream } from './helpers/stream';

const texts = (blocks: InputBlock[] | null) => (blocks ?? []).map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');

describe('Btw and Clear', () => {
  const app = useTestApp();

  /** A started Session whose first Turn is in progress: the Job is running and `claude` has spoken. */
  async function runningTask() {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const stream = new Stream(start.sessionId);
    await runner.play(start.jobId, [stream.init(), stream.text('Working on it.')]);
    return { admin, agent, runner, project, task, start, stream };
  }

  /** The same, with the first Turn finished: the Session is idle. */
  async function idleTask() {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const stream = new Stream();
    const start = await runner.runJob([stream.init(), stream.text('First answer.'), stream.result()]);
    await app.settle();
    expect((await getSession(admin, task.id))!.state).toBe('idle');
    return { admin, agent, runner, project, task, start, stream };
  }

  const ask = (admin: ApiClient, taskId: string, question: string) => admin.post(`/tasks/${taskId}/comments`, { body: `/btw ${question}` });

  /** The fork reports its conversation and its answer, then ends. */
  async function answer(runner: FakeRunner, jobId: string, spec: BtwSpec, text: string, forkSession = 'fork-session-1') {
    const fork = new Stream(forkSession);
    for (const e of [fork.init(), fork.text(text), fork.result({ result: text, costUsd: 0.002 })]) {
      runner.sendJob({ type: 'job.btw_event', jobId, btwId: spec.id, line: JSON.stringify(e) });
    }
    runner.sendJob({ type: 'job.btw_done', jobId, btwId: spec.id, exitCode: 0, signal: null, stderr: '' });
    await runner.drain();
  }

  const btwComments = async (admin: ApiClient, taskId: string): Promise<Comment[]> =>
    (await timeline(admin, taskId)).flatMap((i) => (i.type === 'comment' && i.comment.btw ? [i.comment] : []));

  it('answers a Btw from a fork next to the running Turn, and keeps it out of the conversation', async () => {
    const { admin, runner, task, start } = await runningTask();

    const res = await ask(admin, task.id, 'what is the plan?');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const question: Comment = res.body.comment;
    expect(question).toMatchObject({ body: 'what is the plan?', kind: 'user', internal: true, delivery: null, btw: { role: 'question', working: true } });

    const { btw } = await runner.next('job.btw', (m) => m.jobId === start.jobId);
    expect(btw).toMatchObject({ mode: 'fork', sessionId: start.sessionId, question: 'what is the plan?', id: question.btw!.threadId });
    expect(btw.appendSystemPrompt).toMatch(/side question/);
    // The Job and its Queue are not touched: no Message, no interrupt, no new Job.
    expect(await runner.none('job.input')).toBe(true);
    expect(await runner.none('job.interrupt')).toBe(true);
    expect((await getSession(admin, task.id))).toMatchObject({ state: 'running', btwWorking: true });

    await answer(runner, start.jobId, btw, 'We are fixing the redirect.');
    const [asked, answered] = await btwComments(admin, task.id);
    expect(asked).toMatchObject({ id: question.id, btw: { role: 'question', working: false } });
    expect(answered).toMatchObject({ kind: 'agent', internal: true, body: 'We are fixing the redirect.', delivery: null, btw: { role: 'answer', threadId: btw.id } });
    expect((await getSession(admin, task.id))).toMatchObject({ state: 'running', btwWorking: false });

    // The Agent's own stream never saw the fork: it has no Turn, and the main Job goes on.
    const turns = (await timeline(admin, task.id)).filter((i) => i.type === 'agent' && i.item.payload.kind === 'turn_summary');
    expect(turns).toHaveLength(0);
  });

  it('continues a thread when a Comment replies to it, and starts a fresh fork for a new /btw', async () => {
    const { admin, runner, task, start } = await runningTask();
    const first = (await ask(admin, task.id, 'one?')).body.comment as Comment;
    const { btw } = await runner.next('job.btw');
    await answer(runner, start.jobId, btw, 'One.', 'fork-A');

    const reply = await admin.post(`/tasks/${task.id}/comments`, { body: 'and then?', btwThread: first.btw!.threadId });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.comment).toMatchObject({ body: 'and then?', internal: true, btw: { role: 'question', threadId: first.btw!.threadId } });
    const second = await runner.next('job.btw', (m) => m.btw.question === 'and then?');
    expect(second.btw).toMatchObject({ mode: 'resume', sessionId: 'fork-A', id: first.btw!.threadId });
    await answer(runner, start.jobId, second.btw, 'Then done.', 'fork-A');

    await ask(admin, task.id, 'something else');
    const fresh = await runner.next('job.btw', (m) => m.btw.question === 'something else');
    expect(fresh.btw).toMatchObject({ mode: 'fork', sessionId: start.sessionId });
    expect(fresh.btw.id).not.toBe(first.btw!.threadId);
  });

  it('refuses a Btw while another one works, before the Session started and once it is closed', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const bundle = await createProject(admin);
    const { project } = bundle;
    const task = await createTask(admin, project.id);
    // No Agent yet: nothing to ask.
    expect((await ask(admin, task.id, 'hello?')).status).toBe(409);
    await assignAgent(admin, task.id, agent.id);
    // Assigned but not started: a pending Session has no conversation to fork.
    expect((await ask(admin, task.id, 'hello?')).status).toBe(409);
    await comment(admin, task.id, 'Go');
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const stream = new Stream(start.sessionId);
    await runner.play(start.jobId, [stream.init(), stream.text('ok')]);

    expect((await ask(admin, task.id, 'first')).status).toBe(201);
    const busy = await ask(admin, task.id, 'second');
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toMatch(/still being answered/);
    expect((await admin.post(`/tasks/${task.id}/comments`, { body: '/btw' })).status).toBe(400);
    // A closed Task has to be reopened first.
    await runner.play(start.jobId, [stream.result()]);
    await runner.next('job.end', (m) => m.jobId === start.jobId);
    await runner.exit(start.jobId);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    const closed = await ask(admin, task.id, 'still there?');
    expect(closed.status).toBe(409);
    expect(closed.body.error.message).toMatch(/closed/);
    expect((await admin.post(`/tasks/${task.id}/comments`, { body: '/clear please' })).status).toBe(400);
  });

  it('runs a Btw of an idle Session as a Btw Job and leaves the Session as it was', async () => {
    const { admin, runner, task, start: first } = await idleTask();
    const asked = (await ask(admin, task.id, 'what did you do?')).body.comment as Comment;

    const job = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(job).toMatchObject({ mode: 'btw', sessionId: first.sessionId, git: null, setupScript: '', btw: { mode: 'fork', sessionId: first.sessionId, question: 'what did you do?', id: asked.btw!.threadId } });
    runner.accept(job.jobId);
    await answer(runner, job.jobId, job.btw!, 'I answered the first question.', 'fork-idle');
    await runner.exit(job.jobId);

    const [, answered] = await btwComments(admin, task.id);
    expect(answered).toMatchObject({ body: 'I answered the first question.', btw: { role: 'answer' } });
    const session = await getSession(admin, task.id);
    expect(session).toMatchObject({ state: 'idle', btwWorking: false, lastJob: { id: first.jobId } });
    // No Message was written, and the Session's own conversation was not resumed.
    expect(runner.messages('job.start')).toHaveLength(2);
  });

  it('turns a fork that ends without an answer into a failure notice, and the thread can try again', async () => {
    const { admin, runner, task, start } = await runningTask();
    const asked = (await ask(admin, task.id, 'will fail')).body.comment as Comment;
    const { btw } = await runner.next('job.btw');
    const fork = new Stream('fork-failed');
    runner.sendJob({ type: 'job.btw_event', jobId: start.jobId, btwId: btw.id, line: JSON.stringify(fork.init()) });
    runner.sendJob({ type: 'job.btw_done', jobId: start.jobId, btwId: btw.id, exitCode: 3, signal: null, stderr: 'boom' });
    await runner.drain();

    const [, failure] = await btwComments(admin, task.id);
    expect(failure).toMatchObject({ kind: 'system', internal: true, btw: { role: 'failure', threadId: asked.btw!.threadId } });
    expect(failure!.body).toMatch(/could not be answered.*code 3.*boom/s);
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'running', btwWorking: false });
    // It reported its conversation, so a reply can continue it.
    expect((await admin.post(`/tasks/${task.id}/comments`, { body: 'try again', btwThread: asked.btw!.threadId })).status).toBe(201);
  });

  it('fails a Btw whose Job ends before the fork answered', async () => {
    const { admin, runner, task, start } = await runningTask();
    await ask(admin, task.id, 'never answered');
    await runner.next('job.btw');
    runner.sendJob({ type: 'job.result', jobId: start.jobId, eventSeq: 1 });
    await runner.exit(start.jobId);
    const failure = (await btwComments(admin, task.id)).find((c) => c.btw!.role === 'failure');
    expect(failure?.body).toMatch(/finished before the answer/);
  });

  describe('/clear', () => {
    it('clears an idle Session at once: a new conversation, the old Comments kept, a line in the Timeline', async () => {
      const { admin, runner, task, start } = await idleTask();
      await comment(admin, task.id, 'A note from before the clear');
      await runner.runJob([new Stream().init(), new Stream().result()]);

      const res = await admin.post(`/tasks/${task.id}/comments`, { body: '/clear' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.comment).toMatchObject({ kind: 'system', clearMarker: true, body: expect.stringMatching(/cleared the chat/) });
      expect(await getSession(admin, task.id)).toMatchObject({ state: 'pending', clearPending: false });

      // Everything said before is still on the Timeline, and so is the line.
      const items = await timeline(admin, task.id);
      const bodies = items.flatMap((i) => (i.type === 'comment' ? [i.comment.body] : []));
      expect(bodies).toContain('A note from before the clear');
      expect(items.some((i) => i.type === 'comment' && i.comment.clearMarker)).toBe(true);

      // The next Comment opens a new conversation that only knows what comes after the line.
      await comment(admin, task.id, 'Fresh start please');
      const next = await runner.next('job.start', (m) => m.jobId !== start.jobId && m.mode === 'new' && m.sessionId !== start.sessionId);
      const message = texts(next.initialMessage);
      expect(message).toContain('Fresh start please');
      expect(message).not.toContain('A note from before the clear');
      expect(message).not.toContain('Please get started.');
    });

    it('waits for the running Job: Comments posted meanwhile wait for the new conversation', async () => {
      const { admin, runner, task, start, stream } = await runningTask();
      const res = await admin.post(`/tasks/${task.id}/comments`, { body: '/clear' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ comment: null, clearPending: true });
      expect(await getSession(admin, task.id)).toMatchObject({ state: 'running', clearPending: true });

      const later = await comment(admin, task.id, 'For the new conversation');
      expect(later.delivery).toMatchObject({ state: 'queued' });
      expect(await runner.none('job.input')).toBe(true);

      // The Turn ends untouched; the Clear takes effect when the Job does.
      await runner.play(start.jobId, [stream.text('Finished.'), stream.result()]);
      await runner.next('job.end', (m) => m.jobId === start.jobId);
      expect((await timeline(admin, task.id)).some((i) => i.type === 'comment' && i.comment.clearMarker)).toBe(false);
      await runner.exit(start.jobId);

      const items = await timeline(admin, task.id);
      expect(items.some((i) => i.type === 'comment' && i.comment.clearMarker)).toBe(true);
      expect(await getSession(admin, task.id)).toMatchObject({ clearPending: false });
      const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
      expect(next).toMatchObject({ mode: 'new' });
      expect(next.sessionId).not.toBe(start.sessionId);
      expect(texts(next.initialMessage)).toContain('For the new conversation');
      expect(texts(next.initialMessage)).not.toContain('Please get started.');
    });

    it('is refused when there is no conversation to clear, and ends every btw thread', async () => {
      const admin = await app.admin();
      const { agent, runner } = await createAgent(app, admin);
      const { project } = await createProject(admin);
      const task = await createTask(admin, project.id);
      expect((await admin.post(`/tasks/${task.id}/comments`, { body: '/clear' })).status).toBe(409);
      await assignAndStart(admin, task.id, agent.id);
      const stream = new Stream();
      const start = await runner.runJob([stream.init(), stream.text('hi'), stream.result()]);
      await app.settle();

      // A thread from before the Clear can no longer be continued.
      const idle = await ask(admin, task.id, 'before clear');
      const job = await runner.next('job.start', (m) => m.jobId !== start.jobId);
      runner.accept(job.jobId);
      await answer(runner, job.jobId, job.btw!, 'Before.', 'fork-old');
      await runner.exit(job.jobId);
      expect((await admin.post(`/tasks/${task.id}/comments`, { body: '/clear' })).status).toBe(201);
      expect((await admin.post(`/tasks/${task.id}/comments`, { body: '/clear' })).status).toBe(409);
      const stale = await admin.post(`/tasks/${task.id}/comments`, { body: 'more', btwThread: idle.body.comment.btw.threadId });
      expect(stale.status).toBe(409);
      // And a new /btw has nothing to fork until the new conversation has started.
      expect((await ask(admin, task.id, 'after clear')).status).toBe(409);
    });
  });
});
