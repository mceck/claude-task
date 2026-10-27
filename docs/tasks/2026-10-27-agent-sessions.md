---
status: done
---

# Agent Sessions: Assignment, Queue, Jobs, Timeline and Task Tools

## Specs

- [Agent Sessions](../specs/agent-sessions.md)

## Problem Statement

We want Claude Code Agents to work on Tasks from our board as if they were teammates. Today that means opening a terminal per Task, babysitting sessions, copy-pasting feedback between the board and the terminal, and losing a session whenever a terminal closes.

When I assign a Task to an Agent and write to it, it should start working in an environment that can build and test our code. It should talk to us through the Task's Comments: everything it says and does shows up on the Task, and anything we write on the Task reaches it, even while it is in the middle of working. The conversation for a Task has to be one continuous Claude Code session that survives as long as the Task is open: through review, follow-up feedback, container restarts and reassignments. When an Agent is busy with another Task, our feedback must wait its turn without getting lost, and we need to see what is waiting and why.

## Solution

Assigning an Agent to a Task opens a Session for that (Task, Agent) pair in `pending`; nothing runs until the first User Comment. That Comment queues the Session's start in the Agent's Queue, which the backend owns. The backend dispatches one Job at a time per Agent to its Runner, which runs `claude -p` with stream-json input and output in the Task's Worktree, with `--session-id` the first time and `--resume` afterwards.

Comments for the Task the Agent is running are written to the `claude` process's stdin mid-turn; Comments for any other Task wait in the Queue and are delivered together when the Agent is free. Each Comment shows whether it was queued, delivered or not delivered. The Agent's stdout stream is stored raw and projected onto the Timeline: its text as Agent Comments streaming live, its thinking and tool calls collapsed, a summary at the end of each Turn, and errors as System Comments. The Agent reads and updates its own Task through Task Tools served by the backend over MCP. A Stop button interrupts a Turn, Retry restarts a failed setup, and Notify agent sends the Agent the changes Users made to the Task since it last read it. Moving the Task to a `closed`-category Status ends the Session; reopening it resumes the same conversation. Container restarts resume the interrupted Turn automatically.

## User Stories

### Assignment and Sessions

1. As a Member, I want to assign a Task to an Agent (at most one Agent per Task), so that it is the one working on it once I write to it.
2. As a Member, I want the Agent to start on the first Comment I send after assigning it, whatever the Task's Status, so that I can prepare the Task before the Agent reads it.
3. As a Member, I want assignment alone to start nothing, so that assigning by mistake or in advance costs nothing.
4. As a Member, I want the assignment recorded as a Revision on the Task, so that I can see who assigned which Agent and when.
5. As a Member, I want to see the Session state (`queued #N`, `running`, `waiting for messages`, `paused`, `closed`, `waiting for retry`) on the Task and on its card, so that I know what the Agent is doing.
6. As a Member, I want the Agent to receive the Task's title, description, Status, priority, tags and all existing non-internal Comments when its Session starts, so that it has full context.
7. As a Member, I want the Agent's first Message to name the Task Branch, so that it knows where to work.
8. As a Member, I want to reassign a Task to a different Agent, so that a better-suited Agent picks it up with a fresh Session that receives the Task, the full non-internal history (including the previous Agent's messages) and the existing branch.
9. As a Member, I want the new Agent told that another Agent worked on the Task before it, so that it reads the earlier conversation with that in mind.
10. As a Member, I want to unassign the Agent, so that it stops (interrupted if running) and its Session pauses.
11. As a Member, I want reassigning a Task to an Agent that previously worked on it to resume that same Session, with everything said meanwhile, so that its memory isn't lost.
12. As a Member, I want moving the Task to a `closed`-category Status to end the Session, cancel a running Job, discard undelivered Messages and remove the Worktree, so that closed Tasks hold no resources.
13. As a Member, I want switching a whole Status to the `closed` Category to close the Sessions of its Tasks too, so that the rule holds however a Task becomes closed.
14. As a Member, I want reopening a closed Task to resume the same Session on the next Comment, with the Worktree recreated from the Task Branch, so that follow-up work continues in context.
15. As a Member, I want any other Status change to leave the Agent alone, so that moving cards around never starts or stops work.
16. As a Member, I want deleting a Task that an Agent is working on to be refused until the Job ends, so that no `claude` process keeps running with the Task's secrets.

### Conversation

17. As a Member, I want my Comment to reach the Agent immediately, even mid-work, when it is working on this Task, so that I can steer it in real time.
18. As a Member, I want my Comment to be queued when the Agent is busy with another Task, and delivered as soon as the Agent is free, so that nothing is lost.
19. As a Member, I want several Comments queued for the same Task delivered together as one Message, with author and time for each, so that the Agent gets the whole picture in one Turn.
20. As a Member, I want each Comment to show its Delivery (`queued`, `delivered`, `not delivered` with a reason), so that I know whether the Agent saw it.
21. As a Member, I want Internal Notes kept from the Agent, so that humans can talk privately on the Task.
22. As a Member, I want image attachments delivered to the Agent as images and other files placed in its Worktree with their path mentioned, so that I can share screenshots and logs.
23. As a Member, I want a Message with many images to stay deliverable, with the extra images saved as files, so that a large upload never blocks the Agent.
24. As a Member, I want files embedded in the Task description to be available in the Agent's Worktree, so that the Agent can open what the description links to.
25. As a Member, I want editing a queued Comment to change what the Agent receives, and deleting the only queued Comment to cancel the pending work, so that I can take back a message before it is read.
26. As a Member, I want to see the Agent's text appear live as Agent Comments, so that it feels like a chat.
27. As a Member, I want the Agent's thinking shown collapsed above its reply, so that I can inspect its reasoning when it is available.
28. As a Member, I want the Agent's tool calls grouped as a compact Activity between its messages (e.g. "Edited `src/auth.ts`", "Ran `npm test`, exit 1"), collapsed by default and expandable to inputs and outputs, so that the conversation stays readable and the details stay available.
29. As a Member, I want subagent tool calls nested under the call that started them, so that parallel work is understandable.
30. As a Member, I want each Turn to end with a summary (duration, tool calls, cost, outcome), so that I can judge effort and spend.
31. As a Member, I want rate limits, authentication and billing failures, crashes and setup failures shown as clearly visible System Comments naming the cause (and the Credential when relevant), so that I know when the Agent is stuck and why.
32. As a Member, I want a transient "retrying" status while the Claude API is being retried, so that I can tell a slow Turn from a stuck one.
33. As a Member, I want a Stop button that interrupts the Agent's current Turn without ending the Session, so that I can halt a wrong direction and redirect it with a Comment.
34. As a Member, I want a banner when Users edited the Task after the Agent last read it, with a one-click Notify agent that sends it a diff of the changes, so that it picks up updates without me retyping them.
35. As a Member, I want to run native Claude Code commands such as `/compact` or a Skill from a Comment, in order with my other Comments, so that I can manage the conversation without a terminal.
36. As a Member, I want commands that would break the managed conversation (such as `/clear` or `/model`) treated as ordinary text, so that the Session and the Agent's configuration stay intact.

### Agent tools

37. As an Agent, I want a tool to read my Task (fields, Statuses with Categories, tags, Comments), so that I can refresh my context.
38. As an Agent, I want to page through older Comments, so that long conversations stay readable within my context.
39. As an Agent, I want a tool to update my Task's title, description, priority and tags, so that I can keep it accurate (e.g. tick checklist items).
40. As an Agent, I want a tool to move my Task to any Status outside the `closed` Category, so that I can signal progress (e.g. Ready for Review).
41. As an Agent, I want read-only tools to list and read other Tasks of the same Project, so that I can understand related work.
42. As an Agent, I want a tool to create a new unassigned Task in my Project, so that I can report out-of-scope issues I discover.
43. As an Agent, I want tool errors to explain what went wrong and list valid values, so that I can correct my call.
44. As a Member, I want every change an Agent makes through tools to appear on the Timeline attributed to that Agent, so that Agent actions are auditable.
45. As an Admin, I want Task Tools to stop working the moment a human closes the Task or unassigns the Agent, so that a stopping Agent can't keep changing the board.

### Queue and observability

46. As a Member, I want to see an Agent's Queue (Tasks waiting, kind, pending Message counts), so that I understand delays.
47. As a Member, I want to reorder an Agent's Queue by dragging and to remove entries, so that I can prioritise urgent feedback.
48. As a Member, I want a removed entry's Comments marked not delivered, so that it is clear the Agent won't see them.
49. As a Member, I want to see the Agent's current Job and recent Jobs with links to their Tasks, so that I know what it has been doing.
50. As a Member, I want Job details with the setup output and stderr, so that I can diagnose a failed run.
51. As a Member, I want per-Turn, per-Task and per-Agent usage (tokens, estimated cost) and the latest rate-limit status of each Agent's Credential, so that I understand consumption.
52. As a Member, I want a failed setup to wait for my Retry instead of looping, while the rest of the Agent's Queue goes on, so that one broken Task doesn't block or burn the Agent.

### Reliability

53. As a Member, I want a crashed or restarted Agent Container to resume the interrupted Turn automatically, with a System Comment saying so, so that work isn't silently lost.
54. As a Member, I want a Runner that reconnects after a network blip to carry on with its Job without duplicated output, so that the Timeline stays correct.
55. As a Member, I want a Runner gone for more than 5 minutes to have its Job recovered, so that a dead container doesn't leave the Agent stuck.
56. As an Operator, I want the `claude` version pinned centrally, so that the stream format the Timeline depends on only changes on purpose.
57. As a Member, I want a missing conversation transcript (for example after the Agent Volume was reset) to start a new conversation with the Task's history, so that the Task keeps working.

## Implementation Decisions

- **Runtime contract.** Each Job runs the real `claude` CLI as `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`, with `--session-id` for a conversation not yet created and `--resume` afterwards, `--model`, `--effort` and `--permission-mode` from the Agent, `--append-system-prompt` with the composed prompt and `--mcp-config` with the Task Tools server (bearer Job token) plus the Agent's catalog MCP servers. No `--bare`, so repository instructions, settings, Skills and `.mcp.json` load. The `claude` version is pinned by `CLAUDE_CODE_VERSION` (default 2.1.310).
- **Backend-owned scheduling.** Sessions, Queue Entries, Jobs, Turns, raw Session Events, Agent Items and Comment Deliveries live in Postgres. The Runner dials out over an authenticated WebSocket and holds no scheduling state. Credentials and Project environment travel in each Job's start message.
- **Schema.** Session (unique per Task and Agent; state `pending`, `idle`, `running`, `paused`, `closed`; Worktree path; started flag; last-read Task version; last dispatch time; Worktree removal pending; optional Claude session identity). Queue Entry (unique per Agent and Task; kind `start`, `messages`, `resume_interrupted`; fractional position; held flag). Job (state `dispatched`, `running`, `finishing`, `finished`, `failed`, `interrupted`; hashed Job token; last processed sequence number; projection state; setup output and stderr tails; failure stage; cancel-requested and discard-output flags). Turn, Session Event (primary key Job and sequence number), Agent Item (`thinking`, `activity`, `turn_summary`, `notice`), rate-limit observation. Comments gain Delivery state and reason, delivering Job, Queue Entry, and change-notice fields; the Task gains its current Session.
- **Lifecycle module.** Assignment, unassignment, reassignment, closing and reopening run inside the transaction that changes the Task (or the Status Category), under a fixed lock order (Project, Task, Agents by id, Session, Job, Queue Entries). It also decides each Comment's Delivery: inject when the Session's Job is `running`, the Runner is connected, no entry is waiting for the Task and the Comment is not a native command; queue otherwise; `not delivered` with "no agent assigned" or "task closed".
- **Queue module.** One entry per Task per Agent; merging keeps the position and the strongest kind (`start` over `resume_interrupted` over `messages`); recovery entries go to the front; manual moves use fractional keys and respace the Queue when keys collide; removing an entry marks its queued Comments `not delivered` with the reason; an entry left empty by a deleted Comment is dropped, except `resume_interrupted`.
- **Dispatcher.** Per Agent, serialized in-process and re-run when triggered during a run; triggered on enqueue, Job end (after container reconcile), Runner hello, container running, Extensions synchronized and a 30-second tick. It requires an enabled Agent with synchronized Extensions, a connected Runner, a running container with the current spec and no active Job, then takes the first non-held entry with a skip-locked row lock. It checks the Task Branch on the provider (holding the entry on failure), builds the Message, creates the Job with a fresh token, marks Comments delivered and sets the Session `running`.
- **Messages.** Opening Message for a Session not yet created: Task snapshot, branch, previous-Agent line and the whole non-internal User and Agent conversation. Existing Session: merged Comments, each with a bracketed author and ISO time header; resume and reassignment notices when there is nothing else. Images up to 5 MB inline, within 20 images and 16 MB per Message, newest first; other files fetched by the Runner into `.claude-task/attachments/` in the Worktree. Native commands run as standalone Jobs; a first command is the last block after the Task context.
- **End of Turn.** On the Runner's result notice the Job moves to `finishing` and the Runner is told to close stdin; later Comments queue. Exit finishes the Job and the Session goes back to `idle` (or `pending` if the conversation was never created).
- **Mid-turn delivery and interrupt.** Verified against the pinned CLI: stdin messages during a Turn are consumed at the next model call within the same Turn; interrupt uses the stream-json control request, which keeps the process alive; closing stdin drains queued input one Turn per message, so the backend merges pending Comments itself.
- **Failure handling.** Worktree, setup or spawn failures fail the Job, post a System Comment with the setup output tail and requeue the Comments at the front, held, until Retry or a new Comment. Unexpected exits post a System Comment with the stderr tail. stderr "No conversation found" resets the started flag; "Session ID … is already in use" on a first Job marks it started and holds the requeued work.
- **Recovery.** Runner hello keeps its reported Job (acknowledging the last processed sequence number), cancels Jobs already settled, and recovers every other active Job: `interrupted`, pending tool calls settled, a `resume_interrupted` entry at the front with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` when a Turn was cut off, or the Comments requeued when nothing ran. Runners away more than 5 minutes are recovered by the tick; Runners silent for a 30-second ping round are dropped. Runner messages are processed exactly once, in order, per Job sequence number.
- **Projection.** A pure function from the stored projection state and one raw event to new state, Timeline mutations and live broadcasts, with deterministic item ids. Partial deltas broadcast only. Text becomes Agent Comments, thinking with text becomes Thinking items, tool calls become Activity entries with per-tool summaries and 20 KB display caps, subagent tool calls nest under their parent, `result` becomes a Turn Summary and a Turn record with per-Turn cost (difference of the cumulative CLI cost), and system events become retry status, compaction notices, command output, credential and API error System Comments. Aborted Turns (Stop) are expected ends.
- **Task Tools.** A stateless Streamable HTTP MCP server at the backend's MCP path, authenticated by the Job token, which is valid while the Job is active, not cancel-requested and its Session `running`. Tools: `get_task`, `list_tasks`, `update_task`, `set_status` (refuses `closed`), `create_task` (first `open` Status, unassigned, created by the Agent), and `open_pull_request` from the git integration. Mutations reuse the Task operations and record Revisions by the Agent.
- **Notify agent.** Unseen Changes are User Revisions of title, description, priority or tags after the Session's last-read version, shown for `idle` and `running` Sessions. Notify agent posts a System Comment carrying a field-by-field change list (unified diff for the description) and delivers it like a Comment; delivery raises the last-read version. Reading the own Task with `get_task` also raises it.
- **System prompt.** Platform section (identity, Worktree, how comments and mid-turn messages work, attachments, Task Tools, git rules when the Project has a Repository), then Project Agent Instructions, then the Agent's prompt. It holds no Task content, so it is identical for every Job of a Session.
- **API.** Task Session read, Stop, Retry and Notify endpoints on the Task; Queue list, move and remove, Jobs list, Job detail and usage endpoints on the Agent. Live events on the Task topic (Session changes, Comments, Agent Items, live deltas and retry status, setup output), the Agent topics (Queue changes, Job updates, Agent state) and the Board topic (card Session indicator).

## Testing Decisions

- **Seam 1, backend public API (primary).** The backend runs in-process against real Postgres with a fake `AgentRuntime` and a fake `GitProvider`. A fake Runner authenticates with the Agent's runner token over the real WebSocket, receives Job start, input, interrupt, end, cancel, Worktree removal and acknowledgements, and plays stream-json events built with a stream helper or taken from recorded fixtures, with controllable timing, resends and disconnects. The Session suite covers the trigger, one Job at a time, dispatch waiting for the Runner and for an enabled Agent, the Job's configuration and environment, Timeline output and live events, exactly-once processing of resent messages, credential and API errors, rate-limit observations, inject versus queue versus merge, Internal Notes, end of Turn with late Comments at the back, unassignment, Stop, Retry after setup failure, silent session creation, crashes, closing and reopening, Status Category changes, reassignment both ways, container restart recovery, Runner reconnect, Task deletion while working, Queue reorder and removal, deleted queued Comments, Notify agent and attachment isolation and budgets.
- **Native commands** have their own suite at the same seam: command discovery from the stream, ordering with later Comments, verbatim delivery, single rendering of local output, and a first command after the Task context.
- **Task Tools** are tested with the real MCP SDK client over Streamable HTTP against the running backend, using the Job token from a fake Runner's Job start: listing tools, reading and paging, Unseen Changes cleared by reading, Project scoping, updates as Revisions, closed-Status refusal, Task creation, and token rejection for unknown, finished, closed and unassigned cases.
- **Projection unit tests** are table-driven over the pure function: deltas, retries, per-Turn cost, new Comment per Turn, determinism, JSON round-trip of state, settling at Job end, input caps, unknown lines, and the recorded streams of the CLI spike (spend limit, Stop, redacted thinking, mid-turn message, stdin-close draining).
- **Wiki Reset Chat** at the backend seam covers rotating the Claude session identity, retaining the checkout, resetting earlier Agents and cancelling while offline.
- **Seam 2, Runner as a black box.** The Go Runner binary runs against a fake backend WebSocket, a fake `claude` executable and local bare git repositories: argument composition for new and resumed Sessions, mid-turn input, interrupt keeping the process, cancel escalation, resend after disconnect, one Job at a time, Setup Script and attachments. Details in the Runner spec.
- **Frontend** Playwright tests run against the real backend with the fake runtime and Runner: streaming a Turn, expanding thinking and Activity, Delivery badges, Stop and Notify agent, card state and Queue reordering by a Member, setup failure and Retry, and live Session state against late HTTP snapshots.
- **Seam 3, opt-in end-to-end smoke** with real Docker, the real Base Image and real `claude`.

## Acceptance Criteria

- [x] The spike against the real CLI is recorded in the Decisions of [Agent sessions](../specs/agent-sessions.md) and confirms mid-turn injection, the interrupt mechanism, stdin-close semantics, session id and resume, thinking presence, partial messages, interrupted-turn resume and MCP over HTTP.
- [x] Assigning a Task starts nothing; the first User Comment on it, with an idle Agent, dispatches a Job carrying the Session id, Worktree path, model, effort, permission mode, system prompt, MCP configuration, Credential environment and Project environment.
- [x] Assignment works in any Status and is recorded as a Revision; a Task has at most one Agent.
- [x] An Agent never runs two Jobs at once, and dispatch waits for a connected Runner and an enabled Agent while keeping the Queue.
- [x] The Agent's text appears live as Agent Comments, tool calls in Activity items, and each Turn ends with a Turn Summary and a recorded Turn with usage.
- [x] A Comment posted while the Agent works on that Task is written to the running Job and marked delivered.
- [x] Comments on another Task of a busy Agent are queued and later delivered together in one Message with authors and times.
- [x] Internal Notes are never delivered.
- [x] A Comment arriving after a Turn's result is queued at the back.
- [x] Stop interrupts the Turn and the next Comment resumes the same Session; Stop answers 409 when nothing runs.
- [x] A failed setup posts its error and output, holds the work, and runs again only on Retry or a new Comment.
- [x] A crashed process leaves a System Comment, interrupted tool calls and an idle Session.
- [x] Moving a Task to a `closed` Status cancels its Job, marks undelivered Comments not delivered, closes the Session and removes the Worktree; reopening and commenting resumes the same Session in the same Worktree path.
- [x] Unassigning interrupts and pauses; reassigning another Agent starts a fresh Session with the history; reassigning back resumes the paused Session with what was said meanwhile.
- [x] Killing the Runner's process mid-Turn leads, on the next hello, to a `resume_interrupted` Job at the front of the Queue and a System Comment.
- [x] A Runner reconnecting with its Job resumes from the last acknowledged message without duplicated output.
- [x] Task Tools work only for the Job's own Task (read-only listing and reading within the Project), refuse `closed` Statuses, record mutations as Revisions by the Agent, and reject tokens of finished, closed or unassigned Jobs.
- [x] After a User edits the Task, the Unseen Changes banner appears; Notify agent delivers a diff and the banner clears; the Agent's own edits and Status changes don't count.
- [x] Members can reorder and remove Queue Entries; removed Comments become not delivered; `start` entries stay.
- [x] Credential and API failures from the stream appear as System Comments naming the Credential.
- [x] Projection tests pass over the recorded streams of the CLI spike.
- [ ] Recorded fixtures exist for nested subagent activity and context compaction.
- [ ] The end-to-end smoke passes with real Docker and real `claude`: assign and get a reply that moves the Task to review, a mid-run Comment taken into account in the same Turn, Stop, and a container kill followed by resume.

## Out of Scope

- Running Agents on several hosts or Kubernetes.
- Parallel Jobs within one Agent; throughput comes from more Agents.
- Interactive permission approval from the UI; the permission mode is fixed per Agent.
- Platform-configured hooks and guardrails; Base Branch protection belongs to the Git Proxy's Push Policy.
- Agents assigning Tasks to Agents or closing Tasks.
- Status-driven behaviour beyond the `closed` Category (auto-start on a Status, auto-close on merge).
- A live terminal into the Agent Container.
- Precise billing reconciliation; costs are the CLI's estimates.
- A tool to re-project stored raw events; they are kept so one can be added.
- Agent configuration, Credentials, images and containers, Runner internals and git integration, which have their own specs.

## Further Notes

- Builds on the core board (Tasks, Statuses, Comments, Revisions) and uses the git integration for Task Branches, the Git Proxy and `open_pull_request`.
- Recordings of the CLI spike against Claude Code 2.1.310 are the projection fixtures; the first attempt was refused by the organization's spend limit and is kept as a fixture too.
- A Bash `sleep N` as the first command is blocked by the CLI, so tests and prompts avoid relying on it.
- Thinking blocks arrive redacted (empty text) for current models with default settings, so Thinking items appear only when a model returns thinking text.
