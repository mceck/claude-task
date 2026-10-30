---
status: done
---

# Active Runs: Subagent Runs and Background Commands

## Specs

- [Agent sessions](../specs/agent-sessions.md)
- [Runner](../specs/runner.md)
- [Clients](../specs/clients.md)

The manual page [Agent sessions and queues](../manual/agent-sessions-and-queues.md) gains a section on following Runs.

## Problem Statement

When an Agent delegates work, people see almost nothing of it. A Subagent Run shows on the Timeline as one Activity entry, "Started a subagent: …", and its tool calls nest under it with no status; its text and thinking never appear. A Background Command shows as an ordinary `Bash` call that returns "running in background" and gives no sign of when it ended or how. While several of them run at once, nobody can tell what the Agent is doing or whether a delegated piece is stuck, and there is no way to read what a subagent is writing as it works.

## Solution

While a Turn runs, a thin bar sits above the composer and lists the Task's **Active Runs**: its Subagent Runs and Background Commands, each with what it is doing and how long it has been going. Clicking one opens a dialog with its live transcript: the subagent's Markdown text and its tool calls with input and output (no Thinking), or the background command's final summary, plus the prompt the Agent gave it and the token usage when the CLI reports it. The Timeline keeps only a trace of each Run — that it started, how it ended, and the error when it failed — so the transcript is a live view, not a history.

## User Stories

1. As a User watching a Task, I want a bar above the composer listing the Agent's active Subagent Runs, so that I can tell when it is working through several of them at once.
2. As a User, I want each entry to show what the run is doing (its description, its subagent type and how long it has run), so that I can tell a long delegation from a stuck one.
3. As a User, I want to click a run and read the subagent's text as it is written, so that I can follow the reasoning through its output rather than guessing from the final answer.
4. As a User, I want to see the tool calls a subagent makes, with their input and output, so that I can tell what it is reading, running and editing.
5. As a User, I want the subagent's Thinking left out, so that the dialog stays readable and cheap to follow.
6. As a User, I want to see the prompt the Agent gave the subagent, in a collapsed section, so that I can judge whether a run is doing the right thing.
7. As a User, I want the token usage and tool count of a run when the CLI reports them, so that I can see what it cost.
8. As a User, I want a Background Command in the same bar with its status and its final summary, so that a long-running check or server is visible while it runs and I learn how it ended.
9. As a User, I want a run that finishes successfully to leave the bar on its own, so that the bar only holds what still matters.
10. As a User, I want a run that failed to stay in the bar until I dismiss it, so that I notice the failure and can read the error.
11. As a User, I want the Timeline to keep a trace of every run — spawned, finished, its duration, its tool count and the error if there was one — so that I can reconstruct what happened after the run is gone.
12. As a User, I want clicking a trace row to open the same dialog, so that a recent run's transcript is still reachable after it finished in this page session.
13. As a User, I want the bar to appear only while something is active or an error is waiting, so that it doesn't take room when there is nothing to show.
14. As a User opening a Task in the middle of a run, I want the bar to show what is running now, so that I don't have to wait for the next run to see anything.
15. As a User on a phone, I want the same bar and the same transcript in a bottom sheet, so that the feature works away from the desktop.
16. As a User following a long run, I want the transcript to keep moving to the newest text until I scroll up, so that I can either watch or read back.
17. As a User in a Task with nested delegation (a subagent that starts one of its own), I want each level as its own entry and its own row, so that I can open any of them.
18. As a User reading the Timeline, I want the `Agent` tool call gone from Activity, so that runs appear once, in their own form, instead of twice.
19. As an operator, I want the live transcripts kept in memory only and capped, so that a chatty subagent cannot grow the database or a browser without bound.
20. As a User of an installation whose CLI is older than the flag, I want the feature to degrade to tool calls only instead of failing the Job.
21. As a User, I want the run's transcript kept per page session, so that reopening the Task after a reload doesn't resurrect runs that ended long ago.
22. As a User of a Wiki Chat, I want the same bar and dialog there, so that Wiki work is as visible as a Task's.
23. As a User, I want a run cut off by Stop, a Job end or a container restart to read as interrupted, so that its trace explains why it has no outcome.

## Implementation Decisions

### Domain and persisted model

- The glossary gains **Run** (a Subagent Run or a Background Command), on top of **Subagent Run**, **Background Command** and **Active Run**.
- A Run is identified by its own Agent Item id; it also keeps the id of the tool call that started it, which is how its output is matched.
- A new Agent Item kind `run` carries:
  ```ts
  export interface RunInfo {
    runType: 'subagent' | 'command';
    toolUseId: string | null; // the call that started a subagent; null for a Background Command
    description: string;
    subagentType: string | null;
    depth: number; // 1 when the Agent started it directly
    status: 'running' | 'ok' | 'error' | 'interrupted';
    startedAt: string;
    finishedAt: string | null;
    toolCalls: number;
    outcome: string | null; // short result line: a command's final summary
    error: string | null; // why it failed, cut at 2 KB
  }
  ```
  and its payload is `{ kind: 'run'; run: RunInfo }`.
- A migration adds `run` to the `agent_item_kind` enum.
- `ActivityEntry.children` is removed; an `Agent` (formerly `Task`) tool call no longer creates a Timeline Activity entry at all.
- The Turn Summary keeps counting the tool calls of Subagent Runs, so a delegated Turn's step count stays truthful.

### Projection rules

The projection stays a pure function over the stream; the transcript is carried in mutations, not in the projection state (the state lives in a `jobs.projection` row and must not grow with tool output).

- An assistant `tool_use` in the main session named `Agent` or `Task` creates a Run (`runType: 'subagent'`, `description` from `input.description`, `subagent_type` from `input.subagent_type`, prompt from `input.prompt`) and is not added to Activity. A `tool_use` with a parent that belongs to a Run creates a nested Run with `depth` one higher.
- Assistant messages whose `parent_tool_use_id` matches a Run's tool call go to that Run: `text` blocks become text messages, `tool_use` blocks become tool messages, and `thinking` blocks are dropped. No Activity nesting.
- `tool_result` blocks update the matching transcript tool message (status, outcome, output cut at 20 KB) wherever the parent. The `tool_result` of an `Agent` call is the hand-back report: it settles the Run and its body is not kept.
- A Run settles as `ok` or `error` (with the tool result's text, cut at 2 KB) on that tool result; as `interrupted` when the result is a rejection (Stop) or the Job ends first. When `system/task_started` marked the call `is_backgrounded`, the tool result does not settle it: its `system/task_notification` does.
- `system/task_started` with `task_type: 'local_bash'` and `is_backgrounded: true` creates a Run of `runType: 'command'` (no prompt, no transcript messages); it settles on its `task_notification`, whose `summary` becomes `outcome` and whose non-`completed` status becomes `error`. `local_agent` starts, `task_progress`, `task_updated` and `background_tasks_changed` change nothing; a foreground `local_bash` produces nothing.
- `endJob` settles every Run still `running` as `interrupted`, exactly as it settles pending tool calls, and remains a no-op afterwards.
- New projection mutations, applied after commit like the others:
  ```ts
  | { op: 'run.create'; id: string; run: RunInfo; prompt: string | null }
  | { op: 'run.message'; runId: string; message: RunMessageWithoutIndex }
  | { op: 'run.tool_result'; runId: string; toolUseId: string; status: RunToolMessage['status'];
      outcome: string | null; output: string | null }
  | { op: 'run.end'; runId: string; run: RunInfo; usage: Usage | null }
  ```

### Live transcript

- The backend keeps a **Run Registry** in memory, one process-wide map keyed by Run id, holding each Run's `RunInfo`, its prompt, its messages and its usage. It is updated after the transaction commits, so a rolled-back event never leaks into a transcript, and it is not written to Postgres.
- Messages are numbered per Run with `n`, starting at 0, so a snapshot and the live events can be merged without guessing:
  ```ts
  export interface RunTextMessage { type: 'text'; n: number; text: string }
  export interface RunToolMessage {
    type: 'tool'; n: number; toolUseId: string; name: string; summary: string;
    status: 'pending' | 'ok' | 'error' | 'interrupted'; outcome: string | null;
    input: unknown; output: string | null; childRunId: string | null;
  }
  export type RunMessage = RunTextMessage | RunToolMessage;
  export interface RunTranscript {
    run: RunInfo; prompt: string | null; usage: Usage | null;
    messages: RunMessage[]; nextIndex: number; truncated: boolean;
  }
  ```
- Limits: 500 messages and 2 MB of serialized messages per Run, then `truncated` and no further messages; 20 KB per text block, tool input and tool output; 30 Runs per Job, evicting the oldest finished one first. A Run unavailable in the registry answers `404` and the clients show the trace alone.
- The registry lives as long as the Job: a Run that outlives its Turn (a Background Command) stays readable, and everything goes when the Job ends.
- There is no token-level streaming for Runs: the CLI reports partial deltas only for the main session. Text appears per message.
- The registry is bounded per Job (30 Runs × 2 MB) so a single Job cannot exhaust the backend's memory.

### API and real-time

- `GET /tasks/:id/runs` returns `{ runs: (RunInfo & { id: string })[] }` for the Task's active Job: Running Runs first, then errored ones, by start time. It answers `[]` for a Task without an active Job. It serves Wiki Chats like any Task.
- `GET /tasks/:id/runs/:runId` returns `RunTranscript & { id: string }`, or `404` when the Run is not in the registry. Both endpoints use the Timeline's permissions.
- Two new events on `task:<id>`:
  ```ts
  | { type: 'run.updated'; taskId: string; run: RunInfo & { id: string } }
  | { type: 'run.message'; taskId: string; runId: string; message: RunMessage }
  ```
  `run.updated` fires when a Run starts and when it ends; `run.message` for every transcript message and tool-result update (carrying the message's `n`).

### Runner

- `job.start`'s Claude arguments gain `forwardSubagentText: true`, which the backend always sets; no protocol version change (both ends are built together into the Base Image).
- Before spawning `claude`, the Runner asks the same executable it will spawn for `--version` (through the Worktree's mise shims, where a repository can override it) and adds `--forward-subagent-text` only for 2.1.211 and later. A failed or unparseable probe omits the flag. One probe per Job, 10 seconds at most.
- Without the flag the Run still exists and shows its tool calls; only its text is missing.

### Clients

- Web: a `Active Runs` bar between the Timeline and the composer, outside the scroll viewport, rendered only when it has entries. Each chip shows a kind icon, the description (truncated), the elapsed time, the tool count and, for a failure, a dismiss button. Successful and interrupted Runs leave it; errored Runs stay until dismissed in this page session.
- The bar and the dialog read from a separate per-Task store (like the Live Turn preview store), populated by `run.updated`/`run.message` and by `GET /tasks/:id/runs` when the Task opens or the connection comes back. A reload starts from that endpoint again, so runs that ended before it are not resurrected; their Timeline trace remains.
- The dialog (shadcn `Dialog`, one Run at a time) shows the description, subagent type, status, live duration, tool count, token usage when known, a collapsed "Prompt" section and the transcript: Markdown text and expandable tool calls with input and output, no Thinking. It follows the newest message until the reader scrolls up, like the Live Turn preview.
- Opening fetches the snapshot, buffers the `run.message` events that arrive meanwhile, and drops the buffered ones below the snapshot's `nextIndex`; on `run.updated` with a final status it refetches once for the final outcome and usage.
- The Timeline renders a `run` item as a compact row (icon, description, status, duration, tool count, inline error) that opens the same dialog, from the store when it has the transcript and from the item alone otherwise.
- Mobile: the same store in the controller, the same bar above the composer and the same transcript in a modal bottom sheet with the same follow rule.
- On disconnect, Run stores are cleared like the Live Turn previews; reconnection refetches the active Runs and the open snapshot.
- Because Activity renders from `ActivityEntry` without `children`, the web and mobile renderers lose the nested rendering, which no longer exists in the data.

## Testing Decisions

- **Projection (pure, table-driven)**: the highest seam for the stream rules. The existing `partial-messages` recording, which holds a real Background Command, plus builder-driven cases for a subagent, a nested subagent and the rest. Covers: the Run item and the absence of an Activity entry, transcript messages, tool results, nested Runs, settling (tool result, backgrounded notification, Stop rejection, Job end), ignored `task_*` variants, the 500-message/2 MB limits and 20 KB cuts, and that `jobs.projection` grows by a constant amount whatever the transcript length. Prior art: `projection.test.ts` with `helpers/stream.ts` and the `fixtures/streams` recordings.
- **Backend API, WebSocket and the Registry (public seam, fake Runner)**: subscribe to the Task topic, replay the events of a Turn, and assert the Run items, the `run.updated`/`run.message` events, the two endpoints (running, finished, `404` after the Job ends), and the same for a Wiki Chat. Prior art: `sessions.test.ts`, `realtime.test.ts`, `wikis.test.ts`. The caps (message count, bytes, 30 Runs and the eviction order) are asserted on the Registry itself: reaching them through the public API would take thousands of events.
- **Runner (black box)**: a fake `claude` whose `--version` answers above and below the threshold, asserting the flag is passed only above it and that a failing probe still starts the Job. Prior art: the Runner's existing fake-executable tests.
- **Web (Playwright)**: drive a Run through the e2e `__test/runners` injection, then assert the bar chip, the dialog's text and tool call, the disappearance on success, the dismissal of an error and the Timeline trace. Prior art: `frontend/e2e/agents.spec.ts`.
- **Mobile (Dart)**: controller tests for the store (snapshot merge by `n`, dismissal, clearing on disconnect) and a widget test for the bar and sheet. Prior art: `controller_test.dart`, `live_text_test.dart`.

## Acceptance Criteria

- [x] A Subagent Run started by an Agent appears in the bar within the Turn, with its description and a running status.
- [x] The dialog shows the subagent's text and tool calls as they arrive, without Thinking, following the newest message until the reader scrolls up.
- [x] A Background Command appears in the bar with its status, and its final summary appears when it ends.
- [x] A successful Run leaves the bar when it ends; an errored Run stays until dismissed, with its error readable.
- [x] The Timeline keeps one `run` row per Run (spawned, outcome, duration, tool calls, error), clickable to reopen the dialog.
- [x] The `Agent` tool call no longer appears as an Activity entry, and `ActivityEntry.children` is gone from the shared types and both clients.
- [x] Nested subagents each have their own bar entry, Timeline row and dialog.
- [x] `GET /tasks/:id/runs` and `GET /tasks/:id/runs/:runId` behave as described, including for a Wiki Chat, and answer `404` once the Job is over.
- [x] A Task opened mid-run shows the running Runs from the endpoint; a reload does not resurrect Runs that ended before it.
- [x] Runs cut off by Stop, Job end or a lost container read as interrupted in the Timeline and leave the bar.
- [x] Transcripts respect the 500-message/2 MB limits, the 20 KB cuts and the 30-Runs-per-Job cap; nothing is written to Postgres.
- [x] On a CLI older than 2.1.211 the Job still starts, with tool calls only and no text.
- [x] The Turn Summary of a delegated Turn still counts the subagent's tool calls.
- [x] Specs and the manual describe the bar, the dialog and the live-only nature of transcripts.

## Out of Scope

- Live stdout of a Background Command: its output stays in the container's file and only its final summary is kept.
- Persisting transcripts, the prompt or the subagent's report; the Timeline keeps the trace alone.
- Thinking of a Subagent Run, even when the CLI forwards it.
- Token-level streaming of a Run's text.
- Stopping or killing a single Run from the UI.
- Notifications for a failed Run beyond its Timeline trace.
- Replaying transcripts after a backend restart.

## Further Notes

- The CLI's `Task` tool is the old name of `Agent`; both start a Subagent Run.
- `--forward-subagent-text` exists from Claude Code 2.1.211, and the pinned default version is already above it. The version probe is still needed because a repository's mise configuration can override `claude` per Worktree; the threshold is verified against `claude --help` when the Base Image's version changes.
- System task events (`task_started`, `task_notification`) were read from a real 2.1.314 stream during the design; without them a Background Command simply never appears, while Subagent Runs keep working from the tool call alone.
- No dependency on other tasks.
