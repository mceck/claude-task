---
status: done
---

# Session context usage

## Specs

- [Agent Sessions](../specs/agent-sessions.md) (Session chip, Turn Summary and Turn record, Data model)
- [Clients](../specs/clients.md) (Task view header, Wiki Chat header, native app conversation header)
- [Conversation](../specs/conversation.md) (Sessions in a Task's conversation)

## Problem

A Task's conversation grows with every Turn and the Agent only has so much context before Claude Code compacts it. Neither client shows how full that context is, so a User cannot tell whether a long conversation is about to be compacted, or compare the cost of continuing in the same Session with starting fresh.

## Solution

Each Turn records its **Context Usage**: the prompt tokens of the Turn's last top-level assistant message plus the output it produced, and the model's context window from the `result`'s `modelUsage`. The `result`'s own usage is not used because it sums every model call of the Turn and counts the cached prompt once per call.

A Session reports the Context Usage of its latest Turn in `TaskSession.context` (null before the first Turn or when the stream says nothing). Both clients show it beside the Session chip in the Task view header, in a Wiki Chat header and in the native app's conversation header, and again as a read-only property in the Task details (the web panel and the native sheet): `120.2K (53%)`, with `K` below a million and `M` from a million, the percentage rounded and capped at 100, a small ring filled to it and the exact counts in the tooltip. The chip is neutral below 70%, amber from 70% and red from 90%.

Clients update it through the existing `session.changed` event, which the scheduler publishes when a Turn lands.

Turns recorded before the field existed are filled when the backend starts: it replays each Job's raw stream with the same projection and writes only the empty columns. A Turn the stream cannot measure gets 0 tokens, which the Session view ignores and which keeps the next startup from replaying that Job.

## Decisions

- **The last assistant message, not the `result` usage.** The `result` reports the sum over the Turn's model calls (for a four-call Turn, four cached prompts), which is not what the conversation holds. The last top-level message is the real size at the end of the Turn. Subagent messages (`parent_tool_use_id`) and synthetic messages are ignored, so a Run cannot move the Session's context.
- **Output tokens count.** The reply of the last model call goes back into the next prompt, so it is part of what the window must fit.
- **The window comes from the CLI.** `modelUsage.contextWindow` is the model's own number (for example 1M), which is better than a table of models in the backend. When it is absent, the token count is still shown, without a percentage.
- **Per Turn, not live.** Context is recorded when a Turn ends, with the rest of the Turn record, and reaches clients on `session.changed`. Streaming a mid-Turn estimate would need a new real-time event for a number that changes on every tool result.
- **One chip beside the Session state.** Context is a property of the conversation, not of the Task, so it sits where the Session state already is rather than among the editable Task fields.
- **Backfill by replay, not by guessing.** Existing conversations show the chip right after the upgrade instead of waiting for their next Turn. Replaying the stored stream with the same projection guarantees the same numbers as a live Turn; falling back to the summed `result` usage already in `turns` would show an inflated number. A 0-token row marks a Turn the stream cannot measure, so the backfill is a one-time pass and not a rewrite of history on every boot.

## Acceptance criteria

- [x] A `result` records the Context Usage of the Turn's last top-level assistant message, with the window from `modelUsage`.
- [x] Subagent and synthetic messages, Turns without a model call, and CLIs without `modelUsage` behave as described above.
- [x] `GET /tasks/:id/session` carries the latest Turn's context and null before the first Turn.
- [x] The web Task view, Wiki Chat and schedule run headers show the chip, and the native app's conversation header shows it too.
- [x] Tokens format as `120.2K` and `1.2M`, the percentage is rounded and capped, and high usage changes the tone.
- [x] Existing Turns are backfilled from their raw stream at startup, without replaying them on later starts.
- [x] Backend tests cover the projection, the Session API and the backfill; specs, glossary and manual are updated.
