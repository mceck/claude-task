import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ActivityEntry, RunInfo } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { endJob, initialProjection, project, projectionId } from '../src/projection/projector';
import type { Broadcast, Mutation, ProjectionState } from '../src/projection/projector';
import { Stream } from './helpers/stream';
import type { StreamEvent } from './helpers/stream';

const ctx = { jobId: 'job-1', credentialName: 'Team token', receivedAt: '2026-10-25T10:00:00.000Z' };

/** Projects a whole stream, collecting every mutation and broadcast. */
function replay(events: unknown[], state: ProjectionState = initialProjection()) {
  const mutations: Mutation[] = [];
  const broadcasts: Broadcast[] = [];
  for (const e of events) {
    const r = project(state, e, ctx);
    state = r.state;
    mutations.push(...r.mutations);
    broadcasts.push(...r.broadcasts);
  }
  return { state, mutations, broadcasts };
}

/** What the Timeline ends up showing: the last version of every Comment and item, in creation order. */
function timeline(mutations: Mutation[]) {
  const items = new Map<string, string>();
  for (const m of mutations) {
    if (m.op === 'comment.create' || m.op === 'comment.update') items.set(m.id, `agent: ${m.body}`);
    if (m.op === 'item.create' || m.op === 'item.update') {
      const p = m.payload;
      items.set(
        m.id,
        p.kind === 'thinking'
          ? `thinking: ${p.text}`
          : p.kind === 'activity'
            ? `activity: ${p.entries.map(entryText).join(' | ')}`
            : p.kind === 'run'
              ? runText(p.run)
              : p.kind === 'turn_summary'
                ? `summary: ${p.summary.subtype} ${p.summary.toolCalls} tools`
                : `notice: ${p.text}`,
      );
    }
    if (m.op === 'system_comment') items.set(`system-${items.size}`, `system: ${m.body.split('\n')[0]}`);
  }
  return [...items.values()];
}

function entryText(e: ActivityEntry): string {
  return `${e.summary} (${e.status}${e.outcome ? `, ${e.outcome}` : ''})`;
}

function runText(run: RunInfo): string {
  const error = run.error ? `, ${run.error}` : '';
  return `run: ${run.description} (${run.runType}, ${run.status}, ${run.toolCalls} tools${error})`;
}

describe('stream projection', () => {
  const s = new Stream();

  const cases: { name: string; events: StreamEvent[]; expected: string[] }[] = [
    {
      name: 'consecutive text blocks form one agent Comment',
      events: [s.init(), s.text('First part.'), s.text('Second part.'), s.result()],
      expected: ['agent: First part.\n\nSecond part.', 'summary: success 0 tools'],
    },
    {
      name: 'tool calls between texts form one Activity group each',
      events: [
        s.text('Let me look.'),
        s.toolUse('a', 'Read', { file_path: 'src/a.ts' }),
        s.toolResult('a', 'contents'),
        s.toolUse('b', 'Grep', { pattern: 'TODO', path: 'src' }),
        s.toolResult('b', 'nothing'),
        s.text('Now editing.'),
        s.toolUse('c', 'Write', { file_path: 'src/b.ts', content: 'x' }),
        s.toolResult('c', 'ok'),
        s.result(),
      ],
      expected: [
        'agent: Let me look.',
        'activity: Read `src/a.ts` (ok) | Searched for `TODO` in `src` (ok)',
        'agent: Now editing.',
        'activity: Wrote `src/b.ts` (ok)',
        'summary: success 3 tools',
      ],
    },
    {
      name: 'thinking comes before the reply it led to, merged while consecutive',
      events: [s.thinking('Hmm.'), s.thinking('Got it.'), s.text('Answer.'), s.result()],
      expected: ['thinking: Hmm.\n\nGot it.', 'agent: Answer.', 'summary: success 0 tools'],
    },
    {
      name: 'Bash outcomes: exit codes and failures',
      events: [
        s.toolUse('a', 'Bash', { command: 'npm test\nmore' }),
        s.toolResult('a', 'Exit code 2\nboom', { isError: true }),
        s.toolUse('b', 'Bash', { command: 'ls' }),
        s.toolResult('b', 'a b c'),
        s.result(),
      ],
      expected: ['activity: Ran `npm test` (error, exit 2) | Ran `ls` (ok, exit 0)', 'summary: success 2 tools'],
    },
    {
      name: 'a successful Bash call is exit 0 even when its output mentions another exit code',
      events: [s.toolUse('a', 'Bash', { command: 'run-tests' }), s.toolResult('a', 'child failed: exit code 1'), s.result()],
      expected: ['activity: Ran `run-tests` (ok, exit 0)', 'summary: success 1 tools'],
    },
    {
      name: 'whitespace-only text does not hide the successful result text',
      events: [s.text('   '), s.result({ result: 'Done.' })],
      expected: ['summary: success 0 tools', 'system: Done.'],
    },
    {
      name: 'a subagent is a Run: one item that keeps its outcome, its text out of the Timeline',
      events: [
        s.toolUse('task1', 'Task', { description: 'Find the config', prompt: '…' }),
        s.text('Subagent musing', 'task1'),
        s.toolUse('sub1', 'Glob', { pattern: '**/*.toml' }, 'task1'),
        s.toolResult('sub1', 'a.toml', { parent: 'task1' }),
        s.toolResult('task1', 'Found it in a.toml'),
        s.text('Found it.'),
        s.result(),
      ],
      expected: ['run: Find the config (subagent, ok, 1 tools)', 'agent: Found it.', 'summary: success 2 tools'],
    },
    {
      name: 'a Run that failed keeps why, cut to 2 KB',
      events: [
        s.toolUse('task1', 'Agent', { description: 'Fix the build', subagent_type: 'general-purpose' }),
        s.toolResult('task1', `boom\n${'x'.repeat(4096)}`, { isError: true }),
        s.result(),
      ],
      expected: [`run: Fix the build (subagent, error, 0 tools, boom\n${'x'.repeat(2043)})`, 'summary: success 1 tools'],
    },
    {
      name: 'nested delegations are Runs of their own, one level deeper',
      events: [
        s.toolUse('task1', 'Task', { description: 'Outer' }),
        s.toolUse('task2', 'Task', { description: 'Inner' }, 'task1'),
        s.toolResult('task2', 'inner done', { parent: 'task1' }),
        s.toolResult('task1', 'outer done'),
        s.result(),
      ],
      expected: ['run: Outer (subagent, ok, 1 tools)', 'run: Inner (subagent, ok, 0 tools)', 'summary: success 2 tools'],
    },
    {
      name: 'a background command is a Run that its notification ends',
      events: [
        s.taskStarted({ taskId: 'bash1', taskType: 'local_bash', description: 'Serve the app', backgrounded: true }),
        s.taskNotification({ taskId: 'bash1', summary: 'Server stopped' }),
        s.text('Serving.'),
        s.result(),
      ],
      expected: ['run: Serve the app (command, ok, 0 tools)', 'agent: Serving.', 'summary: success 0 tools'],
    },
    {
      name: 'a foreground command is not a Run',
      events: [s.taskStarted({ taskId: 'bash1', taskType: 'local_bash', description: 'npm test' }), s.text('Ran it.'), s.result()],
      expected: ['agent: Ran it.', 'summary: success 0 tools'],
    },
    {
      name: 'a backgrounded subagent hands back at once and ends on its notification',
      events: [
        s.toolUse('task1', 'Task', { description: 'Long job' }),
        s.taskStarted({ taskId: 'agent1', toolUseId: 'task1', description: 'Long job', backgrounded: true }),
        s.toolResult('task1', 'started in the background'),
        s.text('It is running.'),
        s.taskNotification({ taskId: 'agent1', status: 'failed', summary: 'It broke' }),
        s.result(),
      ],
      expected: ['run: Long job (subagent, error, 0 tools, It broke)', 'agent: It is running.', 'summary: success 1 tools'],
    },
    {
      name: 'a backgrounded subagent stopped by the Agent is interrupted, not failed',
      events: [
        s.toolUse('task1', 'Task', { description: 'Long job' }),
        s.taskStarted({ taskId: 'agent1', toolUseId: 'task1', description: 'Long job', backgrounded: true }),
        s.toolResult('task1', 'rejected by user', { isError: true, rejected: true }),
        s.result(),
      ],
      expected: ['run: Long job (subagent, interrupted, 0 tools)', 'summary: success 1 tools'],
    },
    {
      name: 'MCP tools name their server; Task Tools read as such',
      events: [
        s.toolUse('a', 'mcp__claude-task__set_status', { status_name: 'Ready for Review' }),
        s.toolUse('b', 'mcp__github__create_issue', {}),
        s.result(),
      ],
      expected: ['activity: Task tool `set_status` (interrupted, interrupted) | github: `create_issue` (interrupted, interrupted)', 'summary: success 2 tools'],
    },
    {
      name: 'thinking between tool calls closes the Activity group, keeping the order',
      events: [s.thinking('First.'), s.toolUse('a', 'Read', { file_path: 'a' }), s.toolResult('a', 'x'), s.thinking('Second.'), s.toolUse('b', 'Read', { file_path: 'b' }), s.toolResult('b', 'y'), s.result()],
      expected: ['thinking: First.', 'activity: Read `a` (ok)', 'thinking: Second.', 'activity: Read `b` (ok)', 'summary: success 2 tools'],
    },
    {
      name: 'compaction leaves a notice',
      events: [s.text('Before.'), s.compact(180_000), s.text('After.'), s.result()],
      expected: ['agent: Before.', 'notice: Context compacted (180,000 tokens before)', 'agent: After.', 'summary: success 0 tools'],
    },
    {
      name: 'a non-success result also posts a System Comment',
      events: [s.toolUse('a', 'Bash', { command: 'x' }), s.result({ subtype: 'error_max_turns', isError: true, result: '' })],
      expected: ['activity: Ran `x` (interrupted, interrupted)', 'summary: error_max_turns 1 tools', 'system: The turn stopped: it reached the maximum number of steps.'],
    },
    {
      name: 'credential errors name the Credential, once',
      events: [s.apiRetry(1, 10, 'authentication_failed'), s.apiRetry(2, 10, 'authentication_failed')],
      expected: ['system: Credential **Team token** was rejected (authentication_failed). Check it in Credentials.'],
    },
    {
      name: 'retries that run out are reported',
      events: [s.apiRetry(9, 10, 'overloaded_error'), s.apiRetry(10, 10, 'overloaded_error')],
      expected: ['system: The Claude API kept failing (overloaded_error); gave up after 10 attempts.'],
    },
    {
      name: 'a Task Tools server that failed to load is reported; pending is normal',
      events: [s.init({ mcpStatus: 'pending' }), s.init({ mcpStatus: 'failed' })],
      expected: ["system: The Task Tools server failed to load (failed), so the agent can't read or update tasks in this run."],
    },
  ];

  it.each(cases)('$name', ({ events, expected }) => {
    expect(timeline(replay(events).mutations)).toEqual(expected);
  });

  it('broadcasts text and thinking deltas but persists nothing for them', () => {
    const { mutations, broadcasts } = replay([s.delta('Hel'), s.delta('lo'), s.delta('hmm', 'thinking')]);
    expect(mutations).toEqual([]);
    expect(broadcasts).toEqual([
      { type: 'live.delta', delta: { kind: 'text', commentId: null, text: 'Hel' } },
      { type: 'live.delta', delta: { kind: 'text', commentId: null, text: 'lo' } },
      { type: 'live.delta', delta: { kind: 'thinking', commentId: null, text: 'hmm' } },
    ]);
  });

  it('shows retries as a transient status, cleared when the model answers', () => {
    const { broadcasts } = replay([s.apiRetry(1, 10, null), s.text('Back.')]);
    expect(broadcasts.filter((b) => b.type === 'live.status').map((b) => b.status)).toEqual([
      { kind: 'retrying', attempt: 1, maxRetries: 10, error: null },
      null,
    ]);
  });

  it('records Turns with per-turn cost although the CLI reports it cumulatively', () => {
    const { mutations } = replay([s.init(), s.text('a'), s.result({ costUsd: 0.1 }), s.text('b'), s.toolUse('x', 'Read', {}), s.result({ costUsd: 0.25 })]);
    const turns = mutations.filter((m) => m.op === 'turn').map((m) => (m as Extract<Mutation, { op: 'turn' }>).turn);
    expect(turns.map((t) => [t.index, t.toolCalls, t.costUsd])).toEqual([
      [0, 0, 0.1],
      [1, 1, 0.15],
    ]);
  });

  it('starts a new agent Comment in each Turn', () => {
    const { mutations } = replay([s.text('Turn one.'), s.result(), s.text('Turn two.'), s.result()]);
    expect(mutations.filter((m) => m.op === 'comment.create')).toHaveLength(2);
  });

  describe('context usage', () => {
    const message = (usage: Record<string, number>, model = s.model, parent: string | null = null) => ({
      type: 'assistant',
      message: { model, content: [{ type: 'text', text: 'x' }], usage },
      parent_tool_use_id: parent,
    });
    const turnOf = (mutations: Mutation[]) => mutations.find((m) => m.op === 'turn') as Extract<Mutation, { op: 'turn' }>;

    it('is the last model call of the Turn, not the summed usage the result reports', () => {
      const { mutations } = replay([
        message({ input_tokens: 2, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 100, output_tokens: 10 }),
        message({ input_tokens: 2, cache_read_input_tokens: 31_000, cache_creation_input_tokens: 120, output_tokens: 20 }),
        s.result({ modelUsage: { [s.model]: { contextWindow: 200_000 } } }),
      ]);
      expect(turnOf(mutations).turn.context).toEqual({ tokens: 31_142, window: 200_000 });
    });

    it('follows the model the last message used', () => {
      const { mutations } = replay([
        message({ input_tokens: 1, output_tokens: 1 }, 'claude-sonnet-5-5'),
        message({ input_tokens: 1, output_tokens: 1 }, 'claude-haiku-4-5'),
        s.result({ modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1_000_000 }, 'claude-haiku-4-5': { contextWindow: 200_000 } } }),
      ]);
      expect(turnOf(mutations).turn.context).toEqual({ tokens: 2, window: 200_000 });
    });

    it('keeps the tokens but no percentage when the CLI reports no window', () => {
      const { mutations } = replay([s.text('hi'), s.result({ modelUsage: null })]);
      expect(turnOf(mutations).turn.context).toEqual({ tokens: 15, window: null });
    });

    it('is empty when the Turn made no model call, and a Subagent message does not count', () => {
      const empty = replay([s.result()]);
      expect(turnOf(empty.mutations).turn.context).toBeNull();
      const nested = replay([
        s.text('top'),
        message({ input_tokens: 90_000, output_tokens: 1 }, s.model, 'task1'),
        s.result({ modelUsage: { [s.model]: { contextWindow: 1_000_000 } } }),
      ]);
      expect(turnOf(nested.mutations).turn.context).toEqual({ tokens: 15, window: 1_000_000 });
    });
  });

  it('is deterministic, so a replay produces the same ids', () => {
    const events = [s.text('x'), s.toolUse('a', 'Read', {}), s.result()];
    expect(replay(events).mutations).toEqual(replay(events).mutations);
    expect(projectionId('job-1', 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('survives its state being stored as JSON between events', () => {
    const events = [s.toolUse('a', 'Bash', { command: 'make' }), s.toolUse('b', 'Bash', { command: 'make test' }), s.toolResult('a', 'ok'), s.toolResult('b', 'Exit code 1', { isError: true }), s.result()];
    let state = initialProjection();
    const mutations: Mutation[] = [];
    for (const e of events) {
      const r = project(JSON.parse(JSON.stringify(state)), e, ctx);
      state = r.state;
      mutations.push(...r.mutations);
    }
    expect(timeline(mutations)[0]).toBe('activity: Ran `make` (ok, exit 0) | Ran `make test` (error, exit 1)');
  });

  it('settles tool calls and Runs left running when the Job ends', () => {
    const { state } = replay([s.toolUse('a', 'Bash', { command: 'sleep 999' }), s.toolUse('b', 'Task', { description: 'dig' }), s.toolUse('c', 'Read', {}, 'b')]);
    const ended = endJob(state);
    expect(timeline(ended.mutations)).toEqual(['activity: Ran `sleep 999` (interrupted, interrupted)', 'run: dig (subagent, interrupted, 1 tools)']);
    expect(endJob(ended.state).mutations).toEqual([]);
  });

  it('keeps a Run its own text and tool calls out of the Timeline and the stored state', () => {
    const { mutations, state } = replay([
      s.toolUse('task1', 'Task', { description: 'Explore', prompt: 'Look around' }),
      s.text('Subagent words', 'task1'),
      s.toolUse('sub1', 'Read', { file_path: 'a.ts' }, 'task1'),
      s.toolResult('sub1', 'contents', { parent: 'task1' }),
      s.toolResult('task1', 'done'),
    ]);
    const messages = mutations.filter((m) => m.op === 'run.message').map((m) => (m as Extract<Mutation, { op: 'run.message' }>).message);
    expect(messages.map((m) => (m.type === 'text' ? `text: ${m.text}` : `tool: ${m.name} ${m.status}`))).toEqual(['text: Subagent words', 'tool: Read pending']);
    const created = mutations.find((m) => m.op === 'run.create') as Extract<Mutation, { op: 'run.create' }>;
    expect(created.prompt).toBe('Look around');
    expect(state.runs[created.id]!.run.status).toBe('ok');
  });

  it('settles a nested delegation on its hand-back, without keeping its report', () => {
    const { mutations } = replay([
      s.toolUse('task1', 'Task', { description: 'Outer' }),
      s.toolUse('task2', 'Task', { description: 'Inner' }, 'task1'),
      s.toolResult('task2', 'Found the entry point', { parent: 'task1' }),
      s.toolResult('task1', 'outer done'),
    ]);
    const results = mutations.flatMap((m) => (m.op === 'run.tool_result' ? [{ id: m.toolUseId, status: m.status, output: m.output }] : []));
    expect(results).toEqual([{ id: 'task2', status: 'ok', output: null }]);
  });

  it('a background command has no tool call, and its notification carries the summary', () => {
    const { mutations, state } = replay([
      s.taskStarted({ taskId: 'bash1', taskType: 'local_bash', description: 'npm ci', backgrounded: true }),
      s.taskNotification({ taskId: 'bash1', summary: 'npm ci completed (exit 0)' }),
    ]);
    const created = mutations.find((m) => m.op === 'run.create') as Extract<Mutation, { op: 'run.create' }>;
    expect(created.run).toMatchObject({ runType: 'command', toolUseId: null, subagentType: null, depth: 1 });
    expect(state.runs[created.id]!.run).toMatchObject({ status: 'ok', outcome: 'npm ci completed (exit 0)', error: null });
    const end = mutations.find((m) => m.op === 'run.end') as Extract<Mutation, { op: 'run.end' }>;
    expect(end.usage).toBeNull();
  });

  it('a stopped background command is an error, so it stays for the reader', () => {
    const { state } = replay([
      s.taskStarted({ taskId: 'bash1', taskType: 'local_bash', description: 'npm ci', backgrounded: true }),
      s.taskNotification({ taskId: 'bash1', status: 'stopped', summary: 'npm ci stopped' }),
    ]);
    expect(Object.values(state.runs)[0]!.run).toMatchObject({ status: 'error', error: 'npm ci stopped' });
  });

  it('leaves the state alone for deltas, so nothing needs to be stored', () => {
    const { state } = replay([s.toolUse('a', 'Bash', { command: 'x' })]);
    expect(project(state, s.delta('more'), ctx).state).toBe(state);
  });

  it('keeps huge tool inputs out of the stored Activity', () => {
    const big = 'x'.repeat(1024 * 1024);
    const { mutations } = replay([s.toolUse('a', 'Write', { file_path: 'big.txt', content: big }), s.toolResult('a', 'ok'), s.result()]);
    const sizes = mutations.filter((m) => m.op === 'item.create' || m.op === 'item.update').map((m) => JSON.stringify(m).length);
    for (const size of sizes) expect(size).toBeLessThan(64 * 1024);
  });

  it("stores nothing of a Run's transcript, so the projection keeps its size", () => {
    const size = (events: StreamEvent[]) => JSON.stringify(replay(events).state).length;
    const head = s.toolUse('task1', 'Task', { description: 'dig' });
    const tail = [s.toolResult('task1', 'done'), s.result()];
    const quiet = size([head, ...tail]);
    const chatty = size([head, ...Array.from({ length: 100 }, () => s.text('x'.repeat(2000), 'task1')), ...tail]);
    expect(chatty).toBeLessThan(quiet + 1024);
  });

  it('ignores lines it does not know', () => {
    expect(replay([{ type: 'control_response', response: {} }, { type: 'system', subtype: 'hook_started' }, 'garbage', null]).mutations).toEqual([]);
  });

  it('projects the recorded spend-limit stream (Claude Code 2.1.310)', () => {
    const lines = readFileSync(path.join(import.meta.dirname, 'fixtures/streams/spend-limit.jsonl'), 'utf8').trim().split('\n');
    const { mutations } = replay(lines.map((l) => JSON.parse(l)));
    expect(mutations.find((m) => m.op === 'init')).toMatchObject({ claudeVersion: '2.1.310' });
    expect(mutations.find((m) => m.op === 'rate_limit')).toMatchObject({ info: { status: 'rejected', rateLimitType: 'seven_day' } });
    expect(mutations.some((m) => m.op === 'comment.create')).toBe(false);
    const system = mutations.filter((m) => m.op === 'system_comment').map((m) => (m as { body: string }).body);
    expect(system).toHaveLength(1);
    expect(system[0]).toMatch(/spend limit/);
    expect(timeline(mutations)).toContain('summary: success 0 tools');
  });
});

describe('usage limits', () => {
  const resetsAt = Date.parse(ctx.receivedAt) / 1000 + 3600;
  const limited = (s: Stream, info: Record<string, unknown>) => [s.init(), s.rateLimit(info), s.synthetic('You hit your limit'), s.result({ isError: true, result: 'You hit your limit' })];
  const offers = (mutations: Mutation[]) => mutations.filter((m) => m.op === 'system_comment').map((m) => (m as { limitResetsAt?: string }).limitResetsAt);

  it('attaches the reset time of a rejected limit to the System Comment', () => {
    const { mutations } = replay(limited(new Stream(), { status: 'rejected', resetsAt, rateLimitType: 'five_hour' }));
    expect(offers(mutations)).toEqual([new Date(resetsAt * 1000).toISOString()]);
  });

  it('offers the resume from the recorded spend-limit stream, whose reset is still ahead', () => {
    const lines = readFileSync(path.join(import.meta.dirname, 'fixtures/streams/spend-limit.jsonl'), 'utf8').trim().split('\n');
    expect(offers(replay(lines.map((l) => JSON.parse(l))).mutations)).toEqual(['2026-10-26T17:00:00.000Z']);
  });

  it.each([
    ['without a reset time', { status: 'rejected' }],
    ['when the limit is only a warning', { status: 'allowed_warning', resetsAt }],
    ['when the reset time has passed', { status: 'rejected', resetsAt: resetsAt - 7200 }],
  ])('offers nothing %s', (_name, info) => {
    expect(offers(replay(limited(new Stream(), info)).mutations)).toEqual([undefined]);
  });

  it('forgets the limit when the Turn ends, so the next error is not offered a stale reset', () => {
    const s = new Stream();
    const first = replay(limited(s, { status: 'rejected', resetsAt }));
    const second = replay([s.text('hi'), s.result({ isError: true, result: 'boom' })], first.state);
    expect(offers(second.mutations)).toEqual([undefined]);
  });
});

describe('recorded streams (real CLI spike)', () => {
  const load = (name: string) =>
    readFileSync(path.join(import.meta.dirname, `fixtures/streams/${name}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('a Stop is an expected end of Turn, not an error', () => {
    const { mutations } = replay(load('interrupt-control-request'));
    const lines = timeline(mutations);
    expect(lines.some((l) => l.startsWith('system:'))).toBe(false);
    expect(lines.filter((l) => l.startsWith('summary:'))).toEqual(['summary: error_during_execution 1 tools', 'summary: success 0 tools']);
    expect(mutations.filter((m) => m.op === 'turn').map((m) => m.op === 'turn' && m.turn.isError)).toEqual([false, false]);
    expect(lines[0]).toMatch(/^activity: Ran .* \(interrupted, interrupted\)$/);
  });

  it('empty thinking blocks produce no Timeline item', () => {
    const { mutations } = replay(load('thinking-redacted'));
    expect(timeline(mutations).some((l) => l.startsWith('thinking:'))).toBe(false);
  });

  it('a message consumed mid-turn belongs to the same Turn', () => {
    const { mutations } = replay(load('mid-turn-message'));
    expect(timeline(mutations).filter((l) => l.startsWith('summary:'))).toEqual(['summary: success 3 tools']);
  });

  it('queued messages drained after stdin closes are one Turn each', () => {
    const { mutations } = replay(load('stdin-close-queued'));
    expect(timeline(mutations)).toEqual(['agent: ONE', 'summary: success 0 tools', 'agent: TWO', 'summary: success 0 tools', 'agent: THREE', 'summary: success 0 tools']);
  });

  it('a recorded Background Command becomes a Run settled by its notification', () => {
    const { mutations, state } = replay(load('partial-messages'));
    const created = mutations.flatMap((m) => (m.op === 'run.create' ? [m.run] : []));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ runType: 'command', toolUseId: null, status: 'running' });
    const run = Object.values(state.runs)[0]!.run;
    expect(run).toMatchObject({ status: 'ok', error: null });
    expect(run.outcome).toMatch(/completed \(exit code 0\)$/);
    // The CLI's notification carries no token breakdown, so no usage is recorded.
    expect(mutations.find((m) => m.op === 'run.end')).toMatchObject({ usage: null });
  });

  it.each(['partial-messages', 'mcp-http-tool', 'resume-interrupted-turn'])('%s projects without throwing and ends with a summary', (name) => {
    const { mutations } = replay(load(name));
    expect(mutations.some((m) => m.op === 'item.create' && m.payload.kind === 'turn_summary')).toBe(true);
  });
});
