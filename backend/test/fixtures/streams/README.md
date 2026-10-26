# Recorded stream-json fixtures

Real `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
output, one event per line, used by `test/projection.test.ts`. Machine-specific fields (paths, local
plugins and skills) are stripped; everything else is as the CLI printed it.

- `spend-limit.jsonl` — Claude Code 2.1.310: a Turn refused by an organization spend limit
  (`rate_limit_event` with status `rejected`, a `<synthetic>` assistant message, a `result` with
  `subtype: success` and `is_error: true`).

Recorded by the spike in Spec 02 (ADR 0005, 2026-10-26, Claude Code 2.1.310, `claude-sonnet-5-5`):

- `mid-turn-message.jsonl` — user message written during a tool call, consumed after it (`--replay-user-messages`).
- `interrupt-control-request.jsonl` — `control_request` interrupt: `error_during_execution`, process stays alive.
- `stdin-close-queued.jsonl` — queued messages drained one Turn each after stdin closes.
- `thinking-redacted.jsonl` — `thinking` blocks with empty text and a signature.
- `partial-messages.jsonl` — `--include-partial-messages` `stream_event`s (`input_json_delta` stripped).
- `mcp-http-tool.jsonl` — an MCP tool call over HTTP with a bearer header.
- `resume-interrupted-turn.jsonl` — `--resume` with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` after a kill.

Subagents and compaction are not recorded yet; they are covered by `test/helpers/stream.ts`, which
mirrors the same shapes.
