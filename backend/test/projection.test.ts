import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ActivityEntry } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { initialProjection, project, projectionId } from '../src/projection/projector';
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
  const children = e.children.length ? ` [${e.children.map(entryText).join(', ')}]` : '';
  return `${e.summary} (${e.status}${e.outcome ? `, ${e.outcome}` : ''})${children}`;
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
      name: 'subagent tool calls nest under the call that started them; their text stays out',
      events: [
        s.toolUse('task1', 'Task', { description: 'Find the config', prompt: '…' }),
        s.text('Subagent musing', 'task1'),
        s.toolUse('sub1', 'Glob', { pattern: '**/*.toml' }, 'task1'),
        s.toolResult('sub1', 'a.toml', { parent: 'task1' }),
        s.toolResult('task1', 'Found it in a.toml'),
        s.text('Found it.'),
        s.result(),
      ],
      expected: [
        'activity: Started a subagent: Find the config (ok) [Listed `**/*.toml` (ok)]',
        'agent: Found it.',
        'summary: success 2 tools',
      ],
    },
    {
      name: 'MCP tools name their server; Task Tools read as such',
      events: [
        s.toolUse('a', 'mcp__claude-task__set_status', { status_name: 'Ready for Review' }),
        s.toolUse('b', 'mcp__github__create_issue', {}),
        s.result(),
      ],
      expected: ['activity: Task tool `set_status` (pending) | github: `create_issue` (pending)', 'summary: success 2 tools'],
    },
    {
      name: 'compaction leaves a notice',
      events: [s.text('Before.'), s.compact(180_000), s.text('After.'), s.result()],
      expected: ['agent: Before.', 'notice: Context compacted (180,000 tokens before)', 'agent: After.', 'summary: success 0 tools'],
    },
    {
      name: 'a non-success result also posts a System Comment',
      events: [s.toolUse('a', 'Bash', { command: 'x' }), s.result({ subtype: 'error_max_turns', isError: true, result: '' })],
      expected: ['activity: Ran `x` (pending)', 'summary: error_max_turns 1 tools', 'system: The turn stopped: it reached the maximum number of steps.'],
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
    expect(system[0]).toMatch(/spend limit/);
    expect(timeline(mutations)).toContain('summary: success 0 tools');
  });
});

describe('recorded streams (ADR 0005 spike)', () => {
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

  it.each(['partial-messages', 'mcp-http-tool', 'resume-interrupted-turn'])('%s projects without throwing and ends with a summary', (name) => {
    const { mutations } = replay(load(name));
    expect(mutations.some((m) => m.op === 'item.create' && m.payload.kind === 'turn_summary')).toBe(true);
  });
});
