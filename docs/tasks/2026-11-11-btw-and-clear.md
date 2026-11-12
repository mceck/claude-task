---
status: done
---

# Btw side questions and Clear

## Specs

- [Conversation](../specs/conversation.md#btw)
- [Agent sessions](../specs/agent-sessions.md#btw)
- [Runner](../specs/runner.md#btw-forks)
- [Clients](../specs/clients.md#btw-and-clear-in-the-clients)
- Glossary: Btw, Btw Comment, Btw Thread, Btw Job, Clear, Chat Cleared line in `docs/CONTEXT.md`.

## Problem Statement

Users want Claude Code's `/btw`: ask a quick question about the ongoing work while the Agent is busy, without interrupting it and without polluting its conversation. Claude Code 2.1.310 does not run `/btw` in headless stream-json mode (it ends as `unavailable_headless` after the Turn and never asks the model), so today the command is useless in a Task. Users also lack `/clear`: today it is delivered as plain text, and there is no way to start the Agent's conversation over while keeping the Task's history.

## Solution

`/btw <question>` in the composer creates a Btw Comment, styled like an Internal Note in its own colour, and the Agent answers it as a Btw Comment from a tool-less fork of the Session. Replying to a Btw Comment continues that thread; a new `/btw` starts from the current Session. The Agent's Turn never notices. `/clear` starts a fresh Claude conversation for the Task when the Agent's work ends, keeping every Comment and leaving a "Chat cleared" line. Web and Flutter clients support both.

## User Stories

1. As a User, I want to type `/btw` with a question while the Agent works, so that I get an answer without interrupting it.
2. As a User, I want the answer to come from what the Agent already did in this Task, so that I don't have to explain the context again.
3. As a User, I want to reply to a btw answer and keep talking, so that I can dig into a topic like in Claude Code.
4. As a User, I want a new `/btw` to start from the current state of the Session, so that I can ask again once the Agent has moved on.
5. As a User, I want btw questions and answers shown in a distinct colour, like an Internal Note, so that I can tell them from the conversation with the Agent.
6. As a User, I want the question to show it is being answered, so that I know something is happening.
7. As a User, I want a failed btw to explain why in the same style, so that I can ask again.
8. As a User, I want `/btw` to work while the Session is idle, so that I can ask about finished work.
9. As a User, I want a clear error when the Session has not started, is closed, or another btw is working, so that I understand why nothing happened.
10. As a User, I want the Agent never to see btw Comments, so that side questions don't derail its work.
11. As a User, I want `/clear` to start the Agent's conversation over, so that a derailed or bloated context is reset.
12. As a User, I want `/clear` to wait for the Agent's Turn to finish, so that no work is lost.
13. As a User, I want the Task's Comments to remain after `/clear`, with a line showing where the chat cleared, so that the team keeps its record.
14. As a User, I want the new conversation to begin from the Task and the Comments after the line, so that the Agent doesn't re-read what I just cleared.
15. As a User, I want to see "Clear pending" while a Clear waits, so that I know it will happen.
16. As a User, I want old btw threads to stop accepting replies after a Clear, with a message telling me to start a new one, so that I never continue a conversation the Agent no longer has.
17. As a User of the Flutter app, I want the same commands, styles and Reply action, so that mobile matches the web.
18. As an operator, I want a btw never to break "one Job at a time per Worker Container", so that Worktrees stay safe.
19. As a User in a Wiki Chat, I want `/btw` and `/clear` to work as in a Task, so that Chats behave the same.

## Implementation Decisions

- **Shared types**: Comment gains Btw Thread id and role (question, answer, failure) and a clear-marker flag; Session view gains `btwWorking` and `clearPending`; the `POST /tasks/:id/comments` body gains `btwThread`; the runner protocol gains `job.btw`, `job.btw_event`, `job.btw_done` and Job mode `btw`.
- **Interception in the comment endpoint**: a body starting with `/btw ` creates a Btw Comment, a body equal to `/clear` runs the Clear and returns the Chat Cleared line; neither reaches delivery or the native command logic. `clear` leaves the list of native commands delivered as text.
- **Btw Comment**: same Agent-invisibility as an Internal Note (no Delivery, excluded from Task Tools, first Message and Attachment downloads), no files, no Alert, counts in the Comment count.
- **Btw Thread**: stored with Task, Session, the identity it forked from, its own identity (read from the fork's first stream line), state, cost and usage. One `working` thread per Session, enforced in the transaction that posts the Comment.
- **Running path**: Session `running` and Job `running` with a connected Runner and no cancel: send `job.btw`; the Runner forks next to `claude`.
- **Queued path**: otherwise add a `btw` Queue Entry at the front (one per Task, separate from the `messages`/`start` entry). It is ready under the normal Worktree rule and dispatches a Btw Job, which does not set the Session `running`.
- **Fork command**: as described in the spec; the exact CLI flags that disable every tool and MCP server are to be verified against 2.1.310 first, including that `--fork-session` and `--resume <fork id>` behave as tested (about 4 seconds, main transcript untouched). 5-minute timeout.
- **Stream handling**: fork lines are stored as Session Events tagged with the thread, projected only into the answer Comment, and never into Turns, Items, Delivery or notifications.
- **Clear**: stored `clearPending` on the Session; effective when no Job (other than a Btw Job) is active, in one transaction (rotate identity, started false, reset read point, Session `pending`, Queue Entry becomes `start`, post the line). While pending, the backend ends the Job after the next `result`, and Comments posted meanwhile queue instead of being written to stdin. The first Message of a new Session only includes Comments after the latest Chat Cleared line.
- **Dispatcher**: Queue Entry kinds gain `btw`; readiness and Worktree rule apply; Job kind gains `btw`.
- **Frontend and Flutter**: composer System hints for `/btw` and `/clear`, Btw Comment style, Reply action and chip, Chat Cleared divider, "Clear pending" chip, 409 toasts, offline: no queueing for these commands.
- **Docs**: the user manual (`docs/manual`) is updated with the `write-docs` skill after implementation.

## Testing Decisions

- **Seam 1, backend public API (HTTP + WebSocket)** against real Postgres with the fake runner and fake `WorkerRuntime`: Btw on running and idle Sessions, thread replies, every `409`, invisibility to the Agent (no Delivery, Task Tools, first Message), Clear immediate and pending, queued Comments after Clear, first Message after Clear, Btw not touching Turns or notifications, recovery with a pending Clear. The fake runner replays recorded fork fixtures (a successful fork, a failing one, a timeout).
- **Seam 2, Runner as a black box**: the Go binary against the fake backend WebSocket and a fake `claude` that records its arguments: fork flags (every tool off, no MCP, fork versus resume), lines forwarded as `job.btw_event` with seq/ack, `job.btw_done` on exit, a Btw Job that skips the Setup Script, cancel killing the fork.
- **Event projection** gets a table-driven case proving fork lines produce no Turn or Agent Item.
- **Frontend Playwright** small case: `/btw` then reply, `/clear` divider. Flutter widget tests for the same rendering.
- Prior art: the existing Notify agent, native command and Delete Chat tests, and the fake runner fixtures.

## Acceptance Criteria

- [x] `/btw q` on a running Session returns a Btw Comment and, within seconds, an answer Comment, while the Turn's Job, Queue and Session state are unchanged.
- [x] `/btw q` on an idle Session runs as a Btw Job and leaves the Session idle.
- [x] A reply continues the thread; a new `/btw` starts a fresh fork.
- [x] `409` for pending, closed, no Agent, a concurrent btw, and a reply after a Clear; `400` for `/btw` with no question or with files.
- [x] Btw Comments never reach the Agent, appear in no Task Tools answer and no first Message.
- [x] Fork output creates no Turn, Agent Item, Delivery change or Alert.
- [x] `/clear` is effective at once on an idle Session and waits for the Job end on a running one, with "Clear pending" visible.
- [x] After a Clear the Session is `pending`, has a new Claude identity, keeps Worktree and Branch, old Comments remain, and the Chat Cleared line is posted.
- [x] The next Comment starts a new conversation whose first Message includes only Comments after the line.
- [x] Web and Flutter show Btw Comments, Reply, the Clear divider and the hints.
- [x] Specs and glossary match the final behaviour; tests pass (`pnpm typecheck`, `pnpm test`, Go runner tests).

## Out of Scope

- Streaming the fork's answer live (the answer is posted when the fork finishes).
- Attachments in a Btw.
- Notifications or Alerts for Btw answers.
- Sending `/btw` or `/clear` offline from the native app.
- A different model for Btw, or Btw Thread settings.

## Further Notes

- Decisions made by the writer, not discussed: the 5-minute fork timeout, no Alert for btw answers, no files in a Btw, `/clear` refused on `paused` Sessions, and the violet accent colour.
- Test result that motivates the design: `/btw` through stdin ends as `unavailable_headless`; `--resume <id> --fork-session` in the same cwd answered in about 4 s, left the main transcript with 0 occurrences of the question, and saw all finished steps of a running Turn but not the in-flight tool call.
