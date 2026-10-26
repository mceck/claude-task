---
status: accepted
---

# Deliver comments to a running job by writing to stdin mid-turn

A comment on a task whose job is running gets written to the `claude` process's stdin right away as a stream-json user message, without waiting for the turn to end. The agent sees the message at its next model call, i.e. after the current tool batch, within the same Turn.

## Consequences

- No fallback needed. (Had it failed, comments would be held until the turn's `result` and then written to stdin to start the next turn in the same process.)
- The Runner must treat a stdin message written during a Turn as part of that Turn: one `result` covers it. A message written while idle starts a new Turn.

## Verification — 2026-10-26

Claude Code 2.1.310, `claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions`, model `claude-sonnet-5-5`. Recordings (sanitized) are in `backend/test/fixtures/streams`.

1. **Mid-turn injection works** (`mid-turn-message.jsonl`, with `--replay-user-messages`). Three sequential 12 s Bash calls; a second user message written 3 s into the first call was consumed right after that tool result (replayed in the stream at that point), the model changed course, and one `result` ended the Turn with the instruction honored. `--replay-user-messages` is the only way to see *when* a stdin message is consumed; without it the stream shows nothing at consumption time.
2. **Interrupt**: use the stream-json control request `{"type":"control_request","request_id":"...","request":{"subtype":"interrupt"}}` (`interrupt-control-request.jsonl`). The CLI answers with a `control_response` (`success`, `still_queued: []`), the running tool is rejected with "[Request interrupted by user for tool use]", the Turn ends with `result` `subtype: error_during_execution`, `is_error: true`, `terminal_reason: aborted_tools`, no `result` text and a diagnostic in `errors` (the projector treats `aborted_*` as an expected stop, with no error comment), and **the process stays alive**: a following user message ran a normal Turn in the same session. **SIGINT** also ends the Turn but then **exits the process** (code 0), so it is not an interrupt, only a stop.
3. **Closing stdin drains queued input** (`stdin-close-queued.jsonl`): after the first `result`, two messages written back to back and stdin closed were each processed as their own Turn (each with its own `result`), then the process exited with code 0. Messages written while idle are therefore *not* merged: one Turn per message. The Runner should merge pending comments into a single stdin message itself.
4. **Session id / resume**: `--session-id <uuid>` creates the session; `--resume <uuid>` in a new process remembers earlier context, in the same directory and also from a different working directory (it worked in a different worktree here). We still keep deterministic worktree paths, because tool state and relative paths depend on the cwd, but a changed cwd is not fatal.
5. **Thinking**: `thinking` content blocks are present in the stream (and `thinking_delta` partial events), but their `thinking` text is **empty** and only `signature` is filled, for `claude-sonnet-5-5` with default settings and with `--effort high` or `showThinkingSummaries`. The Timeline shows nothing for them (the projector skips empty thinking); the agent's reasoning is not observable (`thinking-redacted.jsonl`).
6. **Partial messages**: `--include-partial-messages` emits `stream_event` lines (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`) with `text_delta`s, usable for live streaming (`partial-messages.jsonl`, `input_json_delta` events stripped).
7. **`CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`**: after killing the process (SIGKILL) mid-tool, `--resume <id>` with the variable set continued the turn on its own with no new input: it re-ran the interrupted tool and finished the answer (`resume-interrupted-turn.jsonl`). Without the variable, resuming with no input did nothing (no events but `init`).
8. **MCP over HTTP with a bearer header** works under `-p` with `--mcp-config` (`type: http`, `headers.Authorization`): the server received the header on every request (`initialize`, `tools/list`, `tools/call`) and the agent used the tool (`mcp-http-tool.jsonl`). A `server/discover` probe precedes `initialize`; the server must answer non-fatally.

Also observed: a Bash `sleep N` as the first command is blocked by the CLI ("To wait for a condition, use ..."); tests and prompts must not rely on it. Not yet exercised: nested subagent activity and compaction fixtures.

The earlier 2026-10-25 attempt had been refused by the organization's spend limit (`spend-limit.jsonl`).
