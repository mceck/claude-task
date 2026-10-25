# Recorded stream-json fixtures

Real `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
output, one event per line, used by `test/projection.test.ts`. Machine-specific fields (paths, local
plugins and skills) are stripped; everything else is as the CLI printed it.

- `spend-limit.jsonl` — Claude Code 2.1.310: a Turn refused by an organization spend limit
  (`rate_limit_event` with status `rejected`, a `<synthetic>` assistant message, a `result` with
  `subtype: success` and `is_error: true`).

The spike in Spec 02 (ADR 0005) records more of them: a mid-turn message, an interrupt, thinking,
subagents and compaction. Until then those cases are covered by `test/helpers/stream.ts`, which
mirrors the same shapes.
