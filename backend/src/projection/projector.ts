// The Timeline projection of an Agent's stream-json output (docs/specs/agent-sessions.md). A pure function from
// (state, event) to (state, mutations, broadcasts), so it can be tested over recorded streams
// and replayed when the display rules change. Applying the mutations is someone else's job.
import { createHash } from 'node:crypto';
import type { ActivityEntry, AgentItemPayload, LiveDelta, RunInfo, RunMessageDraft, TurnSummary, Usage } from '@claude-task/shared';

/** A Run while it is open: its item payload plus what the projection needs to route its output. */
export interface RunState {
  id: string;
  run: RunInfo;
  /** A `system/task_started` said the CLI runs it in the background: its hand-back is not its end. */
  backgrounded: boolean;
}

export interface ProjectionState {
  /** Turns finished in this Job. */
  turns: number;
  turnStartedAt: string | null;
  toolCalls: number;
  /** `total_cost_usd` of the previous `result`: the CLI reports it cumulatively per process. */
  costSoFar: number;
  /** Agent Comment still being written (consecutive text blocks). */
  comment: { id: string; body: string } | null;
  /** The last Agent Comment of the Turn, which its Alert previews. */
  turnComment?: string | null;
  /** When the Turn last handed input to the model (its start, then each batch of tool results). */
  lastInputAt?: string | null;
  thinking: { id: string; text: string } | null;
  /** The open Activity item, which new tool calls join. */
  activity: string | null;
  /** Where each tool call lives: its Activity item and the index of its entry. */
  tools: Record<string, { itemId: string; index: number }>;
  /** Entries of every Activity item of the Turn, which tool results still update. */
  groups: Record<string, ActivityEntry[]>;
  /** Runs of this Job, by Run id (their Agent Item id). */
  runs: Record<string, RunState>;
  /** The call that started each Subagent Run, so its output and its hand-back find it. */
  runByTool: Record<string, string>;
  /** A CLI task id (backgrounded Runs) and the Run it belongs to. */
  runByCliTask: Record<string, string>;
  /** Tool calls inside a Run's transcript, with the Run that holds them. */
  runTools: Record<string, { runId: string; name: string }>;
  retrying: boolean;
  /** Credential errors are reported once per Job. */
  credentialReported: boolean;
  hasVisibleOutput?: boolean;
  /** What the CLI's own `<synthetic>` message said this Turn, which its `result` repeats. */
  syntheticText?: string | null;
  /** The reset time (epoch seconds) of a rejected rate limit seen this Turn, until a System Comment offers the resume. */
  limitResetsAt?: number | null;
  nextId: number;
}

export interface ProjectionContext {
  jobId: string;
  credentialName: string;
  /** When the event reached the backend (ISO). */
  receivedAt: string;
}

export interface TurnRecord extends TurnSummary {
  index: number;
  startedAt: string;
  finishedAt: string;
  stopReason: string | null;
  /** The last Agent Comment of the Turn. */
  commentId: string | null;
  /** Comments delivered up to then reached one of the Turn's model calls. */
  readUpTo: string;
}

export type Mutation =
  | { op: 'comment.create'; id: string; body: string }
  | { op: 'comment.update'; id: string; body: string }
  | { op: 'item.create'; id: string; payload: AgentItemPayload }
  | { op: 'item.update'; id: string; payload: AgentItemPayload }
  /** A Run starts; its transcript lives in the backend's memory, not in Agent Items. */
  | { op: 'run.create'; id: string; run: RunInfo; prompt: string | null }
  | { op: 'run.message'; runId: string; message: RunMessageDraft }
  | { op: 'run.tool_result'; runId: string; toolUseId: string; status: 'ok' | 'error' | 'interrupted'; outcome: string | null; output: string | null }
  | { op: 'run.end'; runId: string; run: RunInfo; usage: Usage | null }
  /** `limitResetsAt` (ISO) is set when the Comment reports a usage limit that says when it resets. */
  | { op: 'system_comment'; body: string; limitResetsAt?: string }
  | { op: 'turn'; turn: TurnRecord }
  | { op: 'rate_limit'; info: Record<string, unknown> }
  | { op: 'init'; claudeVersion: string | null; mcpServers: unknown[]; slashCommands: string[] | null };

export type Broadcast =
  | { type: 'live.delta'; delta: LiveDelta }
  | { type: 'live.status'; status: { kind: 'retrying'; attempt: number; maxRetries: number; error: string | null } | null };

export interface ProjectionResult {
  state: ProjectionState;
  mutations: Mutation[];
  broadcasts: Broadcast[];
}

export const TASK_MCP_SERVER = 'claude-task';
export const OUTPUT_DISPLAY_LIMIT = 20 * 1024;

const CREDENTIAL_ERRORS = new Set(['authentication_failed', 'billing_error', 'oauth_org_not_allowed', 'account_on_hold']);

export function initialProjection(): ProjectionState {
  return {
    turns: 0,
    turnStartedAt: null,
    toolCalls: 0,
    costSoFar: 0,
    comment: null,
    thinking: null,
    activity: null,
    tools: {},
    groups: {},
    runs: {},
    runByTool: {},
    runByCliTask: {},
    runTools: {},
    retrying: false,
    credentialReported: false,
    nextId: 0,
  };
}

/** Deterministic ids, so replaying a stream yields the same rows. */
export function projectionId(jobId: string, n: number): string {
  const h = createHash('sha256').update(`${jobId}:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Json = Record<string, any>;

export function project(prev: ProjectionState, event: unknown, ctx: ProjectionContext): ProjectionResult {
  // Deltas only stream to browsers: the state stays as it is (and needn't be stored again).
  if ((event as Json | null)?.type === 'stream_event') return { state: prev, mutations: [], broadcasts: deltaBroadcasts(prev, event as Json) };
  const s: ProjectionState = structuredClone(prev);
  // A state stored by an older build can lack the Run fields; keep the Job readable across a deploy.
  s.runs ??= {};
  s.runByTool ??= {};
  s.runByCliTask ??= {};
  s.runTools ??= {};
  const mutations: Mutation[] = [];
  const broadcasts: Broadcast[] = [];
  const out = { state: s, mutations, broadcasts };
  if (!event || typeof event !== 'object') return out;
  const e = event as Json;

  const newId = () => projectionId(ctx.jobId, s.nextId++);
  const startTurn = () => {
    s.turnStartedAt ??= ctx.receivedAt;
    s.lastInputAt ??= s.turnStartedAt;
  };
  const clearRetry = () => {
    if (!s.retrying) return;
    s.retrying = false;
    broadcasts.push({ type: 'live.status', status: null });
  };
  const closeText = () => {
    s.comment = null;
    s.thinking = null;
  };
  const updateGroup = (itemId: string) => {
    const entries = s.groups[itemId];
    if (entries) mutations.push({ op: 'item.update', id: itemId, payload: { kind: 'activity', entries } });
  };

  switch (e.type) {
    case 'system':
      handleSystem();
      break;
    case 'assistant':
      startTurn();
      clearRetry();
      if (e.parent_tool_use_id) handleRunMessage(e.parent_tool_use_id as string);
      else handleAssistant();
      break;
    case 'user':
      // Comments written to stdin so far go to the model with these results.
      if (!e.parent_tool_use_id) s.lastInputAt = ctx.receivedAt;
      handleToolResults();
      break;
    case 'result':
      handleResult();
      break;
    case 'rate_limit_event':
      if (e.rate_limit_info && typeof e.rate_limit_info === 'object') {
        const info = e.rate_limit_info as Record<string, unknown>;
        mutations.push({ op: 'rate_limit', info });
        s.limitResetsAt = info.status === 'rejected' && typeof info.resetsAt === 'number' ? info.resetsAt : null;
      }
      break;
  }
  return out;

  /** Offers the resume once per Turn, and only for a reset time that is still ahead. */
  function limitOffer(): { limitResetsAt?: string } {
    const at = s.limitResetsAt;
    if (typeof at !== 'number' || at * 1000 <= Date.parse(ctx.receivedAt)) return {};
    s.limitResetsAt = null;
    return { limitResetsAt: new Date(at * 1000).toISOString() };
  }

  function handleSystem() {
    if (e.subtype === 'init') {
      startTurn();
      const servers: Json[] = Array.isArray(e.mcp_servers) ? e.mcp_servers : [];
      mutations.push({ op: 'init', claudeVersion: typeof e.claude_code_version === 'string' ? e.claude_code_version : null, mcpServers: servers,
        slashCommands: Array.isArray(e.slash_commands) ? e.slash_commands.filter((name: unknown): name is string => typeof name === 'string').slice(0, 1000) : null });
      // HTTP servers are still `pending` at init; only a definite failure is worth a comment.
      const tools = servers.find((m) => m?.name === TASK_MCP_SERVER);
      if (tools && ['failed', 'needs-auth'].includes(tools.status)) {
        mutations.push({
          op: 'system_comment',
          body: `The Task Tools server failed to load (${tools.status}), so the agent can't read or update tasks in this run.`,
        });
      }
    } else if (e.subtype === 'local_command_output' && typeof e.content === 'string') {
      const text = e.content.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
      if (text) { mutations.push({ op: 'system_comment', body: text }); s.hasVisibleOutput = true; }
    } else if (e.subtype === 'api_retry') {
      const attempt = Number(e.attempt ?? 0);
      const maxRetries = Number(e.max_retries ?? 0);
      const error = typeof e.error === 'string' ? e.error : null;
      s.retrying = true;
      broadcasts.push({ type: 'live.status', status: { kind: 'retrying', attempt, maxRetries, error } });
      if (error && CREDENTIAL_ERRORS.has(error)) reportCredential(error);
      else if (maxRetries > 0 && attempt >= maxRetries) {
        mutations.push({ op: 'system_comment', body: `The Claude API kept failing${error ? ` (${error})` : ''}; gave up after ${attempt} attempts.` });
      }
    } else if (e.subtype === 'compact_boundary') {
      const tokens = e.compact_metadata?.pre_tokens;
      mutations.push({
        op: 'item.create',
        id: newId(),
        payload: { kind: 'notice', text: `Context compacted${typeof tokens === 'number' ? ` (${tokens.toLocaleString('en-US')} tokens before)` : ''}` },
      });
      closeText();
    } else if (e.subtype === 'task_started') {
      handleCliTaskStarted();
    } else if (e.subtype === 'task_notification') {
      handleCliTaskNotification();
    }
  }

  function handleCliTaskStarted() {
    const cliTaskId = typeof e.task_id === 'string' ? e.task_id : null;
    if (e.task_type === 'local_bash') {
      // A command the CLI keeps running after the Turn: a Run of its own, settled by its notification.
      if (e.is_backgrounded !== true) return;
      const id = newId();
      const run: RunInfo = {
        runType: 'command',
        // A command has no tool call of its own on the Timeline.
        toolUseId: null,
        description: oneLine(e.description ?? 'Background command', 120),
        subagentType: null,
        depth: 1,
        status: 'running',
        startedAt: ctx.receivedAt,
        finishedAt: null,
        toolCalls: 0,
        outcome: null,
        error: null,
      };
      s.runs[id] = { id, run, backgrounded: true };
      if (cliTaskId) s.runByCliTask[cliTaskId] = id;
      mutations.push({ op: 'run.create', id, run, prompt: null });
      mutations.push({ op: 'item.create', id, payload: { kind: 'run', run } });
      return;
    }
    if (e.task_type !== 'local_agent') return;
    const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : null;
    const runId = toolUseId === null ? undefined : s.runByTool[toolUseId];
    const state = runId === undefined ? undefined : s.runs[runId];
    if (!state) return;
    if (cliTaskId) s.runByCliTask[cliTaskId] = state.id;
    // A backgrounded subagent hands back at once; only its notification ends it.
    if (e.is_backgrounded === true) state.backgrounded = true;
  }

  function handleCliTaskNotification() {
    const cliTaskId = typeof e.task_id === 'string' ? e.task_id : null;
    const runId = cliTaskId === null ? undefined : s.runByCliTask[cliTaskId];
    if (!runId) return;
    const summary = typeof e.summary === 'string' && e.summary.trim() ? e.summary.trim() : null;
    const status = e.status === 'completed' ? 'ok' : 'error';
    const state = s.runs[runId];
    if (state) state.run.outcome = summary === null ? state.run.outcome : oneLine(summary, 120);
    // The CLI's task usage counts total tokens only, which the transcript's token breakdown cannot hold.
    settleRun(runId, status, status === 'error' ? clip(summary ?? 'failed', 2 * 1024) : null, null);
  }

  function handleAssistant() {
    const content: Json[] = Array.isArray(e.message?.content) ? e.message.content : [];
    if (content.some((b) => b?.type === 'text' && String(b.text ?? '').trim() !== '')) s.hasVisibleOutput = true;
    // Messages the CLI makes up itself (spend limits, API errors) aren't the Agent talking.
    if (e.message?.model === '<synthetic>') {
      const text = content.filter((b) => b?.type === 'text').map((b) => String(b.text)).join('\n').trim();
      if (text) mutations.push({ op: 'system_comment', body: text, ...limitOffer() });
      s.syntheticText = text || null;
      closeText();
      return;
    }
    for (const block of content) {
      if (block?.type === 'text') {
        const text = String(block.text ?? '');
        if (text.trim() === '') continue;
        s.activity = null;
        s.thinking = null;
        if (s.comment) {
          s.comment.body = `${s.comment.body}\n\n${text}`;
          mutations.push({ op: 'comment.update', id: s.comment.id, body: s.comment.body });
        } else {
          s.comment = { id: newId(), body: text };
          s.turnComment = s.comment.id;
          mutations.push({ op: 'comment.create', id: s.comment.id, body: text });
        }
      } else if (block?.type === 'thinking') {
        const text = String(block.thinking ?? '').trim();
        if (text === '') continue;
        s.comment = null;
        s.activity = null;
        if (s.thinking) {
          s.thinking.text = `${s.thinking.text}\n\n${text}`;
          mutations.push({ op: 'item.update', id: s.thinking.id, payload: { kind: 'thinking', text: s.thinking.text } });
        } else {
          s.thinking = { id: newId(), text };
          mutations.push({ op: 'item.create', id: s.thinking.id, payload: { kind: 'thinking', text } });
        }
      } else if (block?.type === 'tool_use') {
        closeText();
        s.toolCalls++;
        if (isRunTool(block.name)) {
          startRun(block, 1);
          continue;
        }
        const entry = toolEntry(block);
        const open = s.activity ? s.groups[s.activity] : undefined;
        if (s.activity && open) {
          open.push(entry);
          s.tools[entry.toolUseId] = { itemId: s.activity, index: open.length - 1 };
          updateGroup(s.activity);
        } else {
          s.activity = newId();
          s.groups[s.activity] = [entry];
          s.tools[entry.toolUseId] = { itemId: s.activity, index: 0 };
          mutations.push({ op: 'item.create', id: s.activity, payload: { kind: 'activity', entries: [entry] } });
        }
      }
    }
  }

  /** A Subagent Run's own output: its text and its tool calls, without its Thinking. */
  function handleRunMessage(parentId: string) {
    const runId = s.runByTool[parentId];
    const state = runId === undefined ? undefined : s.runs[runId];
    if (!runId || !state) return;
    const content: Json[] = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const block of content) {
      if (block?.type === 'text') {
        const text = String(block.text ?? '');
        if (text.trim() === '') continue;
        mutations.push({ op: 'run.message', runId, message: { type: 'text', text } });
      } else if (block?.type === 'tool_use') {
        s.toolCalls++;
        state.run.toolCalls++;
        const toolUseId = String(block.id ?? '');
        const name = String(block.name ?? 'tool');
        const child = isRunTool(name) ? startRun(block, state.run.depth + 1) : null;
        // A nested delegation is a tool call of this transcript too: its result settles its row.
        s.runTools[toolUseId] = { runId, name };
        mutations.push({
          op: 'run.message',
          runId,
          message: {
            type: 'tool',
            toolUseId,
            name,
            summary: summarizeTool(name, block.input ?? {}),
            status: 'pending',
            outcome: null,
            input: capStrings(block.input ?? null),
            output: null,
            childRunId: child,
          },
        });
        mutations.push(runItemUpdate(state));
      }
    }
  }

  /** A tool call named `Agent` (formerly `Task`) delegates to a subagent: it opens a Run, not an Activity entry. */
  function startRun(block: Json, depth: number): string {
    const id = newId();
    const input = (block.input ?? {}) as Json;
    const run: RunInfo = {
      runType: 'subagent',
      toolUseId: String(block.id ?? '') || null,
      description: oneLine(input.description ?? input.subagent_type ?? 'Subagent', 120),
      subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : null,
      depth,
      status: 'running',
      startedAt: ctx.receivedAt,
      finishedAt: null,
      toolCalls: 0,
      outcome: null,
      error: null,
    };
    const prompt = typeof input.prompt === 'string' ? input.prompt : null;
    s.runs[id] = { id, run, backgrounded: false };
    if (run.toolUseId) s.runByTool[run.toolUseId] = id;
    mutations.push({ op: 'run.create', id, run, prompt });
    mutations.push({ op: 'item.create', id, payload: { kind: 'run', run } });
    return id;
  }

  /** A Run ends: the Timeline item and the live registry both learn how. */
  function settleRun(runId: string, status: RunInfo['status'], error: string | null, runUsage: Usage | null) {
    const state = s.runs[runId];
    if (!state || state.run.status !== 'running') return;
    state.run.status = status;
    state.run.finishedAt = ctx.receivedAt;
    state.run.error = error;
    mutations.push(runItemUpdate(state));
    mutations.push({ op: 'run.end', runId, run: { ...state.run }, usage: runUsage });
  }

  function handleToolResults() {
    const content: Json[] = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const toolUseId = String(block.tool_use_id ?? '');
      const output = resultText(block.content);
      const isError = block.is_error === true;
      // A Stop rejects the running tool call: interrupted, not failed.
      const interrupted = isError && typeof e.tool_use_result === 'string' && /rejected/i.test(e.tool_use_result);

      // The hand-back of a Run's own call is not kept: it settles the Run.
      const runId = s.runByTool[toolUseId];
      const run = runId === undefined ? undefined : s.runs[runId];
      if (runId && run) {
        const status = interrupted ? 'interrupted' : isError ? 'error' : 'ok';
        // A backgrounded subagent hands back at once and reports later, on its task notification.
        if (!run.backgrounded || interrupted) {
          settleRun(runId, status, isError && !interrupted ? clip(output, 2 * 1024) : null, null);
        }
      }
      const inRun = s.runTools[toolUseId];
      if (inRun) {
        mutations.push({
          op: 'run.tool_result',
          runId: inRun.runId,
          toolUseId,
          status: interrupted ? 'interrupted' : isError ? 'error' : 'ok',
          outcome: interrupted ? 'interrupted' : outcome(inRun.name, output, isError, e.tool_use_result),
          // A delegation's hand-back is a report, not tool output: its Run keeps what matters.
          output: isRunTool(inRun.name) ? null : output,
        });
      }
      if (runId) continue;

      const where = s.tools[toolUseId];
      if (!where) continue;
      const entry = entryAt(where.itemId, where.index);
      if (!entry) continue;
      entry.output = output.length > OUTPUT_DISPLAY_LIMIT ? `${output.slice(0, OUTPUT_DISPLAY_LIMIT)}\n… (truncated)` : output;
      if (interrupted) {
        entry.status = 'interrupted';
        entry.outcome = 'interrupted';
      } else {
        entry.status = isError ? 'error' : 'ok';
        entry.outcome = outcome(entry.name, output, isError, e.tool_use_result);
      }
      updateGroup(where.itemId);
    }
  }

  function handleResult() {
    clearRetry();
    closeText();
    s.activity = null;
    // Calls still waiting won't get a result anymore (the Turn stopped first).
    mutations.push(...settleGroups(s));
    const total = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null;
    const costUsd = total === null ? null : Math.max(0, total - s.costSoFar);
    if (total !== null) s.costSoFar = Math.max(s.costSoFar, total);
    const subtype = String(e.subtype ?? 'unknown');
    // A Stop (control-request interrupt) ends the Turn with `error_during_execution` and
    // `terminal_reason: aborted_*`: expected, not a failure to report (docs/specs/agent-sessions.md).
    const aborted = typeof e.terminal_reason === 'string' && e.terminal_reason.startsWith('aborted');
    const isError = !aborted && (e.is_error === true || subtype !== 'success');
    const summary: TurnSummary = {
      durationMs: Number(e.duration_ms ?? 0),
      toolCalls: s.toolCalls,
      costUsd,
      subtype,
      isError,
      usage: usage(e.usage, costUsd),
    };
    mutations.push({ op: 'item.create', id: newId(), payload: { kind: 'turn_summary', summary } });
    mutations.push({
      op: 'turn',
      turn: {
        ...summary,
        index: s.turns,
        startedAt: s.turnStartedAt ?? ctx.receivedAt,
        finishedAt: ctx.receivedAt,
        stopReason: typeof e.stop_reason === 'string' ? e.stop_reason : null,
        commentId: s.turnComment ?? null,
        readUpTo: s.lastInputAt ?? s.turnStartedAt ?? ctx.receivedAt,
      },
    });
    if (isError) {
      const detail = typeof e.result === 'string' && e.result.trim() ? e.result.trim() : null;
      const errors = Array.isArray(e.errors) ? e.errors.filter((x: unknown) => typeof x === 'string') : [];
      // The synthetic message already said it (spend limits, API errors).
      if (!detail || detail !== s.syntheticText) mutations.push({ op: 'system_comment', body: resultMessage(subtype, detail ?? errors.join('\n')), ...limitOffer() });
    } else if (!s.hasVisibleOutput && s.toolCalls === 0 && typeof e.result === 'string' && e.result.trim()) {
      mutations.push({ op: 'system_comment', body: e.result.trim() });
    }
    s.hasVisibleOutput = false;
    s.turnComment = null;
    s.lastInputAt = null;
    s.syntheticText = null;
    s.limitResetsAt = null;
    s.turns++;
    s.turnStartedAt = null;
    s.toolCalls = 0;
    s.tools = {};
    s.groups = {};
  }

  function reportCredential(error: string) {
    if (s.credentialReported) return;
    s.credentialReported = true;
    const why: Record<string, string> = {
      authentication_failed: 'was rejected',
      billing_error: 'has a billing problem',
      oauth_org_not_allowed: "belongs to an organization that doesn't allow this use",
      account_on_hold: 'is on hold',
    };
    mutations.push({
      op: 'system_comment',
      body: `Credential **${ctx.credentialName}** ${why[error] ?? 'failed'} (${error}). Check it in Credentials.`,
    });
  }

  function entryAt(itemId: string, index: number): ActivityEntry | null {
    return s.groups[itemId]?.[index] ?? null;
  }
}

/**
 * The Job is over (its process exited or is gone): tool calls and Runs still waiting will never
 * get a result. Pure, like `project`, and a no-op once settled.
 */
export function endJob(prev: ProjectionState): ProjectionResult {
  const at = new Date().toISOString();
  const s: ProjectionState = structuredClone(prev);
  const mutations = settleGroups(s);
  for (const state of Object.values(s.runs ?? {})) {
    if (state.run.status !== 'running') continue;
    state.run.status = 'interrupted';
    state.run.finishedAt = at;
    mutations.push(runItemUpdate(state));
    mutations.push({ op: 'run.end', runId: state.id, run: { ...state.run }, usage: null });
  }
  return { state: s, mutations, broadcasts: [] };
}

/** The item mutation that keeps a Run's Timeline row in step with its state. */
function runItemUpdate(state: RunState): Mutation {
  return { op: 'item.update', id: state.id, payload: { kind: 'run', run: { ...state.run } } };
}

/** Marks every pending call of the Turn's Activity groups interrupted; one update per changed group. */
function settleGroups(s: ProjectionState): Mutation[] {
  const settle = (entries: ActivityEntry[]): boolean => {
    let changed = false;
    for (const entry of entries) {
      if (entry.status === 'pending') {
        entry.status = 'interrupted';
        entry.outcome ??= 'interrupted';
        changed = true;
      }
    }
    return changed;
  };
  const mutations: Mutation[] = [];
  for (const [id, entries] of Object.entries(s.groups)) {
    if (settle(entries)) mutations.push({ op: 'item.update', id, payload: { kind: 'activity', entries } });
  }
  return mutations;
}

function deltaBroadcasts(s: ProjectionState, e: Json): Broadcast[] {
  if (e.parent_tool_use_id) return [];
  const delta = e.event?.type === 'content_block_delta' ? e.event.delta : null;
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ type: 'live.delta', delta: { kind: 'text', commentId: s.comment?.id ?? null, text: delta.text } }];
  if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') return [{ type: 'live.delta', delta: { kind: 'thinking', commentId: null, text: delta.thinking } }];
  return [];
}

function toolEntry(block: Json): ActivityEntry {
  const name = String(block.name ?? 'tool');
  return {
    toolUseId: String(block.id ?? ''),
    name,
    summary: summarizeTool(name, block.input ?? {}),
    status: 'pending',
    outcome: null,
    input: capStrings(block.input ?? null),
    output: null,
  };
}

/** Long strings in a tool's input (a whole file being written) are cut for display; the raw stream keeps them. */
function capStrings(value: unknown): unknown {
  if (typeof value === 'string') return value.length > OUTPUT_DISPLAY_LIMIT ? `${value.slice(0, OUTPUT_DISPLAY_LIMIT)}\n… (truncated)` : value;
  if (Array.isArray(value)) return value.map(capStrings);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capStrings(v)]));
  return value;
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
/** The CLI's subagent tool: `Agent`, and `Task` before it was renamed. */
const isRunTool = (name: unknown) => name === 'Agent' || name === 'Task';
const oneLine = (s: unknown, max = 80) => {
  const line = String(s ?? '').split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** One readable line per tool call. */
export function summarizeTool(name: string, input: Json): string {
  const path = input.file_path ?? input.notebook_path ?? input.path;
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Edited ${code(String(path ?? 'a file'))}`;
    case 'Write':
      return `Wrote ${code(String(path ?? 'a file'))}`;
    case 'Read':
      return `Read ${code(String(path ?? 'a file'))}`;
    case 'Bash':
      return `Ran ${code(oneLine(input.command))}`;
    case 'Grep':
      return `Searched for ${code(oneLine(input.pattern, 60))}${input.path ? ` in ${code(String(input.path))}` : ''}`;
    case 'Glob':
      return `Listed ${code(oneLine(input.pattern, 60))}`;
    case 'WebFetch':
      return `Fetched ${oneLine(input.url)}`;
    case 'WebSearch':
      return `Searched the web for “${oneLine(input.query, 60)}”`;
    case 'Task':
    case 'Agent':
      return `Started a subagent: ${oneLine(input.description ?? input.subagent_type ?? 'task', 60)}`;
    case 'TodoWrite':
      return 'Updated the to-do list';
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return mcp[1] === TASK_MCP_SERVER ? `Task tool ${code(mcp[2]!)}` : `${mcp[1]}: ${code(mcp[2]!)}`;
  return `Used ${code(name)}`;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: Json) => (c?.type === 'text' ? String(c.text ?? '') : c?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function outcome(name: string, output: string, isError: boolean, structured: unknown): string | null {
  if (name === 'Bash') {
    if ((structured as Json | undefined)?.interrupted) return 'interrupted';
    // Trust the tool's error flag: successful output can itself contain "exit code N"
    // (for example a test runner reporting a child process).
    if (!isError) return 'exit 0';
    const exit = /exit code[: ]+(\d+)/i.exec(output)?.[1];
    return exit ? `exit ${exit}` : 'failed';
  }
  return isError ? oneLine(output, 120) || 'failed' : null;
}

function usage(raw: unknown, costUsd: number | null): Usage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Json;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheCreationTokens: n(u.cache_creation_input_tokens),
    costUsd: costUsd ?? 0,
  };
}

function resultMessage(subtype: string, detail: string): string {
  const what: Record<string, string> = {
    error_max_turns: 'The turn stopped: it reached the maximum number of steps.',
    error_during_execution: 'The turn stopped because of an error.',
    error_max_budget_usd: 'The turn stopped: it reached its budget.',
  };
  const head = what[subtype] ?? (subtype === 'success' ? 'The turn ended with an error.' : `The turn stopped (${subtype}).`);
  return detail ? `${head}\n\n> ${detail.split('\n').join('\n> ')}` : head;
}
