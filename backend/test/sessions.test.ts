import { sql } from 'drizzle-orm';
import { taskTopic } from '@claude-task/shared';
import type { Comment, InputBlock, TimelineItem } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { TestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import {
  assignAgent, assignAndStart,
  comment,
  createAgent,
  createTag,
  createProject,
  createTask,
  createUser,
  getSession,
  moveToStatus,
  statusByName,
  timeline,
} from './helpers/fixtures';
import { FakeRunner } from './helpers/runner';
import { Stream, typicalTurn } from './helpers/stream';
import { WsTestClient } from './helpers/ws';

const texts = (blocks: InputBlock[] | null) => (blocks ?? []).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
const comments = (items: TimelineItem[]) => items.filter((i) => i.type === 'comment').map((i) => (i as { comment: Comment }).comment);

async function setup(app: TestApp) {
  const admin = await app.admin();
  const bundle = await createProject(admin, { name: 'Payments' });
  const { agent, runner } = await createAgent(app, admin, { name: 'Ada Bot' });
  return { admin, bundle, project: bundle.project, agent, runner };
}

/** Assigns the Task and plays one quiet Turn, leaving the Session idle. */
async function startAndFinish(client: ApiClient, runner: FakeRunner, taskId: string, agentId: string, stream = new Stream()) {
  await assignAndStart(client, taskId, agentId);
  return runner.runJob([stream.init(), stream.text('On it.'), stream.result()]);
}

describe('assignment and the first Job', () => {
  const app = useTestApp();

  it("doesn't start the Agent on assignment, only on the first User Comment", async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id, { title: 'Wait for me' });
    await assignAgent(admin, task.id, agent.id);
    await app.settle();
    expect(await runner.none('job.start')).toBe(true);
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'pending', queuePosition: null });
    expect((await admin.get(`/agents/${agent.id}/queue`)).body.entries).toEqual([]);

    await comment(admin, task.id, 'Go ahead.');
    const start = await runner.next('job.start');
    expect(texts(start.initialMessage)).toContain('Go ahead.');
  });

  it('starts a Job right away with the Session, configuration, credential and project env', async () => {
    const { admin, project, agent, runner } = await setup(app);
    await admin.patch(`/projects/${project.id}/agent-settings`, { setupScript: 'npm ci', agentInstructions: 'Use pnpm.' });
    await admin.put(`/projects/${project.id}/env/API_URL`, { value: 'https://staging.example.com' });
    await admin.put(`/projects/${project.id}/env/STRIPE_KEY`, { value: 'sk_test_supersecret', secret: true });
    await admin.patch(`/agents/${agent.id}`, { model: 'opus', effort: 'high', permissionMode: 'acceptEdits', systemPrompt: 'Always write tests.' });
    const tag = await createTag(admin, project.id, 'backend');
    const task = await createTask(admin, project.id, { title: 'Fix login redirect', description: 'After login we land on /.', priority: 'high', tagIds: [tag.id] });
    await comment(admin, task.id, 'It happens on Safari only.');
    await comment(admin, task.id, 'Humans only: the client is upset', true);

    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');

    const session = await getSession(admin, task.id);
    expect(start).toMatchObject({
      sessionId: session!.id,
      mode: 'new',
      resumeInterrupted: false,
      worktreePath: `worktrees/${project.id}/${task.key}`,
      setupScript: 'npm ci',
      claudeArgs: { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' },
    });
    expect(start.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret-value-1234',
      API_URL: 'https://staging.example.com',
      STRIPE_KEY: 'sk_test_supersecret',
    });
    expect(start.claudeArgs.appendSystemPrompt).toContain('You are Ada Bot');
    expect(start.claudeArgs.appendSystemPrompt).toContain(task.key);
    expect(start.claudeArgs.appendSystemPrompt).toContain('Use pnpm.');
    expect(start.claudeArgs.appendSystemPrompt).toContain('Always write tests.');
    const mcp = JSON.parse(start.claudeArgs.mcpConfig);
    expect(mcp.mcpServers['claude-task']).toMatchObject({ type: 'http', url: 'http://backend.test/api/v1/mcp' });
    expect(mcp.mcpServers['claude-task'].headers.Authorization).toMatch(/^Bearer .{20,}/);

    const message = texts(start.initialMessage);
    expect(message).toContain(`${task.key}: Fix login redirect`);
    expect(message).toContain('Priority: high');
    expect(message).toContain('Tags: backend');
    expect(message).toContain('After login we land on /.');
    expect(message).toMatch(/\[Comment by Ada Admin — \d{4}-\d\d-\d\dT[^\]]+\]\nIt happens on Safari only\./);
    expect(message).not.toContain('client is upset');

    expect(session).toMatchObject({ state: 'running', agent: { id: agent.id, name: 'Ada Bot' } });
    const [delivered, internal] = comments(await timeline(admin, task.id));
    expect(delivered!.delivery).toMatchObject({ state: 'delivered', jobId: start.jobId });
    expect(internal!.delivery).toBeNull();
  });

  it("assigns regardless of the Task's status", async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id, { statusId: statusByName(bundle, 'Ready for Review').id });
    await assignAndStart(admin, task.id, agent.id);
    expect((await runner.next('job.start')).initialMessage).toBeTruthy();
  });

  it('allows one Agent per Task and records the assignment as a Revision', async () => {
    const { admin, project, agent } = await setup(app);
    const task = await createTask(admin, project.id);
    const updated = await assignAndStart(admin, task.id, agent.id);
    expect(updated.agentId).toBe(agent.id);
    const revisions = (await timeline(admin, task.id)).filter((i) => i.type === 'revision');
    expect(revisions.at(-1)).toMatchObject({ revision: { changes: [{ field: 'agentId', before: null, after: agent.id }] } });
  });

  it('runs one Job at a time per Agent and queues the next Task', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const first = await createTask(admin, project.id, { title: 'First' });
    const second = await createTask(admin, project.id, { title: 'Second' });
    await assignAndStart(admin, first.id, agent.id);
    await assignAndStart(admin, second.id, agent.id);
    await app.settle();

    expect(runner.messages('job.start')).toHaveLength(1);
    expect(await getSession(admin, second.id)).toMatchObject({ state: 'pending', queuePosition: 1 });
    const card = (await admin.get(`/projects/${project.id}/tasks`)).body.tasks.find((t: { id: string }) => t.id === second.id);
    expect(card.session).toEqual({ agentId: agent.id, state: 'pending', queuePosition: 1 });

    const start = runner.messages('job.start')[0]!;
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.text('Done.'), s.result()]);
    await runner.next('job.end');
    expect(runner.messages('job.start')).toHaveLength(1);
    await runner.exit(start.jobId);

    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    expect(texts(next.initialMessage)).toContain('Second');
    expect(await getSession(admin, first.id)).toMatchObject({ state: 'idle', queuePosition: null });
  });

  it('waits for the Runner, then dispatches when it connects', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent } = await createAgent(app, admin, { connect: false });
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    await app.settle();
    expect((await admin.get(`/agents/${agent.id}`)).body.agent).toMatchObject({ state: 'offline', queueLength: 1 });

    const runner = await FakeRunner.connect(app, agent.id);
    await runner.next('job.start');
    expect((await admin.get(`/agents/${agent.id}`)).body.agent).toMatchObject({ state: 'working', currentTask: { id: task.id } });
  });

  it("doesn't dispatch for a disabled Agent but keeps its Queue", async () => {
    const { admin, project, agent, runner } = await setup(app);
    await admin.patch(`/agents/${agent.id}`, { enabled: false });
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    expect(await runner.none('job.start')).toBe(true);
    expect((await admin.get(`/agents/${agent.id}`)).body.agent).toMatchObject({ state: 'disabled', queueLength: 1 });

    await admin.patch(`/agents/${agent.id}`, { enabled: true });
    await runner.next('job.start');
  });
});

describe('the Agent on the Timeline', () => {
  const app = useTestApp();

  it('shows text as agent Comments, tool calls as Activity and a Turn Summary, live', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const ws = await WsTestClient.connect(app.url, admin.cookie);
    await ws.subscribe(taskTopic(task.id));
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [
      s.init(),
      s.delta('Look'),
      s.delta('ing'),
      s.thinking('The redirect probably comes from the auth middleware.'),
      s.text('Looking into it.'),
      s.toolUse('t1', 'Bash', { command: 'npm test -- auth' }),
      s.toolResult('t1', 'Exit code 1\n1 failing', { isError: true }),
      s.toolUse('t2', 'Edit', { file_path: 'src/auth.ts' }),
      s.toolResult('t2', 'ok'),
      s.text('Fixed: the middleware ignored `next`.'),
      s.text('Tests pass now.'),
      s.result({ costUsd: 0.42, durationMs: 65_000 }),
    ]);

    const deltas = ws.events('live.delta').map((e) => e.delta.text).join('');
    expect(deltas).toBe('Looking');

    const items = await timeline(admin, task.id);
    const shape = items
      .filter((i) => i.type !== 'revision')
      .map((i) => (i.type === 'comment' ? `comment:${i.comment.kind}` : i.type === 'agent' ? i.item.payload.kind : 'revision'));
    expect(shape).toEqual(['comment:user', 'thinking', 'comment:agent', 'activity', 'comment:agent', 'turn_summary']);

    const [first, second] = comments(items).filter((c) => c.kind === 'agent');
    expect(first).toMatchObject({ body: 'Looking into it.', author: { type: 'agent', id: agent.id, displayName: 'Ada Bot' } });
    expect(second!.body).toBe('Fixed: the middleware ignored `next`.\n\nTests pass now.');

    const activity = items.find((i) => i.type === 'agent' && i.item.payload.kind === 'activity') as Extract<TimelineItem, { type: 'agent' }>;
    expect(activity.item.payload).toMatchObject({
      entries: [
        { name: 'Bash', summary: 'Ran `npm test -- auth`', status: 'error', outcome: 'exit 1' },
        { name: 'Edit', summary: 'Edited `src/auth.ts`', status: 'ok' },
      ],
    });
    const summary = items.find((i) => i.type === 'agent' && i.item.payload.kind === 'turn_summary') as Extract<TimelineItem, { type: 'agent' }>;
    expect(summary.item.payload).toMatchObject({ summary: { durationMs: 65_000, toolCalls: 2, costUsd: 0.42, subtype: 'success', isError: false } });

    // Everything also arrived live.
    expect(ws.events('agent_item.created').map((e) => e.item.payload.kind)).toEqual(['thinking', 'activity', 'turn_summary']);
    expect(ws.events('comment.created').filter((e) => e.comment.kind === 'agent')).toHaveLength(2);
    ws.close();
  });

  it('records each Turn with its usage on the Job', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const start = await startAndFinish(admin, runner, task.id, agent.id);
    const { jobs } = (await admin.get(`/agents/${agent.id}/jobs`)).body;
    expect(jobs[0]).toMatchObject({ id: start.jobId, state: 'finished', turns: 1, usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 50 } });
    const usage = (await admin.get(`/agents/${agent.id}/usage`)).body;
    expect(usage.total).toMatchObject({ turns: 1, costUsd: 0.01 });
    expect(usage.byTask[0]).toMatchObject({ key: task.key, turns: 1 });
  });

  it('processes each Runner message once, even when resent', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.text('Only once.')]);
    runner.resend({ type: 'job.event', jobId: start.jobId, seq: 3, line: JSON.stringify(s.text('Only once.')) });
    await runner.next('ack', (m) => m.seq === 3);
    await app.settle();
    expect(comments(await timeline(admin, task.id)).filter((c) => c.kind === 'agent')).toHaveLength(1);
  });

  it('reports credential and API failures as System Comments naming the Credential', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [
      s.init(),
      s.apiRetry(1, 10, 'authentication_failed'),
      s.synthetic('Invalid API key · Please run /login'),
      s.result({ subtype: 'success', isError: true, result: 'Invalid API key · Please run /login' }),
    ]);
    const system = comments(await timeline(admin, task.id)).filter((c) => c.kind === 'system');
    const credentialName = (await admin.get(`/agents/${agent.id}`)).body.agent.credentialName;
    expect(system[0]!.body).toContain(`Credential **${credentialName}** was rejected`);
    expect(system.some((c) => c.body.includes('Invalid API key'))).toBe(true);
    expect(comments(await timeline(admin, task.id)).filter((c) => c.kind === 'agent')).toHaveLength(0);
  });

  it('keeps the latest rate-limit status of the Credential', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.rateLimit({ status: 'allowed_warning', utilization: 0.8 })]);
    const credential = (await admin.get(`/credentials/${agent.credentialId}`)).body.credential;
    expect(credential.rateLimit).toMatchObject({ agentId: agent.id, info: { status: 'allowed_warning', utilization: 0.8 } });
  });
});

describe('Comments reaching the Agent', () => {
  const app = useTestApp();

  it('writes a Comment to the running Job right away', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();

    const c = await comment(admin, task.id, 'Also check the logout flow.');
    const input = await runner.next('job.input');
    expect(input.jobId).toBe(start.jobId);
    expect(texts(input.message)).toMatch(/\[Comment by Ada Admin — .+\]\nAlso check the logout flow\./);
    expect(c.delivery).toMatchObject({ state: 'delivered', jobId: start.jobId });
  });

  it('never delivers Internal Notes', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();
    const note = await comment(admin, task.id, 'Between us', true);
    expect(note.delivery).toBeNull();
    expect(await runner.none('job.input')).toBe(true);
  });

  it('queues Comments for a busy Agent and delivers them merged, with authors and times', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const { client: member } = await createUser(app, admin, { displayName: 'Mia Member' });
    const busy = await createTask(admin, project.id, { title: 'Busy' });
    const other = await createTask(admin, project.id, { title: 'Other' });
    await startAndFinish(admin, runner, other.id, agent.id);
    await assignAndStart(admin, busy.id, agent.id);
    const busyJob = await runner.next('job.start', (m) => texts(m.initialMessage).includes('Busy'));
    runner.accept(busyJob.jobId);
    await runner.drain();

    const a = await comment(admin, other.id, 'First note');
    const b = await comment(member, other.id, 'Second note');
    expect(a.delivery?.state).toBe('queued');
    expect(b.delivery?.state).toBe('queued');
    expect(await getSession(admin, other.id)).toMatchObject({ state: 'idle', queuePosition: 1 });
    expect((await admin.get(`/agents/${agent.id}/queue`)).body.entries).toMatchObject([{ task: { id: other.id }, kind: 'messages', pendingMessages: 2 }]);

    const s = new Stream();
    await runner.play(busyJob.jobId, [s.text('Done'), s.result()]);
    await runner.exit(busyJob.jobId);
    const next = await runner.next('job.start', (m) => m.jobId !== busyJob.jobId && m.mode === 'resume');
    const text = texts(next.initialMessage);
    expect(text).toMatch(/\[Comment by Ada Admin — .+\]\nFirst note/);
    expect(text).toMatch(/\[Comment by Mia Member — .+\]\nSecond note/);
    expect(text.indexOf('First note')).toBeLessThan(text.indexOf('Second note'));
    const delivered = comments(await timeline(admin, other.id)).filter((c) => c.kind === 'user');
    expect(delivered.slice(-2).map((c) => c.delivery)).toEqual([
      { state: 'delivered', reason: null, jobId: next.jobId },
      { state: 'delivered', reason: null, jobId: next.jobId },
    ]);
  });

  it('ends the Job after a Turn, and queues a Comment arriving after the result at the back', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const waiting = await createTask(admin, project.id, { title: 'Waiting' });
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    await assignAndStart(admin, waiting.id, agent.id);
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.text('Done.'), s.result()]);
    await runner.next('job.end', (m) => m.jobId === start.jobId);

    const late = await comment(admin, task.id, 'One more thing');
    expect(late.delivery?.state).toBe('queued');
    expect(runner.messages('job.input')).toHaveLength(0);
    const queue = (await admin.get(`/agents/${agent.id}/queue`)).body.entries;
    expect(queue.map((e: { task: { id: string } }) => e.task.id)).toEqual([waiting.id, task.id]);
  });

  it("marks Comments not delivered once the Agent is unassigned", async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await startAndFinish(admin, runner, task.id, agent.id);
    await assignAgent(admin, task.id, null);
    const c = await comment(admin, task.id, 'Anyone there?');
    expect(c.delivery).toEqual({ state: 'not_delivered', reason: 'no agent assigned', jobId: null });
  });
});

describe('Stop, Retry and failures', () => {
  const app = useTestApp();

  it('Stop interrupts the Turn; the next Comment continues the same Session', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();

    expect((await admin.post(`/tasks/${task.id}/session/stop`)).status).toBe(200);
    await runner.next('job.interrupt', (m) => m.jobId === start.jobId);
    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [{ ...s.result({ subtype: 'error_during_execution', isError: true }), result: undefined, terminal_reason: 'aborted_tools', errors: ['[ede_diagnostic] result_type=user'] }]);
    await runner.next('job.end');
    await runner.exit(start.jobId);

    await comment(admin, task.id, 'Try the other approach instead.');
    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    expect(next).toMatchObject({ sessionId: start.sessionId, mode: 'resume' });
    expect(texts(next.initialMessage)).toContain('Try the other approach instead.');
  });

  it('refuses Stop when nothing is running', async () => {
    const { admin, project } = await setup(app);
    const task = await createTask(admin, project.id);
    expect((await admin.post(`/tasks/${task.id}/session/stop`)).status).toBe(409);
  });

  it('a failed setup posts the error and waits for Retry', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    runner.sendJob({ type: 'job.setup_output', jobId: start.jobId, chunk: 'npm ERR! missing script: ci\n' });
    runner.sendJob({ type: 'job.failed', jobId: start.jobId, stage: 'setup', message: 'setup script exited with code 1' });
    await runner.drain();

    const system = comments(await timeline(admin, task.id)).filter((c) => c.kind === 'system');
    expect(system[0]!.body).toContain('running the setup script failed');
    expect(system[0]!.body).toContain('npm ERR! missing script: ci');
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'pending', held: true, lastJob: { state: 'failed', failureStage: 'setup' } });
    expect(await runner.none('job.start', (m) => (m as { jobId: string }).jobId !== start.jobId)).toBe(true);

    expect((await admin.post(`/tasks/${task.id}/session/retry`)).status).toBe(200);
    const retry = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    expect(retry).toMatchObject({ sessionId: start.sessionId, mode: 'new' });
  });

  it("resumes a Session that `claude` created before dying silently", async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    runner.sendJob({ type: 'job.stderr', jobId: start.jobId, chunk: `Error: Session ID ${start.sessionId} is already in use.\n` });
    await runner.exit(start.jobId, 1);
    expect((await admin.post(`/tasks/${task.id}/session/retry`)).status).toBe(200);
    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    expect(next).toMatchObject({ sessionId: start.sessionId, mode: 'resume' });
  });

  it('a crashed process leaves a System Comment and the Session idle', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    runner.sendJob({ type: 'job.stderr', jobId: start.jobId, chunk: 'panic: out of memory\n' });
    const s = new Stream();
    await runner.play(start.jobId, [s.init()]);
    await runner.exit(start.jobId, 137, 'SIGKILL');
    const system = comments(await timeline(admin, task.id)).filter((c) => c.kind === 'system');
    expect(system.at(-1)!.body).toContain('stopped unexpectedly (signal SIGKILL)');
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'idle', lastJob: { state: 'failed' } });
  });
});

describe('Session lifecycle', () => {
  const app = useTestApp();

  it('closing cancels the Job, drops undelivered Comments, closes the Session and removes the Worktree', async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const other = await createTask(admin, project.id);
    await startAndFinish(admin, runner, task.id, agent.id);
    await assignAndStart(admin, other.id, agent.id);
    const busy = await runner.next('job.start', (m) => texts(m.initialMessage).includes(other.key));
    runner.accept(busy.jobId);
    await runner.drain();
    const queued = await comment(admin, task.id, 'Queued behind the other task');
    expect(queued.delivery?.state).toBe('queued');

    // Close the busy one while it runs, and the other while it waits.
    await moveToStatus(admin, other.id, statusByName(bundle, 'Closed').id);
    await runner.next('job.cancel', (m) => m.jobId === busy.jobId);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    await app.settle();

    const dropped = comments(await timeline(admin, task.id)).find((c) => c.id === queued.id)!;
    expect(dropped.delivery).toEqual({ state: 'not_delivered', reason: 'task closed', jobId: null });
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'closed', queuePosition: null });
    const removals = runner.messages('worktree.remove').map((m) => m.worktreePath);
    expect(removals).toEqual(expect.arrayContaining([`worktrees/${project.id}/${task.key}`, `worktrees/${project.id}/${other.key}`]));

    await runner.exit(busy.jobId, null, 'SIGTERM');
    expect(comments(await timeline(admin, other.id)).filter((c) => c.kind === 'system')).toHaveLength(0);
  });

  it('reopening and commenting resumes the same Session', async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const first = await startAndFinish(admin, runner, task.id, agent.id);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    await moveToStatus(admin, task.id, statusByName(bundle, 'In Progress').id);
    expect(await getSession(admin, task.id)).toMatchObject({ id: first.sessionId, state: 'idle' });
    expect(await runner.none('job.start', (m) => (m as { jobId: string }).jobId !== first.jobId)).toBe(true);

    await comment(admin, task.id, 'Reopened: the bug is back.');
    const next = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(next).toMatchObject({ sessionId: first.sessionId, mode: 'resume', worktreePath: first.worktreePath });
  });

  it('closing a Status category closes its Tasks too', async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await startAndFinish(admin, runner, task.id, agent.id);
    const status = (await admin.get(`/tasks/${task.id}`)).body.task.statusId;
    expect((await admin.patch(`/statuses/${status}`, { category: 'closed' })).status).toBe(200);
    await app.settle();
    expect((await getSession(admin, task.id))!.state).toBe('closed');
    void bundle;
  });

  it('unassigning interrupts, pauses, and reassigning another Agent starts fresh with the history', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const { agent: other, runner: otherRunner } = await createAgent(app, admin, { name: 'Bea Bot' });
    const task = await createTask(admin, project.id, { title: 'Shared work' });
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [s.init(), s.text('I found the bug in auth.ts.')]);

    await assignAndStart(admin, task.id, other.id);
    await runner.next('job.interrupt', (m) => m.jobId === start.jobId);
    await runner.next('job.end', (m) => m.jobId === start.jobId);
    const fresh = await otherRunner.next('job.start');
    expect(fresh.sessionId).not.toBe(start.sessionId);
    expect(fresh.mode).toBe('new');
    const text = texts(fresh.initialMessage);
    expect(text).toContain('Another agent worked on this task before you');
    expect(text).toMatch(/\[Comment by Ada Bot \(agent\) — .+\]\nI found the bug in auth\.ts\./);

    // The first Agent's process finishes; its paused Session stays paused.
    await runner.play(start.jobId, [s.result()]);
    await runner.exit(start.jobId);
    const sessions = (await admin.get(`/tasks/${task.id}/session`)).body.session;
    expect(sessions).toMatchObject({ agent: { id: other.id }, state: 'running' });
  });

  it('reassigning back to the original Agent resumes its paused Session with what was said meanwhile', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const { agent: other, runner: otherRunner } = await createAgent(app, admin, { name: 'Bea Bot' });
    const task = await createTask(admin, project.id);
    const first = await startAndFinish(admin, runner, task.id, agent.id);
    await assignAndStart(admin, task.id, other.id);
    const bea = new Stream();
    await otherRunner.runJob([bea.init(), bea.text('Bea here: tried a cache fix.'), bea.result()]);
    await comment(admin, task.id, 'Bea, that broke staging.');

    await assignAndStart(admin, task.id, agent.id);
    const resumed = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    expect(resumed).toMatchObject({ sessionId: first.sessionId, mode: 'resume' });
    const text = texts(resumed.initialMessage);
    expect(text).toContain('Bea here: tried a cache fix.');
    expect(text).toContain('Bea, that broke staging.');
    expect(text).not.toContain('On it.');
  });

  it('a container restart mid-Turn resumes the interrupted Turn from the front of the Queue', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const waiting = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    await assignAndStart(admin, waiting.id, agent.id);
    runner.accept(start.jobId);
    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [s.init(), s.toolUse('t1', 'Bash', { command: 'npm run build' })]);

    // The container restarts: a new Runner process says hello without the Job.
    await runner.close();
    const restarted = await FakeRunner.connect(app, agent.id, { activeJobId: null });
    const resumed = await restarted.next('job.start');
    expect(resumed).toMatchObject({ sessionId: start.sessionId, mode: 'resume', resumeInterrupted: true });
    expect(resumed.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe('1');
    expect(texts(resumed.initialMessage)).toContain('continue where you left off');
    const system = comments(await timeline(admin, task.id)).filter((c) => c.kind === 'system');
    expect(system.at(-1)!.body).toContain('restarted in the middle of a turn');
    const jobs = (await admin.get(`/agents/${agent.id}/jobs`)).body.jobs;
    expect(jobs.find((j: { id: string }) => j.id === start.jobId).state).toBe('interrupted');
  });

  it('a Runner reconnecting with its Job keeps it and resends from the last ack', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [s.init(), s.text('Before the blip.')]);
    await runner.close();

    const back = await FakeRunner.connect(app, agent.id, { activeJobId: start.jobId });
    expect(await back.next('ack', (m) => m.jobId === start.jobId)).toMatchObject({ seq: 3 });
    back.resend({ type: 'job.event', jobId: start.jobId, seq: 3, line: JSON.stringify(s.text('Before the blip.')) });
    back.resend({ type: 'job.event', jobId: start.jobId, seq: 4, line: JSON.stringify(s.text('After the blip.')) });
    await back.next('ack', (m) => m.seq === 4);
    await app.settle();
    const agentComments = comments(await timeline(admin, task.id)).filter((c) => c.kind === 'agent');
    expect(agentComments.map((c) => c.body)).toEqual(['Before the blip.\n\nAfter the blip.']);
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'running' });
  });

  // Deleting would drop the Job's row while `claude` keeps running with the Task's secrets,
  // and the Runner would refuse every later Job of the Agent as "another job is running".
  it('refuses deleting a Task, or its Project, while a Job works on it', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const member = await createUser(app, admin, { role: 'member' });
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();

    const refused = await member.client.delete(`/tasks/${task.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/stop/i);
    expect((await admin.post(`/projects/${project.id}/archive`)).status).toBe(200);
    expect((await admin.delete(`/projects/${project.id}`)).status).toBe(409);
    expect((await admin.get(`/tasks/${task.id}`)).status).toBe(200);

    await runner.exit(start.jobId);
    expect((await member.client.delete(`/tasks/${task.id}`)).status).toBe(204);
    expect((await admin.delete(`/projects/${project.id}`)).status).toBe(204);
  });
});

describe('the Queue', () => {
  const app = useTestApp();

  it('members reorder entries and remove them; removed Comments become not delivered', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const { client: member } = await createUser(app, admin);
    const [busy, a, b, c] = await Promise.all(['Busy', 'A', 'B', 'C'].map((title) => createTask(admin, project.id, { title })));
    await assignAndStart(admin, busy!.id, agent.id);
    await runner.next('job.start');
    for (const t of [a!, b!, c!]) await assignAndStart(admin, t.id, agent.id);

    let entries = (await member.get(`/agents/${agent.id}/queue`)).body.entries;
    expect(entries.map((e: { task: { title: string } }) => e.task.title)).toEqual(['A', 'B', 'C']);
    const moved = await member.post(`/agents/${agent.id}/queue/${entries[2].id}/move`, { afterEntryId: null });
    expect(moved.body.entries.map((e: { task: { title: string } }) => e.task.title)).toEqual(['C', 'A', 'B']);
    expect(await getSession(member, c!.id)).toMatchObject({ queuePosition: 1 });

    // Start entries can't be removed; messages entries can.
    expect((await member.delete(`/agents/${agent.id}/queue/${entries[0].id}`)).status).toBe(400);
    void runner;
    entries = (await member.get(`/agents/${agent.id}/queue`)).body.entries;
    expect(entries.every((e: { kind: string }) => e.kind === 'start')).toBe(true);
  });

  it('removing a messages entry marks its Comments not delivered', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const busy = await createTask(admin, project.id);
    await startAndFinish(admin, runner, task.id, agent.id);
    await assignAndStart(admin, busy.id, agent.id);
    await runner.next('job.start', (m) => texts(m.initialMessage).includes(busy.key));
    const c = await comment(admin, task.id, 'Low priority remark');
    const [entry] = (await admin.get(`/agents/${agent.id}/queue`)).body.entries;
    expect((await admin.delete(`/agents/${agent.id}/queue/${entry.id}`)).status).toBe(204);
    const after = comments(await timeline(admin, task.id)).find((x) => x.id === c.id)!;
    expect(after.delivery).toEqual({ state: 'not_delivered', reason: 'removed from queue', jobId: null });
  });
});

describe('Notify agent', () => {
  const app = useTestApp();

  it('shows unseen human edits and delivers a diff; the banner clears once delivered', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id, { title: 'Old title', description: 'line one\nline two\n' });
    await startAndFinish(admin, runner, task.id, agent.id);
    expect((await getSession(admin, task.id))!.unseenChanges).toBe(false);

    const current = (await admin.get(`/tasks/${task.id}`)).body.task;
    await admin.patch(`/tasks/${task.id}`, { version: current.version, title: 'New title', description: 'line one\nline 2\n' });
    expect((await getSession(admin, task.id))!.unseenChanges).toBe(true);

    expect((await admin.post(`/tasks/${task.id}/session/notify`)).status).toBe(200);
    const next = await runner.next('job.start', (m) => m.mode === 'resume');
    const text = texts(next.initialMessage);
    expect(text).toContain('Title: "Old title" → "New title"');
    expect(text).toContain('-line two');
    expect(text).toContain('+line 2');
    expect((await getSession(admin, task.id))!.unseenChanges).toBe(false);
    const notice = comments(await timeline(admin, task.id)).find((c) => c.kind === 'system')!;
    expect(notice.body).toBe('Ada Admin notified the agent of task changes.');
    expect(notice.delivery?.state).toBe('delivered');
  });

  it("ignores the Agent's own edits and status changes", async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await startAndFinish(admin, runner, task.id, agent.id);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Ready for Review').id);
    expect((await getSession(admin, task.id))!.unseenChanges).toBe(false);
    expect((await admin.post(`/tasks/${task.id}/session/notify`)).status).toBe(409);
  });
});

// Regression coverage for the Runner's public transport boundary.
describe('Runner output and attachment isolation', () => {
  const app = useTestApp();

  it('accepts large raw tool results while keeping the displayed output compact', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [s.toolUse('large-result', 'Bash', { command: 'npm test' }), s.toolResult('large-result', 'x'.repeat(128 * 1024) + 'END_OF_OUTPUT'), s.result()]);
    const item = (await timeline(admin, task.id)).find((i) => i.type === 'agent' && i.item.payload.kind === 'activity');
    expect(item?.type).toBe('agent');
    if (item?.type !== 'agent' || item.item.payload.kind !== 'activity') throw new Error('missing activity');
    expect(item.item.payload.entries[0]!.status).toBe('ok');
    expect(item.item.payload.entries[0]!.output).toContain('truncated');
    expect(item.item.payload.entries[0]!.output!.length).toBeLessThan(21 * 1024);
    await runner.exit(start.jobId);
  });

  it('serves public comment attachments to the active runner and refuses internal note attachments', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const upload = async (internal: boolean) => {
      const form = new FormData();
      form.set('body', 'Attachment');
      form.set('internal', String(internal));
      form.append('files', new Blob(['attachment contents']), 'log.txt');
      const res = await admin.request('POST', `/tasks/${task.id}/comments`, { form });
      expect(res.status).toBe(201);
      return res.body.comment.attachments[0].id as string;
    };
    const visible = await upload(false);
    const internal = await upload(true);
    const opts = { headers: { authorization: `Bearer ${FakeRunner.token(app, agent.id)}` } };
    expect((await app.client().get(`/runner/attachments/${visible}`, opts)).status).toBe(200);
    expect((await app.client().get(`/runner/attachments/${internal}`, opts)).status).toBe(404);
  });
  describe('files in the task description', () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const uploadToTask = async (admin: ApiClient, taskId: string, name: string, type: string, data: Buffer | string) => {
      const form = new FormData();
      form.append('files', new Blob([data], { type }), name);
      const res = await admin.request('POST', `/tasks/${taskId}/attachments`, { form });
      expect(res.status).toBe(201);
      return res.body.attachments[0] as { id: string; url: string; commentId: string | null };
    };

    it('stores uploads on the task, serves them to users and hands them to the agent on start', async () => {
      const { admin, project, agent, runner } = await setup(app);
      const task = await createTask(admin, project.id);
      const image = await uploadToTask(admin, task.id, 'mock.png', 'image/png', PNG);
      const doc = await uploadToTask(admin, task.id, 'spec.pdf', 'application/pdf', 'pdf bytes');
      expect(image.commentId).toBeNull();
      expect((await admin.get(image.url.replace('/api/v1', ''))).status).toBe(200);

      const description = `See ![mock](${image.url}) and [the spec](${doc.url}).`;
      expect((await admin.patch(`/tasks/${task.id}`, { version: task.version, description })).status).toBe(200);
      await assignAndStart(admin, task.id, agent.id);
      const start = await runner.next('job.start');

      const message = texts(start.initialMessage);
      expect(message).toContain(description);
      expect(message).toContain(`\`${image.url}\` → \`.claude-task/attachments/${image.id}/mock.png\``);
      expect(message).toContain(`\`${doc.url}\` → \`.claude-task/attachments/${doc.id}/spec.pdf\``);
      expect((start.initialMessage as InputBlock[]).some((b) => b.type === 'image')).toBe(true);
      expect(start.attachmentsToFetch.map((f: { path: string }) => f.path).sort()).toEqual([
        `.claude-task/attachments/${doc.id}/spec.pdf`,
        `.claude-task/attachments/${image.id}/mock.png`,
      ].sort());

      const opts = { headers: { authorization: `Bearer ${FakeRunner.token(app, agent.id)}` } };
      expect((await app.client().get(`/runner/attachments/${doc.id}`, opts)).status).toBe(200);
      await runner.exit(start.jobId);
    });

    it('removes old uploads the description no longer links to when more are uploaded', async () => {
      const { admin, project } = await setup(app);
      const task = await createTask(admin, project.id);
      const kept = await uploadToTask(admin, task.id, 'kept.png', 'image/png', PNG);
      const dropped = await uploadToTask(admin, task.id, 'dropped.png', 'image/png', PNG);
      const fresh = await uploadToTask(admin, task.id, 'fresh.png', 'image/png', PNG);
      expect((await admin.patch(`/tasks/${task.id}`, { version: task.version, description: `![kept](${kept.url})` })).status).toBe(200);
      await app.server.ctx.db.execute(sql`update attachments set created_at = now() - interval '2 days' where id in (${kept.id}::uuid, ${dropped.id}::uuid)`);
      await uploadToTask(admin, task.id, 'next.png', 'image/png', PNG);
      expect((await admin.get(kept.url.replace('/api/v1', ''))).status).toBe(200);
      expect((await admin.get(dropped.url.replace('/api/v1', ''))).status).toBe(404);
      expect((await admin.get(fresh.url.replace('/api/v1', ''))).status).toBe(200);
    });

    it('only serves them to the runner of an agent working on the task', async () => {
      const { admin, project, agent, runner } = await setup(app);
      const task = await createTask(admin, project.id);
      const other = await createTask(admin, project.id);
      const file = await uploadToTask(admin, other.id, 'a.txt', 'text/plain', 'x');
      await assignAndStart(admin, task.id, agent.id);
      const start = await runner.next('job.start');
      runner.accept(start.jobId);
      const opts = { headers: { authorization: `Bearer ${FakeRunner.token(app, agent.id)}` } };
      expect((await app.client().get(`/runner/attachments/${file.id}`, opts)).status).toBe(404);
    });

    it('removes the files with the task', async () => {
      const { admin, project } = await setup(app);
      const task = await createTask(admin, project.id);
      const file = await uploadToTask(admin, task.id, 'a.txt', 'text/plain', 'x');
      expect((await admin.delete(`/tasks/${task.id}`)).status).toBe(204);
      expect((await admin.get(file.url.replace('/api/v1', ''))).status).toBe(404);
    });
  });
});
