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
  createCredential,
  createTag,
  createProject,
  createTask,
  createUser,
  getSession,
  moveToStatus,
  statusByName,
  timeline,
} from './helpers/fixtures';
import { recoverAbandonedJobs } from '../src/runner/handlers';
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

  it('passes an Anthropic auth token as ANTHROPIC_AUTH_TOKEN', async () => {
    const admin = await app.admin();
    const credential = await createCredential(admin, { kind: 'anthropic_auth_token', secret: 'sk-or-v1-secret-1234' });
    const { project } = await createProject(admin);
    const { agent, runner } = await createAgent(app, admin, { credentialId: credential.id });
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    expect(start.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-secret-1234' });
  });

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
    await admin.put(`/projects/${project.id}/env/ANTHROPIC_MODEL`, { value: 'project-model' });
    await admin.put(`/projects/${project.id}/env/ENABLE_TOOL_SEARCH`, { value: 'true' });
    await admin.patch(`/agents/${agent.id}`, {
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      systemPrompt: 'Always write tests.',
      env: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_MODEL: 'agent-model',
        ENABLE_TOOL_SEARCH: 'false',
      },
    });
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
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      // The Agent's environment is more specific than the Project's.
      ANTHROPIC_MODEL: 'agent-model',
      ENABLE_TOOL_SEARCH: 'false',
    });
    expect(start.claudeArgs.appendSystemPrompt).toContain('You are Ada Bot');
    expect(start.claudeArgs.appendSystemPrompt).toContain(task.key);
    expect(start.claudeArgs.appendSystemPrompt).toContain('Use pnpm.');
    expect(start.claudeArgs.appendSystemPrompt).toContain('Always write tests.');
    expect(start.claudeArgs.appendSystemPrompt).toContain('- PostgreSQL: 127.0.0.1:5432');
    expect(start.claudeArgs.appendSystemPrompt).toContain('- Redis: 127.0.0.1:6379');
    expect(start.claudeArgs.appendSystemPrompt).not.toContain('MySQL');
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

  it('carries the context the latest Turn left, and none before the first', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const start = await startAndFinish(admin, runner, task.id, agent.id);
    const session = await getSession(admin, task.id);
    // The Stream's assistant message reports 10 input and 5 output tokens; the result names a 1M window.
    expect(session).toMatchObject({ id: start.sessionId, state: 'idle', context: { tokens: 15, window: 1_000_000 } });

    // A Session that has not run a Turn yet has no context to show.
    const other = await createTask(admin, project.id);
    await assignAndStart(admin, other.id, agent.id);
    await app.settle();
    expect(await getSession(admin, other.id)).toMatchObject({ state: 'running', context: null });
  });

  it('keeps the last measured context when a later Turn reports none', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const start = await startAndFinish(admin, runner, task.id, agent.id);
    await comment(admin, task.id, 'Continue.');
    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    runner.accept(next.jobId);
    // A result with no assistant message before it says nothing about the context.
    await runner.play(next.jobId, [new Stream(next.sessionId).result({ subtype: 'error_during_execution', isError: true })]);
    await runner.next('job.end', (m) => m.jobId === next.jobId);
    await runner.exit(next.jobId);
    expect(await getSession(admin, task.id)).toMatchObject({ context: { tokens: 15, window: 1_000_000 } });
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
    // The Board card sums the Task's Turns: the two calls of this one are on it.
    expect((await admin.get(`/tasks/${task.id}`)).body.task.toolCallCount).toBe(2);

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

  it('marks every delivered Comment handled when a Turn of the Session ends, live', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id, 'Start here.');
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();
    const ws = await WsTestClient.connect(app.url, admin.cookie);
    await ws.subscribe(taskTopic(task.id));
    const steer = await comment(admin, task.id, 'Also check the logout flow.');
    await runner.next('job.input');
    const delivered = comments(await timeline(admin, task.id)).filter((c) => c.kind === 'user');
    expect(delivered.map((c) => c.delivery?.state)).toEqual(['delivered', 'delivered']);
    expect(delivered.every((c) => typeof c.delivery?.at === 'string')).toBe(true);

    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.text('Done'), s.result()]);
    await app.settle();
    const live = await ws.next('comment.updated', (e) => e.comment.id === steer.id && e.comment.delivery?.state === 'handled');
    expect(live.event.comment.delivery).toMatchObject({ jobId: start.jobId });
    const handled = comments(await timeline(admin, task.id)).filter((c) => c.kind === 'user');
    expect(handled.map((c) => c.delivery?.state)).toEqual(['handled', 'handled']);
    expect(Date.parse(handled[1]!.delivery!.at!)).toBeGreaterThanOrEqual(Date.parse(delivered[1]!.delivery!.at!));
    ws.close();
  });

  it('leaves a Comment written after the Turn last called the model for the Turn that reads it', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.toolUse('tool-1', 'Bash', { command: 'npm test' }), s.toolResult('tool-1', 'ok'), s.text('Almost done')]);
    await app.settle();
    const late = await comment(admin, task.id, 'One more thing');
    await runner.next('job.input');
    await runner.play(start.jobId, [s.result()]);
    await app.settle();
    const states = async () => Object.fromEntries(comments(await timeline(admin, task.id)).filter((c) => c.kind === 'user').map((c) => [c.body, c.delivery?.state]));
    expect(await states()).toEqual({ 'Please get started.': 'handled', 'One more thing': 'delivered' });
    await runner.play(start.jobId, [s.text('Done that too'), s.result()]);
    await app.settle();
    expect((await states())[late.body]).toBe('handled');
  });

  it('counts a stopped Turn as handling its Comments', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), { ...s.result({ isError: true, subtype: 'error_during_execution' }), terminal_reason: 'aborted_streaming' }]);
    await app.settle();
    expect(comments(await timeline(admin, task.id)).filter((c) => c.kind === 'user').map((c) => c.delivery?.state)).toEqual(['handled']);
  });

  it('counts a failed Turn as handling its Comments, and leaves queued ones alone', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const other = await createTask(admin, project.id, { title: 'Other' });
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();
    await assignAgent(admin, other.id, agent.id);
    const waiting = await comment(admin, other.id, 'Waiting for the agent');
    expect(waiting.delivery?.state).toBe('queued');
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.result({ isError: true, subtype: 'error_during_execution' })]);
    await app.settle();
    expect(comments(await timeline(admin, task.id)).filter((c) => c.kind === 'user').map((c) => c.delivery?.state)).toEqual(['handled']);
    expect(comments(await timeline(admin, other.id)).filter((c) => c.kind === 'user').map((c) => c.delivery?.state)).toEqual(['queued']);
  });

  it('requeues a Comment when the mid-Turn write finds the Runner socket closed', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.play(start.jobId, [new Stream(start.sessionId).init()]);

    const hub = app.server.ctx.runners;
    const send = hub.send.bind(hub);
    let refused = false;
    hub.send = ((agentId: string, message: Parameters<typeof hub.send>[1]) => {
      if (message.type === 'job.input') {
        refused = true;
        return false;
      }
      return send(agentId, message);
    }) as typeof hub.send;
    try {
      const lost = await comment(admin, task.id, 'This must not be lost.');
      expect(refused).toBe(true);
      for (let i = 0; i < 100; i++) {
        const stored = comments(await timeline(admin, task.id)).find((c) => c.id === lost.id);
        if (stored?.delivery?.state === 'queued') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const stored = comments(await timeline(admin, task.id)).find((c) => c.id === lost.id)!;
      expect(stored.delivery).toMatchObject({ state: 'queued' });
      expect((await admin.get(`/agents/${agent.id}/queue`)).body.entries).toHaveLength(1);
    } finally {
      hub.send = send;
      await runner.exit(start.jobId);
    }
  });

  it('serializes an unsent mid-Turn Comment with closing its Task', async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.play(start.jobId, [new Stream(start.sessionId).init()]);
    const { db, runners } = app.server.ctx;
    const send = runners.send.bind(runners);
    runners.send = (id, message) => message.type === 'job.input' ? false : send(id, message);
    const gate = await db.$client.connect();
    let moving: ReturnType<typeof admin.post> | undefined;
    try {
      // Pause the Queue write at the database boundary while the public move request
      // arrives. This exercises the real transaction locks and foreign keys.
      await gate.query('select pg_advisory_lock(93652)');
      await db.execute(sql`create function hold_queue_insert() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(93652); return new; end $$`);
      await db.execute(sql`create trigger hold_queue_insert before insert on queue_entries
        for each row execute function hold_queue_insert()`);
      await comment(admin, task.id, 'Recover this Comment while the Task closes.');
      await expect.poll(async () => (await db.execute(sql`select 1 from pg_stat_activity
        where datname = current_database() and wait_event = 'advisory'
        and query like 'insert into "queue_entries"%'`)).rowCount).toBe(1);
      moving = admin.post(`/tasks/${task.id}/move`, { statusId: statusByName(bundle, 'Closed').id });
      await expect.poll(async () => (await db.execute(sql`select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and wait_event <> 'advisory'`)).rowCount).toBe(1);
      await gate.query('select pg_advisory_unlock(93652)');
      expect((await moving).status).toBe(200);
      expect((await getSession(admin, task.id))?.state).toBe('closed');
      expect((await admin.get(`/agents/${agent.id}/queue`)).body.entries).toHaveLength(0);
    } finally {
      await gate.query('select pg_advisory_unlock_all()');
      gate.release();
      runners.send = send;
      await moving;
      await db.execute(sql`drop trigger if exists hold_queue_insert on queue_entries`);
      await db.execute(sql`drop function if exists hold_queue_insert()`);
      await runner.exit(start.jobId);
    }
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
      { state: 'delivered', reason: null, jobId: next.jobId, at: expect.any(String) },
      { state: 'delivered', reason: null, jobId: next.jobId, at: expect.any(String) },
    ]);
  });

  it('ends the Job after a Turn, and queues a Comment arriving after the result for the running Task at the front', async () => {
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

    // The Turn is over, so the Comment can't go to stdin; the Task the Agent was working on
    // still keeps priority over the other Task waiting in the Queue.
    const late = await comment(admin, task.id, 'One more thing');
    expect(late.delivery?.state).toBe('queued');
    expect(runner.messages('job.input')).toHaveLength(0);
    const queue = (await admin.get(`/agents/${agent.id}/queue`)).body.entries;
    expect(queue.map((e: { task: { id: string } }) => e.task.id)).toEqual([task.id, waiting.id]);
  });

  it('queues a Comment for the Task being dispatched ahead of the other Tasks waiting', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const waiting = await createTask(admin, project.id, { title: 'Waiting' });
    // Dispatched but not accepted yet: worktree preparation and container start can take a while.
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    await assignAndStart(admin, waiting.id, agent.id);
    expect(await getSession(admin, waiting.id)).toMatchObject({ queuePosition: 1 });

    const c = await comment(admin, task.id, 'While you set up, also check Safari.');
    expect(c.delivery?.state).toBe('queued');
    const queue = (await admin.get(`/agents/${agent.id}/queue`)).body.entries;
    expect(queue.map((e: { task: { id: string }; pendingMessages: number }) => [e.task.id, e.pendingMessages])).toEqual([
      [task.id, 1],
      [waiting.id, 1],
    ]);

    // After the running Task's Job, the steering Comment comes before the waiting Task.
    runner.accept(start.jobId);
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.text('Done.'), s.result()]);
    await runner.next('job.end', (m) => m.jobId === start.jobId);
    await runner.exit(start.jobId);
    const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    expect(next.sessionId).toBe(start.sessionId);
    expect(texts(next.initialMessage)).toContain('While you set up, also check Safari.');
  });

  it("marks Comments not delivered once the Agent is unassigned", async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await startAndFinish(admin, runner, task.id, agent.id);
    await assignAgent(admin, task.id, null);
    const c = await comment(admin, task.id, 'Anyone there?');
    expect(c.delivery).toEqual({ state: 'not_delivered', reason: 'no agent assigned', jobId: null, at: expect.any(String) });
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

  it('marks a Session whose conversation disappeared as pending, not idle', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const first = await startAndFinish(admin, runner, task.id, agent.id);
    await comment(admin, task.id, 'Try the next step.');
    const second = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    runner.accept(second.jobId);
    runner.sendJob({ type: 'job.stderr', jobId: second.jobId, chunk: 'No conversation found with session ID: missing\n' });
    await runner.exit(second.jobId, 0);

    expect(await getSession(admin, task.id)).toMatchObject({ state: 'pending', lastJob: { state: 'finished' } });
    await comment(admin, task.id, 'Start a fresh conversation.');
    const next = await runner.next('job.start', (m) => m.jobId !== first.jobId && m.jobId !== second.jobId);
    expect(next).toMatchObject({ mode: 'new' });
    expect(texts(next.initialMessage)).toContain('Start a fresh conversation.');
  });

  it('stays quiet when a cancelled Job reports a missing conversation', async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const first = await startAndFinish(admin, runner, task.id, agent.id);
    await comment(admin, task.id, 'Start a Turn.');
    const running = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    runner.accept(running.jobId);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    await runner.next('job.cancel', (m) => m.jobId === running.jobId);
    runner.sendJob({ type: 'job.stderr', jobId: running.jobId, chunk: 'No conversation found with session ID: missing\n' });
    await runner.exit(running.jobId, 0);

    expect(comments(await timeline(admin, task.id)).filter((c) => c.kind === 'system' && c.body.includes("wasn't found"))).toEqual([]);
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'closed' });
  });

  it('a crashed process leaves a System Comment and the Session idle', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    runner.sendJob({ type: 'job.stderr', jobId: start.jobId, chunk: 'panic: out of memory\n' });
    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.toolUse('t1', 'Bash', { command: 'npm install' })]);
    await runner.exit(start.jobId, 137, 'SIGKILL');
    const items = await timeline(admin, task.id);
    const system = comments(items).filter((c) => c.kind === 'system');
    expect(system.at(-1)!.body).toContain('stopped unexpectedly (signal SIGKILL)');
    // The call that was running when it died doesn't stay "running" on the Timeline.
    const activity = items.find((i) => i.type === 'agent' && i.item.payload.kind === 'activity');
    expect(activity).toMatchObject({ item: { payload: { entries: [{ status: 'interrupted' }] } } });
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
    expect(dropped.delivery).toEqual({ state: 'not_delivered', reason: 'task closed', jobId: null, at: expect.any(String) });
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

  it('queues a Comment posted after reopening while the cancelled Job is still exiting', async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const first = await startAndFinish(admin, runner, task.id, agent.id);
    await comment(admin, task.id, 'Start another turn.');
    const running = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    runner.accept(running.jobId);
    const s = new Stream(running.sessionId);
    await runner.play(running.jobId, [s.init(), s.text('Working.')]);

    // Closing tells the Job to cancel; the process is still running while its stdin is closed.
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    await runner.next('job.cancel', (m) => m.jobId === running.jobId);
    await moveToStatus(admin, task.id, statusByName(bundle, 'In Progress').id);

    const afterReopen = await comment(admin, task.id, 'The bug is back.');
    expect(afterReopen.delivery).toMatchObject({ state: 'queued' });
    await app.settle();
    expect(await runner.none('job.input', (m) => (m as { jobId?: string }).jobId === running.jobId)).toBe(true);
    expect((await admin.get(`/agents/${agent.id}/queue`)).body.entries).toHaveLength(1);

    await runner.exit(running.jobId, null, 'SIGTERM');
    const next = await runner.next('job.start', (m) => m.jobId !== first.jobId && m.jobId !== running.jobId);
    expect(texts(next.initialMessage)).toContain('The bug is back.');
  });

  it('replays job.end when a finishing Job reconnects', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const first = await startAndFinish(admin, runner, task.id, agent.id);
    await comment(admin, task.id, 'Finish this turn.');
    const running = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    runner.accept(running.jobId);
    const s = new Stream(running.sessionId);
    const seq = runner.sendJob({ type: 'job.event', jobId: running.jobId, line: JSON.stringify(s.result()) });
    runner.sendJob({ type: 'job.result', jobId: running.jobId, eventSeq: seq });
    await runner.drain();
    expect(runner.messages('job.end').some((m) => m.jobId === running.jobId)).toBe(true);
    await runner.close();

    const back = await FakeRunner.connect(app, agent.id, { activeJobId: running.jobId });
    expect(await back.next('job.end', (m) => m.jobId === running.jobId)).toMatchObject({ jobId: running.jobId });
  });

  it('replays job.cancel when the Task was closed while the Runner was away', async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.close();

    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    const back = await FakeRunner.connect(app, agent.id, { activeJobId: start.jobId });
    expect(await back.next('job.cancel', (m) => m.jobId === start.jobId)).toMatchObject({ jobId: start.jobId });
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'closed' });
  });

  it('closing a Status category closes its Tasks too', async () => {
    const { admin, bundle, project, agent, runner } = await setup(app);
    const status = statusByName(bundle, 'In Progress').id;
    const task = await createTask(admin, project.id, { statusId: status });
    await startAndFinish(admin, runner, task.id, agent.id);
    expect((await admin.patch(`/statuses/${status}`, { category: 'closed' })).status).toBe(200);
    await app.settle();
    expect((await getSession(admin, task.id))!.state).toBe('closed');
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

  it('switching Agent before the first Job started moves the queued Comments to the new Agent', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const { agent: other, runner: otherRunner } = await createAgent(app, admin, { name: 'Bea Bot' });
    const busy = await createTask(admin, project.id);
    await assignAndStart(admin, busy.id, agent.id);
    await runner.next('job.start');
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id, 'First request.');
    await comment(admin, task.id, 'Second request.');

    await assignAgent(admin, task.id, other.id);
    const start = await otherRunner.next('job.start');
    expect(start.mode).toBe('new');
    const text = texts(start.initialMessage);
    expect(text).toContain('First request.');
    expect(text).toContain('Second request.');
    const delivered = comments(await timeline(admin, task.id)).filter((c) => c.kind === 'user');
    expect(delivered.map((c) => c.delivery?.state)).toEqual(['delivered', 'delivered']);
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

  it('requeues the Comments when a restarted Job never started streaming', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    const first = await startAndFinish(admin, runner, task.id, agent.id);
    await comment(admin, task.id, 'Second turn, before the restart.');
    const second = await runner.next('job.start', (m) => m.jobId !== first.jobId);
    runner.accept(second.jobId);
    await runner.drain();

    // The container restarts after `job.accepted` but before any stdout event.
    await runner.close();
    const restarted = await FakeRunner.connect(app, agent.id, { activeJobId: null });
    const next = await restarted.next('job.start', (m) => m.jobId !== second.jobId);
    expect(next.resumeInterrupted).toBe(false);
    expect(next.mode).toBe('resume');
    expect(texts(next.initialMessage)).toContain('Second turn, before the restart.');
    expect(comments(await timeline(admin, task.id)).filter((c) => c.kind === 'system' && c.body.includes('middle of a turn'))).toEqual([]);
  });

  it('waits for the Runner hello before dispatching a Job', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent } = await createAgent(app, admin, { connect: false });
    const runner = await FakeRunner.connect(app, agent.id, { hello: false });
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    await app.settle();
    expect(runner.messages('job.start')).toEqual([]);

    await runner.hello(null);
    const start = await runner.next('job.start');
    expect((await admin.get(`/agents/${agent.id}/jobs`)).body.jobs.find((j: { id: string }) => j.id === start.jobId).state).not.toBe('interrupted');
    await runner.exit(start.jobId);
  });

  it('does not recover a Job whose Runner reconnected while recovery waited', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();

    await app.server.ctx.db.execute(sql`update agents set runner_disconnected_at = now() - interval '6 minutes' where id = ${agent.id}::uuid`);
    const hub = app.server.ctx.runners;
    const actual = hub.isConnected.bind(hub);
    let calls = 0;
    // First check (outside the transaction) sees a stale disconnect; the Runner is back by the second.
    hub.isConnected = ((id: string) => {
      calls++;
      return calls === 1 ? false : actual(id);
    }) as typeof hub.isConnected;
    try {
      await recoverAbandonedJobs(app.server.ctx);
    } finally {
      hub.isConnected = actual;
    }
    const job = (await admin.get(`/agents/${agent.id}/jobs`)).body.jobs.find((j: { id: string }) => j.id === start.jobId);
    expect(job.state).toBe('running');
    expect(await getSession(admin, task.id)).toMatchObject({ state: 'running' });
    await runner.exit(start.jobId);
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
  it('refuses deleting a Task, or its Project, while a Job works on it, and removes the Worktree once deleted', async () => {
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
    expect(await runner.next('worktree.remove')).toMatchObject({ worktreePath: start.worktreePath });
    expect((await admin.delete(`/projects/${project.id}`)).status).toBe(204);
  });
});

describe('the Queue', () => {
  const app = useTestApp();

  it('deleting the only queued Comment of a Task drops its entry instead of starting a Job for nothing', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const [busy, started, fresh] = await Promise.all(['Busy', 'Started', 'Fresh'].map((title) => createTask(admin, project.id, { title })));
    await startAndFinish(admin, runner, started!.id, agent.id);
    await assignAndStart(admin, busy!.id, agent.id);
    const working = await runner.next('job.start', (m) => texts(m.initialMessage).includes(busy!.key));
    runner.accept(working.jobId);
    await runner.drain();

    const followUp = await comment(admin, started!.id, 'Oops, wrong task');
    await assignAgent(admin, fresh!.id, agent.id);
    const trigger = await comment(admin, fresh!.id, 'Never mind');
    expect((await getSession(admin, fresh!.id))?.queuePosition).not.toBeNull();
    for (const c of [followUp, trigger]) expect((await admin.delete(`/comments/${c.id}`)).status).toBe(204);
    expect(await getSession(admin, started!.id)).toMatchObject({ state: 'idle', queuePosition: null });
    expect(await getSession(admin, fresh!.id)).toMatchObject({ state: 'pending', queuePosition: null });

    await runner.play(working.jobId, [new Stream(working.sessionId).init(), new Stream(working.sessionId).result()]);
    await runner.next('job.end', (m) => m.jobId === working.jobId);
    await runner.exit(working.jobId);
    await app.settle();
    expect(runner.messages('job.start')).toHaveLength(2);
  });

  it('marks a deleted Comment not delivered while its Entry keeps the other Comments', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const [busy, queued] = await Promise.all(['Busy', 'Queued'].map((title) => createTask(admin, project.id, { title })));
    await assignAndStart(admin, busy!.id, agent.id);
    const working = await runner.next('job.start', (m) => texts(m.initialMessage).includes(busy!.key));
    runner.accept(working.jobId);
    await runner.drain();

    await assignAgent(admin, queued!.id, agent.id);
    const first = await comment(admin, queued!.id, 'First, then delete me');
    await comment(admin, queued!.id, 'Second stays');
    expect((await getSession(admin, queued!.id))?.queuePosition).not.toBeNull();
    expect((await admin.delete(`/comments/${first.id}`)).status).toBe(204);

    const deleted = comments(await timeline(admin, queued!.id)).find((c) => c.id === first.id)!;
    expect(deleted.delivery).toEqual({ state: 'not_delivered', reason: 'comment deleted', jobId: null, at: expect.any(String) });
    const entry = (await admin.get(`/agents/${agent.id}/queue`)).body.entries.find((e: { task: { id: string } }) => e.task.id === queued!.id);
    expect(entry).toMatchObject({ pendingMessages: 1 });
  });

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
    expect(after.delivery).toEqual({ state: 'not_delivered', reason: 'removed from queue', jobId: null, at: expect.any(String) });
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

  it('does not claim unseen changes for a value that ended where it started', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id, { title: 'Original' });
    await startAndFinish(admin, runner, task.id, agent.id);
    const first = (await admin.get(`/tasks/${task.id}`)).body.task;
    await admin.patch(`/tasks/${task.id}`, { version: first.version, title: 'Changed' });
    const second = (await admin.get(`/tasks/${task.id}`)).body.task;
    await admin.patch(`/tasks/${task.id}`, { version: second.version, title: 'Original' });

    expect((await getSession(admin, task.id))!.unseenChanges).toBe(false);
    expect((await admin.post(`/tasks/${task.id}/session/notify`)).status).toBe(409);
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

  it('keeps inline images within a budget so a message always fits the Runner connection', async () => {
    const { admin, project, agent, runner } = await setup(app);
    const task = await createTask(admin, project.id);
    await assignAgent(admin, task.id, agent.id);
    const form = new FormData();
    form.set('body', 'Screenshots of every page');
    for (let i = 0; i < 10; i++) form.append('files', new Blob([Buffer.alloc(5 * 1024 * 1024 - 1, i)], { type: 'image/png' }), `page-${i}.png`);
    expect((await admin.request('POST', `/tasks/${task.id}/comments`, { form })).status).toBe(201);
    const start = await runner.next('job.start', () => true, 10_000);
    expect(JSON.stringify(start).length).toBeLessThan(32 * 1024 * 1024);
    const inline = (start.initialMessage ?? []).filter((b) => b.type === 'image');
    expect(inline.length).toBeGreaterThan(0);
    // The rest reach the Worktree as files, newest-first preference aside.
    expect(inline.length + start.attachmentsToFetch.length).toBe(10);
    expect(texts(start.initialMessage)).toMatch(/Attached file: `\.claude-task\/attachments\/.+\/page-\d\.png`/);
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

    it('keeps the per-Task limit under concurrent uploads', async () => {
      const { admin, project } = await setup(app);
      const task = await createTask(admin, project.id);
      const first = await uploadToTask(admin, task.id, 'a.txt', 'text/plain', 'x');
      await app.server.ctx.db.execute(sql`
        insert into attachments (task_id, blob_id, filename, content_type, size)
        select task_id, blob_id, filename, content_type, size from attachments, generate_series(1, 98) where id = ${first.id}::uuid`);
      const uploads = await Promise.all(
        Array.from({ length: 6 }, () => {
          const form = new FormData();
          form.append('files', new Blob(['y'], { type: 'text/plain' }), 'b.txt');
          return admin.request('POST', `/tasks/${task.id}/attachments`, { form });
        }),
      );
      expect(uploads.filter((r) => r.status === 201)).toHaveLength(1);
      const { rows } = await app.server.ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from attachments where task_id = ${task.id}::uuid`);
      expect(rows[0]!.n).toBe(100);
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
