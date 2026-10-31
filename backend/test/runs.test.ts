import { taskTopic } from '@claude-task/shared';
import type { RunInfo, RunMessage, RunTranscript, Wiki } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { RUN_BYTES_LIMIT, RUN_CONTENT_LIMIT, RUN_MESSAGE_LIMIT, RUNS_PER_JOB, RunRegistry } from '../src/sessions/runs';
import { useTestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { assignAndStart, comment, createAgent, createProject, createTask, timeline } from './helpers/fixtures';
import { Stream } from './helpers/stream';
import { WsTestClient } from './helpers/ws';

/** The Runs traced on the Timeline, oldest first. */
async function runItems(client: ApiClient, taskId: string): Promise<RunInfo[]> {
  return (await timeline(client, taskId)).flatMap((item) => (item.type === 'agent' && item.item.payload.kind === 'run' ? [item.item.payload.run] : []));
}

const label = (m: RunMessage) => (m.type === 'text' ? `text: ${m.text}` : `tool: ${m.name} ${m.status}`);

describe('Runs', () => {
  const app = useTestApp();

  async function setup() {
    const admin = await app.admin();
    const { project } = await createProject(admin, { name: 'Payments' });
    const { agent, runner } = await createAgent(app, admin, { name: 'Ada Bot' });
    return { admin, project, agent, runner };
  }

  it('serves a running Run and its transcript, and forgets it when the Job ends', async () => {
    const { admin, project, agent, runner } = await setup();
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const ws = await WsTestClient.connect(app.url, admin.cookie);
    await ws.subscribe(taskTopic(task.id));

    const s = new Stream();
    await runner.play(start.jobId, [
      s.init(),
      s.toolUse('task1', 'Task', { description: 'Explore the repo', subagent_type: 'Explore', prompt: 'Look around' }),
      s.text('Reading the code.', 'task1'),
      s.toolUse('sub1', 'Read', { file_path: 'src/a.ts' }, 'task1'),
    ]);

    // The bar lists it, with what it has done so far.
    const listed = await admin.get(`/tasks/${task.id}/runs`);
    expect(listed.body.runs).toEqual([
      expect.objectContaining({ runType: 'subagent', description: 'Explore the repo', subagentType: 'Explore', status: 'running', toolCalls: 1 }),
    ]);
    const runId = listed.body.runs[0].id as string;

    // The Timeline keeps one row for it, and its tool call is not an Activity entry of its own.
    expect(await runItems(admin, task.id)).toEqual([expect.objectContaining({ description: 'Explore the repo', toolCalls: 1 })]);
    expect((await timeline(admin, task.id)).filter((i) => i.type === 'agent' && i.item.payload.kind === 'activity')).toEqual([]);

    // The clients hear it start, then every message of its transcript.
    await ws.next('run.message', (e) => e.runId === runId && e.message.type === 'tool');
    expect(ws.events('run.updated')[0]).toMatchObject({ taskId: task.id, run: { id: runId, description: 'Explore the repo', status: 'running' } });
    // The tool-call count updates while the Run still runs, not only when it ends.
    await ws.next('run.updated', (e) => e.run.id === runId && e.run.toolCalls === 1);
    const messages = () => ws.events('run.message').filter((e) => e.runId === runId).map((e) => e.message);
    expect(messages().map(label)).toEqual(['text: Reading the code.', 'tool: Read pending']);

    const transcript = (await admin.get(`/tasks/${task.id}/runs/${runId}`)).body as RunTranscript;
    expect(transcript).toMatchObject({ id: runId, prompt: 'Look around', truncated: false, nextIndex: 2 });
    expect(transcript.messages.map((m) => m.n)).toEqual([0, 1]);

    // The result updates the tool message in place, and the Run's own result ends it.
    await runner.play(start.jobId, [s.toolResult('sub1', 'contents', { parent: 'task1' }), s.toolResult('task1', 'Found it'), s.text('Done.'), s.result()]);
    await ws.next('run.updated', (e) => e.run.id === runId && e.run.status === 'ok');
    expect(messages().at(-1)).toMatchObject({ type: 'tool', n: 1, status: 'ok', output: 'contents' });
    // A finished Run leaves the bar, and its transcript stays readable until the Job ends.
    expect((await admin.get(`/tasks/${task.id}/runs`)).body.runs).toEqual([]);
    expect((await admin.get(`/tasks/${task.id}/runs/${runId}`)).body.messages[1]).toMatchObject({ status: 'ok', output: 'contents' });

    await runner.next('job.end', (m) => m.jobId === start.jobId);
    await runner.exit(start.jobId);
    expect((await admin.get(`/tasks/${task.id}/runs/${runId}`)).status).toBe(404);
    expect((await admin.get(`/tasks/${task.id}/runs`)).body.runs).toEqual([]);
    ws.close();
  });

  it('lists a failed Run until the Job ends and keeps its error on the Timeline', async () => {
    const { admin, project, agent, runner } = await setup();
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [
      s.init(),
      s.toolUse('task1', 'Task', { description: 'Fix the build' }),
      s.toolResult('task1', 'The build is broken beyond repair', { isError: true }),
      s.text('I could not fix it.'),
    ]);

    const failed = expect.objectContaining({ description: 'Fix the build', status: 'error', error: 'The build is broken beyond repair' });
    expect((await admin.get(`/tasks/${task.id}/runs`)).body.runs).toEqual([failed]);
    expect(await runItems(admin, task.id)).toEqual([failed]);

    await runner.play(start.jobId, [s.result()]);
    await runner.next('job.end', (m) => m.jobId === start.jobId);
    await runner.exit(start.jobId);
    expect(await runItems(admin, task.id)).toEqual([failed]);
  });

  it('serves the Runs of a Wiki Chat like a Task', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const created = await admin.post('/wikis', { name: 'Team wiki', agentId: agent.id, repository: { connectionId: 'env-github', providerRepoId: '1' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const wiki = created.body.wiki as Wiki;
    await comment(admin, wiki.taskId, 'Look around the repository.');
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.toolUse('task1', 'Task', { description: 'Read the docs' })]);

    expect((await admin.get(`/tasks/${wiki.taskId}/runs`)).body.runs).toEqual([expect.objectContaining({ description: 'Read the docs', status: 'running' })]);

    await runner.play(start.jobId, [s.toolResult('task1', 'done'), s.result()]);
    await runner.next('job.end', (m) => m.jobId === start.jobId);
    await runner.exit(start.jobId);
  });

  it("does not serve another Task's Run", async () => {
    const { admin, project, agent, runner } = await setup();
    const [one, two] = [await createTask(admin, project.id), await createTask(admin, project.id)];
    await assignAndStart(admin, one.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.toolUse('task1', 'Task', { description: 'Explore' })]);
    const runId = (await admin.get(`/tasks/${one.id}/runs`)).body.runs[0].id as string;

    expect((await admin.get(`/tasks/${two.id}/runs`)).body.runs).toEqual([]);
    expect((await admin.get(`/tasks/${two.id}/runs/${runId}`)).status).toBe(404);
  });
});

describe('the Run Registry', () => {
  const info = (over: Partial<RunInfo> = {}): RunInfo => ({
    runType: 'subagent',
    toolUseId: 'tool-1',
    description: 'Explore',
    subagentType: null,
    depth: 1,
    status: 'running',
    startedAt: '2026-10-30T10:00:00.000Z',
    finishedAt: null,
    toolCalls: 0,
    outcome: null,
    error: null,
    ...over,
  });

  it('numbers messages per Run so a snapshot and the live events merge', () => {
    const runs = new RunRegistry();
    expect(runs.create('job-1', 'task-1', 'run-1', info(), 'Look around')).toEqual({ ...info(), id: 'run-1' });
    expect(runs.message('run-1', { type: 'text', text: 'One' })).toMatchObject({ n: 0 });
    runs.message('run-1', { type: 'tool', toolUseId: 't1', name: 'Read', summary: 'Read `a`', status: 'pending', outcome: null, input: {}, output: null, childRunId: null });
    expect(runs.message('run-1', { type: 'text', text: 'Two' })).toMatchObject({ n: 2 });
    // A tool result replaces its message in place, keeping the number.
    expect(runs.toolResult('run-1', 't1', 'ok', 'ok', 'contents')).toMatchObject({ n: 1, status: 'ok', output: 'contents' });
    expect(runs.transcript('run-1')).toMatchObject({ id: 'run-1', prompt: 'Look around', truncated: false, nextIndex: 3 });
    // What the Run is doing so far, before the projector's final count arrives with `run.end`.
    expect(runs.transcript('run-1')!.run.toolCalls).toBe(1);
    expect(runs.taskOf('run-1')).toBe('task-1');
    // An unknown Run has no transcript and no Task.
    expect(runs.transcript('nope')).toBeNull();
    expect(runs.message('nope', { type: 'text', text: 'x' })).toBeNull();
    expect(runs.taskOf('nope')).toBeNull();
  });

  it('stops at 500 messages and says the transcript was cut', () => {
    const runs = new RunRegistry();
    runs.create('job-1', 'task-1', 'run-1', info(), null);
    for (let i = 0; i < RUN_MESSAGE_LIMIT; i++) expect(runs.message('run-1', { type: 'text', text: `m${i}` })).not.toBeNull();
    expect(runs.message('run-1', { type: 'text', text: 'one too many' })).toBeNull();
    expect(runs.transcript('run-1')).toMatchObject({ truncated: true, nextIndex: RUN_MESSAGE_LIMIT });
  });

  it('stops at 2 MB of messages', () => {
    const runs = new RunRegistry();
    runs.create('job-1', 'task-1', 'run-1', info(), null);
    const block = 'x'.repeat(RUN_CONTENT_LIMIT);
    let accepted = 0;
    while (runs.message('run-1', { type: 'text', text: block }) !== null) accepted++;
    expect(accepted).toBeLessThan(RUN_MESSAGE_LIMIT);
    expect((accepted + 1) * RUN_CONTENT_LIMIT).toBeGreaterThan(RUN_BYTES_LIMIT);
    expect(runs.transcript('run-1')).toMatchObject({ truncated: true, nextIndex: accepted });
  });

  it('keeps tool outputs inside the 2 MB transcript limit too', () => {
    const runs = new RunRegistry();
    runs.create('job-1', 'task-1', 'run-1', info(), null);
    const output = 'o'.repeat(RUN_CONTENT_LIMIT);
    const calls = Math.ceil(RUN_BYTES_LIMIT / RUN_CONTENT_LIMIT) + 10;
    for (let i = 0; i < calls; i++) {
      const toolUseId = `t${i}`;
      runs.message('run-1', { type: 'tool', toolUseId, name: 'Read', summary: 'Read a file', status: 'pending', outcome: null, input: {}, output: null, childRunId: null });
      runs.toolResult('run-1', toolUseId, 'ok', 'ok', output);
    }
    const transcript = runs.transcript('run-1')!;
    expect(transcript.truncated).toBe(true);
    expect(JSON.stringify(transcript.messages).length).toBeLessThanOrEqual(RUN_BYTES_LIMIT);
  });

  it('cuts the prompt and every text block at 20 KB', () => {
    const runs = new RunRegistry();
    runs.create('job-1', 'task-1', 'run-1', info(), 'p'.repeat(50_000));
    expect(runs.message('run-1', { type: 'text', text: 'y'.repeat(50_000) })).toMatchObject({ text: `${'y'.repeat(RUN_CONTENT_LIMIT)}…` });
    expect(runs.transcript('run-1')!.prompt).toBe(`${'p'.repeat(RUN_CONTENT_LIMIT)}…`);
  });

  it('keeps 30 Runs per Job, dropping the oldest finished one first', () => {
    const runs = new RunRegistry();
    // Another Job's Run is not a candidate, however old.
    runs.create('job-2', 'task-9', 'other', info({ startedAt: '2026-10-30T09:00:00.000Z' }), null);
    for (let i = 0; i < RUNS_PER_JOB; i++) runs.create('job-1', 'task-1', `run-${i}`, info({ startedAt: `2026-10-30T10:00:${String(i).padStart(2, '0')}.000Z` }), null);
    expect(runs.size).toBe(RUNS_PER_JOB + 1);

    // All running: the one that started first goes.
    runs.create('job-1', 'task-1', 'run-new', info({ startedAt: '2026-10-30T11:00:00.000Z' }), null);
    expect(runs.transcript('run-0')).toBeNull();
    expect(runs.size).toBe(RUNS_PER_JOB + 1);

    // A finished Run goes before a running one.
    runs.end('run-1', info({ status: 'ok', finishedAt: '2026-10-30T10:00:01.000Z' }), null);
    runs.create('job-1', 'task-1', 'run-newer', info({ startedAt: '2026-10-30T12:00:00.000Z' }), null);
    expect(runs.transcript('run-1')).toBeNull();
    expect(runs.transcript('run-2')).not.toBeNull();
    expect(runs.transcript('other')).not.toBeNull();
  });

  it('shows what runs now before what failed', () => {
    const runs = new RunRegistry();
    runs.create('job-1', 'task-1', 'a', info({ startedAt: '2026-10-30T10:00:00.000Z' }), null);
    runs.create('job-1', 'task-1', 'b', info({ startedAt: '2026-10-30T10:00:01.000Z' }), null);
    runs.end('a', info({ status: 'error', error: 'boom', startedAt: '2026-10-30T10:00:00.000Z' }), null);
    runs.create('job-1', 'task-1', 'c', info({ startedAt: '2026-10-30T10:00:02.000Z' }), null);
    runs.end('c', info({ status: 'ok', startedAt: '2026-10-30T10:00:02.000Z' }), null);
    expect(runs.active('job-1').map((r) => r.id)).toEqual(['b', 'a']);
    expect(runs.active('job-2')).toEqual([]);
  });

  it('drops the Runs of a Job when it ends', () => {
    const runs = new RunRegistry();
    runs.create('job-1', 'task-1', 'a', info(), null);
    runs.create('job-2', 'task-1', 'b', info(), null);
    runs.endJob('job-1');
    expect(runs.transcript('a')).toBeNull();
    expect(runs.transcript('b')).not.toBeNull();
  });
});
