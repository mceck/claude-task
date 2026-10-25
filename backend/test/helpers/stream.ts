// Builders for `claude -p --output-format stream-json --verbose --include-partial-messages` lines,
// shaped like the CLI's real output (see test/fixtures/streams for recorded ones).
import { randomUUID } from 'node:crypto';

export type StreamEvent = Record<string, unknown>;

let n = 0;
const uuid = () => randomUUID();
const msgId = () => `msg_${(n++).toString(36).padStart(8, '0')}`;

export class Stream {
  constructor(
    readonly sessionId: string = randomUUID(),
    readonly model = 'claude-sonnet-5-5',
  ) {}

  init(opts: { mcpStatus?: string; version?: string } = {}): StreamEvent {
    return {
      type: 'system',
      subtype: 'init',
      cwd: '/home/agent/worktrees/p/T-1',
      session_id: this.sessionId,
      tools: ['Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob', 'Task', 'mcp__claude-task__get_task'],
      mcp_servers: [{ name: 'claude-task', status: opts.mcpStatus ?? 'pending' }],
      model: this.model,
      permissionMode: 'bypassPermissions',
      claude_code_version: opts.version ?? '2.1.310',
      apiKeySource: 'none',
      uuid: uuid(),
    };
  }

  private assistant(block: Record<string, unknown>, parent: string | null = null, model = this.model): StreamEvent {
    return {
      type: 'assistant',
      message: {
        id: msgId(),
        type: 'message',
        role: 'assistant',
        model,
        content: [block],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      parent_tool_use_id: parent,
      session_id: this.sessionId,
      uuid: uuid(),
    };
  }

  text(text: string, parent: string | null = null): StreamEvent {
    return this.assistant({ type: 'text', text }, parent);
  }

  synthetic(text: string): StreamEvent {
    return this.assistant({ type: 'text', text }, null, '<synthetic>');
  }

  thinking(thinking: string): StreamEvent {
    return this.assistant({ type: 'thinking', thinking, signature: 'sig' });
  }

  toolUse(id: string, name: string, input: Record<string, unknown>, parent: string | null = null): StreamEvent {
    return this.assistant({ type: 'tool_use', id, name, input }, parent);
  }

  toolResult(id: string, content: string, opts: { isError?: boolean; parent?: string | null } = {}): StreamEvent {
    return {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: opts.isError ?? false }] },
      parent_tool_use_id: opts.parent ?? null,
      session_id: this.sessionId,
      uuid: uuid(),
    };
  }

  delta(text: string, kind: 'text' | 'thinking' = 'text'): StreamEvent {
    return {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: uuid(),
    };
  }

  result(opts: { subtype?: string; isError?: boolean; costUsd?: number; durationMs?: number; result?: string; numTurns?: number } = {}): StreamEvent {
    return {
      type: 'result',
      subtype: opts.subtype ?? 'success',
      is_error: opts.isError ?? false,
      duration_ms: opts.durationMs ?? 1200,
      duration_api_ms: 1000,
      num_turns: opts.numTurns ?? 1,
      result: opts.result ?? 'done',
      stop_reason: 'end_turn',
      session_id: this.sessionId,
      total_cost_usd: opts.costUsd ?? 0.01,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
      permission_denials: [],
      uuid: uuid(),
    };
  }

  apiRetry(attempt: number, maxRetries: number, error: string | null): StreamEvent {
    return { type: 'system', subtype: 'api_retry', attempt, max_retries: maxRetries, retry_delay_ms: 500, error_status: 500, error, session_id: this.sessionId, uuid: uuid() };
  }

  rateLimit(info: Record<string, unknown>): StreamEvent {
    return { type: 'rate_limit_event', rate_limit_info: info, session_id: this.sessionId, uuid: uuid() };
  }

  compact(preTokens = 150_000): StreamEvent {
    return { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: preTokens }, session_id: this.sessionId, uuid: uuid() };
  }
}

/** A typical Turn: the Agent says something, runs a command, edits a file, sums up. */
export function typicalTurn(s: Stream, opts: { text?: string; exit?: number } = {}): StreamEvent[] {
  return [
    s.init(),
    s.delta('Looking'),
    s.delta(' into it.'),
    s.text(opts.text ?? 'Looking into it.'),
    s.toolUse('toolu_1', 'Bash', { command: 'npm test', description: 'Run the tests' }),
    s.toolResult('toolu_1', opts.exit ? `Exit code ${opts.exit}\nFAIL src/auth.test.ts` : 'All tests passed', { isError: !!opts.exit }),
    s.toolUse('toolu_2', 'Edit', { file_path: '/home/agent/worktrees/p/T-1/src/auth.ts', old_string: 'a', new_string: 'b' }),
    s.toolResult('toolu_2', 'The file has been updated.'),
    s.text('Fixed the redirect.'),
    s.result(),
  ];
}
