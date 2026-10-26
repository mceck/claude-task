---
status: in-progress
---

# Spec 02 — Agents & Runtime: containers, runner, queue, sessions, agent timeline

Implementation: backend, runner and frontend are implemented. See
[running and verification](../agents-runtime.md). Real conversation acceptance and
ADR 0005 remain pending: the 2026-10-25 retry with Claude Code 2.1.310 was refused by
the organization's monthly spend limit. The production Docker/runner smoke check
(through agent `idle`, without a model request) passed.

## ADRs

- [ADR 0001](../adr/0001-headless-claude-cli-stream-json.md) — Run agents as headless `claude -p` with stream-json I/O
- [ADR 0002](../adr/0002-one-container-per-agent-one-job-at-a-time.md) — One long-lived container per agent, one job at a time
- [ADR 0003](../adr/0003-backend-owned-queue-outbound-runner.md) — Backend owns the queue; the runner connects outbound and holds no state
- [ADR 0004](../adr/0004-agent-output-from-stream-not-hooks.md) — Agent output comes from the stream-json stdout, not from Claude Code hooks
- [ADR 0005](../adr/0005-mid-turn-message-injection.md) — Deliver comments to a running job by writing to stdin mid-turn (proposed, pending spike)

Depends on: [Spec 01 — Core Board](01-core-board.md). Uses the Git operations defined in [Spec 03 — Git Integration](03-git-integration.md).

## Problem Statement

We want Claude Code agents to work on tasks from our board as if they were teammates. When I assign a task to an agent and send my first comment, it should start working right away in an environment that can build and test our code. It should talk to us through the task's comments: everything it says and does shows up on the task, and anything we write on the task reaches it, **even while it's in the middle of working**. The conversation for a task has to be one continuous Claude Code session that survives for as long as the task is open: through review, follow-up feedback, container restarts, and reassignments.

Today this means opening a terminal per task, babysitting sessions, copy-pasting feedback, and losing sessions when terminals close.

## Solution

Admins define **Agents**: global, reusable workers, each with its own Dockerfile (toolchains), its own Claude credential, model, permission mode, and personality prompt. Any task in any project can be assigned to an agent.

Each agent runs as **one long-lived Docker container** on the host, managed by the backend through the host's Docker socket. Inside it, a small **Runner** (Go) connects out to the backend over WebSocket and runs `claude` in headless streaming mode (`-p --input-format stream-json --output-format stream-json`) on behalf of the backend.

Every task assigned to an agent gets its own **Session**: a Claude Code session id plus a git **Worktree** on the task's branch, inside the agent's container volume. An agent executes **one job at a time**. Work for an agent goes through a **Queue** owned by the backend. Assigning a task creates a `pending` session; the first user comment enqueues the session start. Comments on a task whose job is running are injected into the running `claude` process immediately. Comments on any other task of that agent are queued and delivered (merged) when the agent is free.

The agent's output is read from the `claude` stream and shown on the task's timeline: its text as agent comments, its thinking collapsed, and its tool calls as a compact, expandable activity log. The agent moves and edits its own task through **task tools** exposed by the backend as an MCP server. Task status never drives the agent automatically, with one exception: moving the task to a `closed` status ends the session.

## User Stories

### Credentials

1. As an admin, I want to store Claude credentials (a long-lived OAuth token from `claude setup-token`, or an Anthropic API key) with a name, so that agents can authenticate.
2. As an admin, I want credential secrets to be write-only in the UI and API (only the last 4 characters are shown after saving), so that they can't be exfiltrated through the app.
3. As an admin, I want to rotate a credential's secret in place, so that every agent using it picks up the new value on its next job without reconfiguration.
4. As an admin, I want to see which agents use a credential, so that I understand the impact of rotating or deleting it.
5. As an admin, I want deleting a credential that is in use to be blocked, so that no agent is left unable to run.

### Agents

6. As an admin, I want to create an agent with a name, avatar (emoji + color), and description, so that people can recognize it on the board.
7. As an admin, I want to write the agent's Dockerfile in the app (starting `FROM claude-task/agent-base`), so that the agent has the toolchains our projects need.
8. As an admin, I want to pick the agent's Claude credential (required), so that I control which account and rate limits it consumes.
9. As an admin, I want to set the agent's model and effort level, so that I can trade cost for capability per agent.
10. As an admin, I want to set the agent's permission mode (default `bypassPermissions`; also `auto`, `acceptEdits`, `dontAsk`), so that I can decide how much freedom it has inside its container.
11. As an admin, I want to give the agent an extra system prompt (its "personality" and working rules), so that it behaves consistently, e.g. "always write tests".
12. As an admin, I want to set CPU and memory limits for the agent's container, so that one agent can't starve the host.
13. As an admin, I want to disable an agent, so that it stops taking work without being deleted.
14. As an admin, I want to duplicate an agent, so that I can add throughput with the same environment.
15. As an admin, I want to delete an agent that has no open sessions, so that I can clean up, along with its container, image, and volume.
16. As a member, I want to see all agents and their current state (building, idle, working on `KEY-n`, queue length, offline, disabled) in one view, so that I know who's free and who's stuck.

### Images & containers

17. As an admin, I want the agent image to build automatically when I create the agent or change its Dockerfile, so that the environment always matches the configuration.
18. As an admin, I want to watch the image build output live and see the last build log, so that I can fix a broken Dockerfile.
19. As an admin, I want a failed build to leave the previous container running (if any) and mark the agent as `build_failed`, so that a typo doesn't take a working agent offline.
20. As an admin, I want to manually rebuild and restart an agent's container, so that I can recover from odd states.
21. As an admin, I want a container recreation (after a rebuild) to wait until the agent's current job finishes, with an option to force it, so that I don't kill work in progress by accident.
22. As an admin, I want the agent's repositories, worktrees, and Claude sessions to survive container recreation, so that rebuilding an image never loses sessions.
23. As an admin, I want to view the agent container's logs live, so that I can debug the runner.
24. As the operator, I want the Claude Code version used by all agents to be pinned centrally, so that every agent runs a tested version and upgrades are deliberate.

### Projects (agent-related settings)

25. As a member, I want to write a project's **worktree setup script** (e.g. `npm ci`), so that every new task worktree is ready to build and test.
26. As an admin, I want to define a project's environment variables and secrets, so that agents working on that project's tasks (and only those) get them. Besides one at a time, I can import a `.env` file: its variables are merged into the existing ones (same names overwritten, others kept, an existing secret stays secret), optionally all as secrets.
27. As a member, I want to write project-level agent instructions, so that every agent working on this project follows its conventions on top of the repo's CLAUDE.md.

### Assignment & sessions

28. As a member, I want to assign a task to an agent (at most one agent per task), so that it's the one working on it once I write to it.
29. As a member, I want the agent to start working on the first comment I send after assigning it, whatever the task's status, so that I can prepare the task before the agent reads it.
30. As a member, I want to see the task's session state (`queued #N`, `running`, `waiting for messages`, `paused`, `closed`) on the task and on its card, so that I know what the agent is doing.
31. As a member, I want the agent to receive the task's title, description, priority, tags, and all existing non-internal comments when its session starts, so that it has full context.
32. As a member, I want to reassign a task to a different agent, so that a better-suited agent picks it up, starting a fresh session that receives the task, the full non-internal comment history (including the previous agent's messages), and the existing branch.
33. As a member, I want to unassign the agent, so that the agent stops (it's interrupted if running) and the session pauses.
34. As a member, I want reassigning a task to an agent that previously had a session on it to resume that same session, so that its memory isn't lost.
35. As a member, I want moving the task to a `closed` status to end the session (interrupting a running job), discard undelivered messages, and remove the worktree, so that closed tasks don't hold resources.
36. As a member, I want reopening a closed task to resume the same session on the next comment, with the worktree recreated from the task branch, so that follow-up work continues in context.

### Conversation (comments in, timeline out)

37. As a member, I want my comment to reach the agent **immediately**, even mid-work, when the agent is currently working on this task, so that I can steer it in real time.
38. As a member, I want my comment to be queued when the agent is busy with another task, and delivered as soon as the agent is free, so that nothing is lost.
39. As a member, I want several comments queued for the same task to be delivered together as one message, with author and time for each, so that the agent gets the whole picture in one turn.
40. As a member, I want each comment to show its delivery state (`queued`, `delivered`, `not delivered` with reason), so that I know whether the agent saw it.
41. As a member, I want internal notes never to be delivered to the agent, so that humans can talk privately on the task.
42. As a member, I want image attachments in my comments delivered to the agent as images, and other files placed in its worktree with their path mentioned, so that I can share screenshots and logs with it.
43. As a member, I want to see the agent's text as agent comments appearing live (streaming), so that it feels like a chat.
44. As a member, I want the agent's thinking shown above its reply, collapsed by default, so that I can inspect its reasoning when needed.
45. As a member, I want the agent's tool calls grouped as a compact activity log between its messages (e.g. "Edited `src/auth.ts`", "Ran `npm test` — exit 1"), collapsed by default and expandable to inputs and outputs, so that the conversation stays readable and the details stay available.
46. As a member, I want subagent activity nested under the tool call that started it, so that parallel work is understandable.
47. As a member, I want each turn to end with a compact summary (duration, number of tool calls, estimated cost, outcome), so that I can judge effort and spend.
48. As a member, I want errors (rate limits, authentication failures, crashes, setup script failures) to appear as clearly visible system comments, so that I know when the agent is stuck and why.
49. As a member, I want a **Stop** button that interrupts the agent's current turn without ending the session, so that I can halt a wrong direction and then redirect it with a comment.
50. As a member, I want a non-intrusive banner when the task was edited by a human after the agent last read it, with a one-click **Notify agent** action that sends the agent a diff of the changes, so that the agent can pick up updates without me retyping them.

### Agent tools

51. As an agent, I want a tool to read my task (fields, available statuses with categories, comments), so that I can refresh my context.
52. As an agent, I want a tool to update my task's title, description, priority, and tags, so that I can keep the task accurate (e.g. tick checklist items).
53. As an agent, I want a tool to move my task to any status except `closed`-category ones, so that I can signal progress (e.g. Ready for Review).
54. As an agent, I want read-only tools to list and read other tasks of the same project, so that I can understand related work.
55. As an agent, I want a tool to create a new unassigned task in my project, so that I can report out-of-scope issues I discover.
56. As a member, I want every change an agent makes through tools to appear in the task timeline attributed to that agent, so that agent actions are auditable.

### Queue & observability

57. As a member, I want to see an agent's queue (tasks waiting, with pending message counts), so that I understand delays.
58. As a member, I want to reorder an agent's queue manually and remove entries, so that I can prioritize urgent feedback.
59. As a member, I want to see the agent's current job and recent jobs with links to the tasks, so that I know what it has been doing.
60. As a member, I want per-turn, per-task, and per-agent usage (tokens, estimated cost) and the latest rate-limit status of each agent's credential, so that I understand consumption.
61. As a member, I want a crashed or restarted agent container to resume the interrupted turn automatically, with a system comment saying so, so that work isn't silently lost.

## Implementation Decisions

### Prerequisite spike (blocking)

Before building the runner, run a spike against the real `claude` CLI at the pinned version and record the results as an ADR. Verify:
1. In `-p --input-format stream-json --output-format stream-json --verbose` mode, a user message written to stdin **while a turn is running** gets incorporated before the turn ends (expected: at the next model call after the current tool batch), not only after the `result`.
2. How to interrupt the current turn without killing the process (SIGINT vs the stream-json control-request interrupt), and what the stream emits afterwards.
3. Closing stdin after a `result`: the process processes any already-written queued messages, then exits cleanly.
4. `--session-id <uuid>` for new sessions and `--resume <uuid>` for existing ones work as expected, including with a different working directory than the session's original one (resume must happen in the same worktree path; confirm).
5. Thinking blocks are present in the stream (possibly summarized) for the chosen models.
6. `--include-partial-messages` text deltas are usable for live streaming.
7. `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` resumes a turn interrupted by a process kill.
8. `--mcp-config` with an HTTP server and a bearer header works under `-p`.

If (1) fails, fall back to: comments for the running task are held until the `result`, then written to stdin immediately so they start the next turn in the same process. The rest of this spec is unchanged.

### Domain vocabulary

- **Agent**: a global worker configuration. **Agent Container**: the one container running an agent. **Agent Volume**: the named Docker volume holding the agent's home (repos, worktrees, Claude config dir with session transcripts).
- **Credential**: a named Claude secret (OAuth token or API key).
- **Runner**: the Go process inside the agent container. **Runner Protocol**: the WebSocket protocol between Runner and backend.
- **Session**: the persistent Claude Code conversation for one (task, agent) pair.
- **Job**: one execution of a `claude` process for a session, from spawn to exit. A job contains one or more **Turns** (each ends with a `result` event).
- **Queue Entry**: pending work for a (agent, task) pair.
- **Timeline Item**: what the task timeline displays: user/agent/system comments, thinking, activity groups, turn summaries, revisions.

### Data model additions

- **Credential**: id, name, kind ∈ {claude_oauth_token, anthropic_api_key}, encrypted secret, secret last4, timestamps.
- **Agent**: id, name, avatar emoji, avatar color, avatar image (optional, PNG/JPEG/GIF/WebP up to 2 MB; replaces emoji and color when set), description, dockerfile, credential id (required), model (nullable = CLI default), effort (nullable), permission mode ∈ {bypassPermissions, auto, acceptEdits, dontAsk} default bypassPermissions, system prompt (text), cpu limit, memory limit (MB), enabled, runner token hash, current image tag, image build state ∈ {none, building, built, failed}, container state (last observed), runner connection state, timestamps.
- **AgentBuild**: id, agent id, dockerfile snapshot, base image version, status, log (text, capped), started/finished.
- **Project** additions: setup script (text), agent instructions (text).
- **ProjectEnvVar**: project id, name, value (plain or encrypted), secret flag. Secret values are write-only like credentials.
- **Task** additions: agent id (nullable, at most one), current session id (nullable).
- **Session**: id (UUID, also used as the Claude Code session id), task id, agent id, state ∈ {pending, idle, running, paused, closed}, worktree path, last_seen_task_version, created/closed timestamps. Unique: one non-closed session per task. Sessions are never deleted, only closed.
- **QueueEntry**: id, agent id, task id, session id, kind ∈ {start, messages, resume_interrupted}, position (fractional index), enqueued_at. Unique per (agent, task). Pending messages are the comments linked to the entry.
- **Comment** additions: delivery state ∈ {none (internal/agent/system), queued, delivered, not_delivered}, delivery reason, delivered_in_job id, queue entry id.
- **Job**: id, session id, agent id, state ∈ {dispatched, running, finishing, finished, failed, interrupted}, started/finished, exit code, error.
- **Turn**: id, job id, index, started/finished, result subtype, stop reason, duration, num tool calls, cost estimate, usage (json).
- **SessionEvent**: job id, seq, received_at, raw payload (jsonb). Unique (job id, seq). The raw stream, kept for audit and re-projection.
- **TimelineItem** (projection over session events, stored for fast reads): id, task id, session id, turn id, kind ∈ {agent_message, thinking, activity, turn_summary, system}, payload, created_at. Agent messages are also stored as **Comments** of kind `agent` so they behave like comments everywhere (counts, timeline merge).
- **RateLimitObservation**: credential id, agent id, payload, observed_at (latest per credential is shown).

### Secrets

- Credential secrets and secret env vars are encrypted with AES-256-GCM using a master key from the backend's environment (`SECRETS_MASTER_KEY`). The backend refuses to start without it. Ciphertext carries a key version for future rotation.
- Secrets are decrypted only when building a job payload and are never logged. Job payloads with secrets go only to the runner of the agent the job belongs to.

### Base image

- The backend ships the base image's Dockerfile and builds it locally at startup through the Docker socket whenever `claude-task/agent-base:<platform-version>` is missing. It also tags it `claude-task/agent-base:latest`. No registry.
- Contents: Debian slim, git, ca-certificates, curl, the `claude` CLI at the version pinned in backend config (`CLAUDE_CODE_VERSION`), the runner binary, the git credential helper (Spec 03; since Spec 05 it serves the Job token for the Git Proxy), a non-root user `agent` (uid 1000) with home `/home/agent`, `DISABLE_AUTOUPDATER=1`, entrypoint = runner, user = agent.
- Agent Dockerfiles must have `claude-task/agent-base` (any tag or no tag) as their first `FROM`. The backend validates this on save and always builds against the current platform version by passing it as the resolved base. Agent Dockerfiles may switch to root for installs but must end as `USER agent` (validated by inspecting the built image config; a failure fails the build).
- Upgrading `CLAUDE_CODE_VERSION` or the runner changes the platform version: the base image is rebuilt, then every agent image is rebuilt and recreated following the "wait for idle" rule.

### AgentRuntime (Docker)

- Interface (deep module, the only module that talks to Docker): ensureBaseImage(); buildAgentImage(agent, onLog) → image tag; ensureContainer(agent) (create or recreate with current image, limits, volume, env); start/stop/restart(agent); removeAgent(agent) (container + images + volume); inspect(agent) → state; streamLogs(agent, onLine). The MVP implementation uses dockerode over the mounted socket. Tests use a fake.
- Container: name `claude-task-agent-<agentId>`, restart policy `unless-stopped`, CPU/memory limits from the agent, named volume `claude-task-agent-<agentId>` mounted at `/home/agent`, network: default bridge with outbound internet, and the backend reachable at a configured internal URL (e.g. the backend container on a shared user-defined network).
- Container env holds only what the runner needs to connect: backend WebSocket URL and the agent's runner token (random, stored hashed, regenerated on every container recreation). Claude credentials and project env are **not** container env: they are passed per job (so rotation applies at the next job and project env stays scoped).
- A reconciler loop in the backend (every 30 s and on relevant changes) compares desired state (enabled agents with built images) with actual container state and fixes drift. Recreation of a busy agent's container waits until the agent has no running job, unless forced.

### Runner (Go)

- Single static binary, entrypoint of the container. Responsibilities: connect to the backend, keep the connection alive with automatic reconnect and backoff, and run at most one job at a time: prepare the worktree (git operations per Spec 03), run the setup script when the worktree is new, spawn `claude`, pipe stdin/stdout, forward events, honor interrupt and cancel.
- The path to the `claude` executable is configurable (env), so tests can substitute a fake.
- **Spawning claude** for a job (cwd = the task worktree):
  - `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
  - `--session-id <sessionId>` for a new session, `--resume <sessionId>` otherwise
  - `--model`, effort, and `--permission-mode` from the agent
  - `--append-system-prompt` with the composed system prompt (see below)
  - `--mcp-config` with the backend MCP server (HTTP URL + `Authorization: Bearer <job token>`)
  - env: inherited container env + project env vars + `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` from the credential + `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` when the job kind is `resume_interrupted`.
  - Not `--bare`: the repo's CLAUDE.md, project `.claude/` settings, skills, and `.mcp.json` must load as in a normal session.
- Stdout lines are parsed only enough to detect `result` events. Every line is forwarded verbatim as an event with a monotonically increasing seq per job. Unacked events are buffered in memory (bounded, e.g. 50 MB, spilling to a file in the volume beyond that) and resent after reconnects.
- Stderr is captured and forwarded as diagnostic events (not shown in the timeline; available in job details).
- If the backend connection drops mid-job, the job keeps running. Input can't arrive until reconnect, and output is buffered.
- On container start, any leftover `claude` process is gone. The runner reports in `hello` that it has no active job, and the backend handles recovery.

### Runner Protocol (WebSocket, JSON messages)

Authentication: the runner token as a bearer header on connect, which maps to exactly one agent. A second connection for the same agent replaces the first.

Runner → backend:
- `hello` {runnerVersion, claudeVersion, activeJobId | null}
- `job.accepted` {jobId}
- `job.setup_output` {jobId, chunk} (worktree preparation and setup script output)
- `job.event` {jobId, seq, line} (one raw stream-json line); acked by the backend
- `job.stderr` {jobId, chunk}
- `job.result` {jobId, seq} (the runner saw a `result` line; sent after the corresponding `job.event`)
- `job.exited` {jobId, exitCode, signal}
- `job.failed` {jobId, stage ∈ {worktree, setup, spawn}, message}
- `pong`

Backend → runner:
- `job.start` {jobId, sessionId, mode ∈ {new, resume}, resumeInterrupted, git: {...per Spec 03}, setupScript, env (merged map, includes credential), claudeArgs: {model, effort, permissionMode, appendSystemPrompt, mcpConfig}, initialMessage (stream-json user message content blocks), attachmentsToFetch [{url, targetPath}]}
- `job.input` {jobId, message (content blocks), attachmentsToFetch}: write as a user message to stdin
- `job.interrupt` {jobId}: interrupt the current turn (mechanism per spike)
- `job.end` {jobId}: close stdin and let the process finish what was already written, then exit
- `job.cancel` {jobId}: interrupt, close stdin, SIGTERM after 10 s, SIGKILL after 20 s
- `worktree.remove` {projectId, taskId}: remove the worktree directory (never the branch)
- `ack` {jobId, seq}
- `ping`

Spec 03 added `git.token_request` / `git.token` for Git credentials. [Spec 05](05-gitlab-and-git-proxy.md) removes them: git goes through the backend's Git Proxy, authenticated with the job token.

### Queue & dispatch

- **Enqueue rules**:
  - Assigning an agent to a task with no session → create a Session (state `pending`); nothing is enqueued.
  - A user comment (or Notify agent) on a `pending` session → a QueueEntry of kind `start` at the end of the agent's queue; the comment is covered by the start snapshot.
  - A user comment (not internal) created on a task with a non-closed, non-paused session for its agent:
    - if that session has a job in state `running` → send `job.input` immediately and mark the comment `delivered` (job id);
    - otherwise → mark it `queued` and attach it to the task's QueueEntry, creating one of kind `messages` at the end of the queue if none exists. If an entry already exists, its position is kept and the comment is merged into it.
  - "Notify agent" behaves exactly like a comment whose body is generated (system-authored, see below).
- **Dispatcher**: per agent, triggered on enqueue, job end, runner connect, and a periodic tick. When the agent is enabled, its runner is connected, its container is running with the current image, and it has no job in `dispatched/running/finishing`, take the first QueueEntry by position under a row lock (`FOR UPDATE SKIP LOCKED`), create a Job, build `job.start`, delete the entry, mark its comments `delivered`, and set the session to `running`.
- **Initial message** content:
  - kind `start` (new session): task snapshot (key, title, status, priority, tags, description) + all existing non-internal comments in order + the task branch name.
  - kind `start` for a reassigned task: same, including the previous agent's comments (without activity), plus a line stating that a previous agent worked on the existing branch.
  - kind `messages`: the merged pending comments.
  - kind `resume_interrupted`: the pending comments if any, otherwise a short system message ("The previous run was interrupted by a restart; continue where you left off.").
  - Comment formatting: `[Comment by <display name> — <ISO timestamp>]` followed by the markdown body. Image attachments become image content blocks (up to 5 MB each, otherwise treated as files). Other attachments are fetched by the runner into the worktree's `.claude-task/attachments/<commentId>/` directory (excluded from git via the worktree's `info/exclude`) and their paths are listed under the comment.
- **End of turn**: on `job.result`, the backend records the Turn and immediately sends `job.end`. The job moves to `finishing`, and new comments from that moment on are queued instead of injected (they go to the back of the queue). Messages already written to stdin are processed by `claude` before it exits (possibly producing extra turns, which are recorded normally). On `job.exited` the job finishes, the session becomes `idle`, and the dispatcher runs.
- **Manual queue management**: members can reorder entries (fractional positions) and remove entries. Removing an entry marks its comments `not_delivered` (reason "removed from queue"). A `start` entry can't be removed (unassign the agent instead).

### Session lifecycle rules

| Event | Behavior |
|---|---|
| Task moved to a `closed`-category status | If a job is running: `job.cancel`. Delete the QueueEntry; mark its comments `not_delivered` ("task closed"). Session → `closed`. Send `worktree.remove` (when the runner is connected, otherwise on next connect). |
| Closed task moved back to a non-closed status | Session → `idle` (same session id), or `pending` if it never started. Nothing is enqueued; the next comment (or Notify agent) enqueues a `messages` entry. At job start the worktree is recreated from the task branch (Spec 03). |
| Agent unassigned (no replacement) | If running: `job.interrupt` then `job.end`. Delete the QueueEntry (`not_delivered`, "agent unassigned"). Session → `paused`. Later comments get `not_delivered` ("no agent assigned"). |
| Reassigned to a different agent | The old session follows the unassign rule. If the new agent has a `paused` session for this task, it's reactivated (→ `idle`) and enqueued as `messages`, with every non-internal comment posted since that session's last job. Otherwise a new session and a `start` entry. |
| Agent disabled | Running job finishes normally; no new jobs dispatched; queue retained. |
| Container restart / crash mid-job | On `hello` without that active job (or on a runner reconnect timeout of 5 min), mark the job `interrupted`, the session `idle`, insert a `resume_interrupted` entry at the **front** of the queue, and post a system comment. |
| `job.failed` at stage worktree/setup/spawn | Job `failed`, session `idle`, system comment with the error and the setup output tail. Pending comments of that dispatch revert to `queued` on a new entry at the front, but the dispatcher won't retry automatically: a member must click **Retry** on the task (or post a comment). |
| Stop button | `job.interrupt`. The turn ends; normal end-of-turn handling applies. The session stays valid. |

### System prompt composition

`--append-system-prompt` is the concatenation of:
1. **Platform section** (fixed template): the agent's name; the task key and project; the worktree path and task branch; that every text it writes is posted as a comment on the task, so it should write for humans and use markdown; that new messages from humans may arrive mid-work and must be taken into account; that if it needs clarification it should ask in text and end its turn, since the answer will arrive as a new message; the available task tools and their purpose; that before moving the task to a `review`-category status it must commit, push the task branch, and open or update the pull request with `open_pull_request` (Spec 03); that it must never push to branches other than the task branch; that attachments live under `.claude-task/attachments/`.
2. **Project agent instructions**, if any.
3. **Agent system prompt**, if any.

### Event projection (stream → timeline)

- Every `job.event` is stored as a SessionEvent (idempotent on job + seq), then projected:
  - `stream_event` text/thinking deltas → broadcast only (live typing) on the task topic, not persisted.
  - `assistant` messages with `parent_tool_use_id = null`:
    - consecutive text blocks → one **agent Comment** (kind agent, author = agent), created at the first text block and appended to until a tool_use block or the turn ends;
    - thinking blocks → a **thinking** timeline item attached before the next agent comment (collapsed in the UI);
    - tool_use blocks → added to the current **activity group** (one group per run of consecutive tool calls between texts). Each entry: tool name, one-line summary derived per tool (Edit/Write/Read → path; Bash → command, truncated; Grep/Glob → pattern; WebFetch/WebSearch → url/query; MCP tools → server + tool name; Agent → subagent description), status pending.
  - `user` messages carrying tool_result → update the matching activity entry: status ok/error, a short outcome (e.g. Bash exit code when available), and the output truncated to 20 KB for display (full output stays in SessionEvent).
  - Messages with non-null `parent_tool_use_id` (subagents) → nested under the activity entry of that tool_use. Their text and thinking don't create agent comments.
  - `result` → **turn summary** item: duration, tool call count, cost estimate, subtype. Non-success subtypes also create a **system** comment.
  - `system/api_retry` → transient "retrying (attempt n/m)" status broadcast. When retries are exhausted or the error is `authentication_failed`, `billing_error`, `oauth_org_not_allowed`, or `account_on_hold` → a **system** comment with a human explanation (e.g. "Credential X was rejected — check it in Credentials").
  - `rate_limit_event` → RateLimitObservation for the agent's credential.
  - `system/compact_boundary` → small system timeline item "context compacted".
  - `system/init` → store the claude version and loaded MCP servers on the job. If the task MCP server failed to load, post a system comment.
- The projection logic is a pure function from (previous projection state, event) to (timeline mutations, broadcasts), so it can be unit tested exhaustively with recorded streams, and replayed if the projection rules change.

### Task tools (MCP)

- The backend exposes an MCP server over Streamable HTTP. Each `job.start` carries a **job token** (random, hashed in DB) scoped to (agent, task, session), valid until the job ends. Requests with an unknown or expired token get 401.
- Tools (all mutations are recorded as Revisions with the agent as actor):
  - `get_task(key?)`: default is the own task. Returns fields, the project's statuses with categories, tags, assignees, and non-internal comments (most recent 50; older ones on request with a cursor). Reading the own task sets `last_seen_task_version`.
  - `list_tasks(status_category?, tag?, text?, limit?)`: tasks of the same project, summary fields only.
  - `update_task(title?, description?, priority?, tags?)`: own task only. Tags must exist in the project.
  - `set_status(status_name)`: own task only. Rejects statuses whose category is `closed`.
  - `create_task(title, description?, priority?, tags?)`: same project, first `open` status, no assignees, created_by = agent.
  - `open_pull_request(title, body, draft?)`: defined in Spec 03.
- Tool errors return MCP tool errors with clear messages, so the agent can correct itself.

### Notify agent of changes

- A task "has unseen changes" when its current version is greater than the session's `last_seen_task_version` **and** at least one revision after it was made by a user (not the agent itself). Changes to assignees and status don't count (status doesn't drive the agent); title, description, priority, and tags do.
- The task view shows a banner with the **Notify agent** button. Clicking creates a system-authored message containing a field-by-field diff (unified diff for the description) of the revisions since `last_seen_task_version`, delivered like a comment (inject or queue). A system comment "Agent notified of task changes" goes on the timeline. On delivery, `last_seen_task_version` becomes the current version.

### Real-time additions

- Task topic: session state changes, queue position changes, comment delivery state changes, live text/thinking deltas, timeline item created/updated (agent comment growth, activity entry updates, turn summary), transient retry status.
- Board topic: card-level session indicator (agent avatar + state).
- Agents topic (new): agent state, queue changes, build progress, container state.

### UI

- **Task view**: agent assignee picker (separate from people), session state chip with queue position, Stop button while running, Retry button after a failed job, the "unseen changes" banner, delivery badges on user comments, and timeline rendering for agent comments (agent avatar), collapsed thinking, collapsed activity groups ("6 actions ▸" with icons per tool and an error marker when any failed), nested subagent activity, turn summaries, and system comments (warning style).
- **Board cards**: agent avatar with a state dot (running animates, queued shows position).
- **Agents list**: all agents with state, current task, queue length, credential name, last activity.
- **Agent detail**: configuration form (admin; Dockerfile editor with syntax highlighting), build history with logs (live while building), container state with Rebuild / Restart / Force recreate, live container logs, queue (drag to reorder, remove), current job, recent jobs, usage (tokens/cost per day, per task) and latest rate-limit status.
- **Credentials** (admin): list, create, rotate, delete (blocked if in use).
- **Project settings**: "Agents" tab with setup script, agent instructions, env vars and secrets (secrets admin-only), plus a `.env` import (paste or pick a file, live preview of names and overwrites, atomic: an invalid file writes nothing).

## Testing Decisions

- **What a good test is**: drive the system through its public seams and assert observable outcomes: API responses, timeline content, real-time events received, messages the fake runner receives, process behavior seen from outside the runner. No assertions on internal calls or table layouts.
- **Seam 1 — backend public API (primary)**: backend in-process against real PostgreSQL, with:
  - a **fake runner**: a test WebSocket client that authenticates with an agent's runner token, receives `job.start`/`job.input`/`job.interrupt`/`job.end`/`job.cancel`, and replays **recorded stream-json transcripts** (fixtures captured during the spike from the real CLI) as `job.event`s with controllable timing;
  - a **fake AgentRuntime** (in-memory container/image state, scripted build success/failure and logs);
  - a **fake GitProvider** (Spec 03).
  - Covers: credentials/secrets write-only behavior, agent CRUD and permission enforcement, enqueue rules (inject vs queue vs merge), dispatcher one-job-at-a-time, end-of-turn → `job.end` → late comments queued, every lifecycle rule in the table, crash recovery, queue reordering/removal, the event projection end to end (timeline items and broadcasts from fixtures), MCP tools via a real MCP client over HTTP with job tokens (scope and closed-status rejection), Notify agent diff and `last_seen_task_version`, reconciler decisions against the fake runtime.
- **Projection unit tests**: the projection function gets exhaustive table-driven tests over recorded fixtures (text/tool interleaving, subagents, errors, compaction, partial deltas). It's a pure function, so this is a legitimate deep-module seam.
- **Seam 2 — runner as a black box**: the Go runner binary started as a subprocess against a **fake backend** (test WebSocket server) and a **fake `claude` executable** (a small Go test program that reads stream-json from stdin and emits scripted responses, records its argv/env/cwd, honors interrupt, and can be told to hang or crash). Covers: argument and env composition, new vs resume, mid-turn `job.input` reaching stdin, `job.end` closing stdin, cancel escalation (interrupt → TERM → KILL), event seq/ack/resend after a backend disconnect, single-job enforcement, worktree setup and setup script output/failure (with a local bare git repo as remote, see Spec 03), attachments fetched to the right paths.
- **Seam 3 — opt-in end-to-end smoke** (manual or a dedicated CI job with credentials): real Docker, real base image, real `claude`, a throwaway GitHub repo (Spec 05 adds a throwaway GitLab project). Scenarios: assign → agent replies and moves the task to review; comment mid-run is taken into account in the same turn; Stop; container kill mid-turn → resume. The spike's recorded fixtures come from here.
- **Frontend**: Playwright against the backend + fake runner driven by fixtures: streaming agent message appears live, activity group expands, Stop sends interrupt, delivery badges move from queued to delivered, Notify agent banner.
- **Prior art**: the Spec 01 test harness (DB setup, API helpers, WebSocket test client) is extended with fake-runner and fake-runtime helpers.

## Acceptance Criteria

1. The spike ADR exists and confirms (or adjusts per the documented fallback) mid-turn injection, the interrupt mechanism, stdin-close semantics, session-id/resume, and thinking presence.
2. Credentials and secret env vars are never returned by any API after saving (only last4) and are encrypted at rest. The backend refuses to start without `SECRETS_MASTER_KEY`.
3. Creating an agent builds its image (live log), creates its container with the configured limits and volume, and the runner connects. The agent shows `idle`.
4. A Dockerfile not based on `claude-task/agent-base`, or whose final user isn't `agent`, is rejected. A failed build leaves the previous container running and marks the agent `build_failed`.
5. Assigning a task alone starts nothing; the first user comment on it, with an idle agent, starts a job within 5 seconds: the worktree exists on the task branch, the setup script ran (output visible), and `claude` runs with the session id, model, permission mode, system prompt, MCP config, credential env, and project env.
6. The agent's text appears live on the task as an agent comment, its thinking collapsed, its tool calls in collapsed activity groups, and each turn ends with a summary.
7. A comment posted while the agent works on that task is delivered immediately (`delivered`) and influences the same run (verified in the e2e smoke).
8. Comments posted on another task of a busy agent are `queued` and later delivered together in a single message with authors and timestamps.
9. Internal notes are never delivered.
10. An agent never runs two jobs at once. A comment arriving after a turn's `result` is queued at the back.
11. The Stop button interrupts the turn, and the next comment continues the same session.
12. Moving a task to `closed` cancels any running job, marks undelivered comments `not_delivered`, closes the session, and removes the worktree. Reopening and commenting resumes the same session id in a recreated worktree.
13. Unassigning pauses the session. Reassigning to another agent starts a new session with the history. Reassigning back to the original agent resumes its paused session.
14. Killing the agent container mid-turn leads, after restart, to a `resume_interrupted` job at the front of the queue and a system comment.
15. Task tools work only for the job's own task (except read-only listing in the same project). `set_status` rejects closed-category statuses. All tool mutations appear in the timeline attributed to the agent.
16. After a human edits the description, the banner appears. **Notify agent** delivers a diff, and the banner disappears once delivered.
17. Members can reorder and remove queue entries, and removed entries' comments become `not_delivered`.
18. Changing `CLAUDE_CODE_VERSION` rebuilds the base image and all agent images, and containers are recreated only when their agent is idle (or forced).
19. Authentication and billing errors from the stream appear as system comments naming the credential.

## Out of Scope

- Running agents on multiple hosts or Kubernetes (the `AgentRuntime` interface allows it later).
- Parallel jobs within one agent. Throughput comes from duplicating agents.
- Interactive permission approval from the UI (no `canUseTool` host). Permission mode is fixed per agent.
- Guardrail hooks (explicitly not wanted). Base Branch protection is handled on the Git side: by the Git Proxy's Push Policy (Spec 05, ADR 0006), with provider-side protection as optional extra.
- Agents assigning tasks to other agents, or closing tasks.
- Automatic status-driven behavior (e.g. auto-starting on "Todo", auto-closing on PR merge).
- Exposing a live terminal into the agent container.
- Network egress allowlists per agent.
- Precise billing reconciliation (cost figures are client-side estimates).
- Validating a credential before use (errors surface on the first job).

## Further Notes

- **Policy note on credentials**: Anthropic's terms let individuals use their own Pro/Max subscription token (`claude setup-token`) for their own headless use. Sharing one personal subscription across a team, or offering subscription login in a product for others, isn't allowed without approval. For team use, prefer Team/Enterprise seats (one token per person, attached to agents that person is accountable for) or an organization API key. All agents sharing a credential share its rate limits.
- `bypassPermissions` refuses to run as root, hence the mandatory `agent` user.
- The agent volume holds the Claude config directory, so session transcripts (JSONL) persist across container recreation. Deleting an agent deletes its volume and therefore its transcripts. The raw stream in `SessionEvent` remains in Postgres as the durable record.
- `--resume` must run in the same worktree path that created the session. Worktree paths are deterministic per (project, task) (Spec 03), so recreated worktrees keep the same path.
- The spike outcome must be recorded by updating [ADR 0005](../adr/0005-mid-turn-message-injection.md) from `proposed` to `accepted` (or documenting the fallback).
