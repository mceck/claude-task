# Runner

The **Runner** is the platform's process inside every Agent Container. It dials out to the backend over one authenticated WebSocket, receives Jobs, prepares the Task's Worktree, runs `claude` in headless stream-json mode, writes Messages to its stdin and streams every line it prints back to the backend. All scheduling state lives in the backend: the Runner holds only what it needs for the Job in progress and the messages the backend hasn't acknowledged yet, so a restarted container or a dropped connection costs no work. It also answers the Git credential helper, which hands the current Job's token to git for the Git Proxy. The Runner is a single static Go binary baked into the Base Image, together with the Git credential helper.

## Concepts

- The **Runner** belongs to one Agent and runs at most one Job at a time. It starts with the Agent Container and lives as long as the container does.
- The **Runner token** identifies the Runner to the backend. It maps to exactly one Agent, is stored hashed by the backend and is regenerated every time the Agent Container is recreated (see [Agents](agents.md)). The Runner uses it for the WebSocket, for attachment downloads and for file uploads, and keeps it to itself.
- The **Job token** is the per-Job secret the backend puts in `job.start`. Claude Code uses it for the Task Tools MCP server, and the Git credential helper uses it as the Git Proxy password. It is valid only while the Job is active (see [Agent sessions](agent-sessions.md) and [Git integration](git-integration.md)).
- The **Runner Protocol** is the JSON message contract over the WebSocket, with a protocol version (currently 3). The shared TypeScript types are its single source of truth and the Go Runner mirrors them.
- A **Job-scoped message** is any message the Runner sends about a Job. Each carries the Job id and a **seq**: one counter per Job, starting at 1 and shared by every message type, so the backend processes them exactly once and in order.
- The **outbox** is the Runner's per-Job list of Job-scoped messages the backend hasn't acknowledged yet. It is what gets resent after a reconnect.
- **Worktree preparation** covers everything the Runner does before starting `claude`: the git steps, the tool install, the Setup Script and the attachment downloads. Its output streams to the backend as setup output.
- A Worktree carries a **setup-pending mark** from the moment it is created until its Setup Script has succeeded. The mark, not the creation itself, decides whether the Setup Script runs.

## Behaviour

### Starting up

The Agent Container's entrypoint starts the selected development services, then the Runner, all as the non-root `agent` user. The container receives the backend's Runner endpoint URL and the Runner token as environment variables. The entrypoint re-executes itself without the token and hands it to the Runner alone over a pipe, so the container's first process, the services and every later `docker exec` carry no token in their environment. Backend execs into the container (for example to install Extensions) set the token variable to empty.

On start the Runner:

1. Reads its configuration and refuses to start without the backend URL and the Runner token.
2. Removes both from its own environment, so every process it starts inherits an environment without them.
3. On Linux, marks itself non-dumpable, which keeps other processes of the `agent` user (the Agent's tools) out of its memory and its process environment.
4. Asks `claude --version` for the CLI version (10 seconds at most; `unknown` on failure).
5. Opens the Git credential socket (see [Git credentials](#git-credentials)). When the socket fails to open, the Runner logs the error and stays idle, unconnected.
6. Connects to the backend.

### Connection

The Runner opens the WebSocket with the Runner token as a bearer `Authorization` header. The backend answers an unknown or missing token with `401`. A second connection for the same Agent replaces the first: the backend closes the old one.

Right after connecting, the Runner sends `hello`, then resends every unacknowledged message of every Job it still holds, oldest Job first and in seq order. New messages produced meanwhile wait behind the resent ones. Only then does the connection become current for new sends.

While disconnected, the Runner keeps working: the running Job continues, its output accumulates in the outbox, and input waits until the backend is back.

**Reconnecting.** After a failed or lost connection the Runner waits and dials again. The wait starts at 1 second and doubles after every attempt, up to 30 seconds. Each actual wait is random between half and all of the current value, so many Runners don't reconnect in lockstep. Any attempt that gets as far as an open WebSocket resets the wait to 1 second. A dial gives up after 15 seconds.

**Heartbeats.** Both sides check the connection:

- The backend sends a WebSocket ping frame and a JSON `ping` every 30 seconds. The Runner answers the JSON `ping` with `pong`. The backend disconnects a Runner that stayed silent (no pong and no message) for a whole interval, so a half-open connection lets its Job be recovered.
- The Runner sends a WebSocket ping every 30 seconds and drops the connection when the answer takes more than 15 seconds.
- Every write has 10 seconds to complete; a failed write drops the connection and starts a reconnect.

**Versioning.** `hello` carries the protocol version, the Runner's build version and the `claude` version. The backend records the Runner and `claude` versions on the Agent. The Runner, the Git credential helper and the protocol are built from the same source as the backend into the Base Image, and a Base Image change rebuilds and recreates every Agent's image (see [Agents](agents.md)), so both ends of a connection share a protocol version by construction.

### Runner Protocol

Backend to Runner:

| Message | Fields | Effect |
| --- | --- | --- |
| `job.start` | Job id; session id; mode (`new` or `resume`); resume-interrupted flag; Worktree path; git spec or none; Setup Script; environment; Claude arguments; initial Message; attachments to fetch | Prepares the Worktree and starts `claude` (see below). |
| `job.input` | Job id; Message (stream-json content blocks); attachments to fetch | Downloads the attachments, then writes the Message to `claude`'s stdin. |
| `job.interrupt` | Job id | Stops the current Turn; the process stays alive. |
| `job.end` | Job id | Closes stdin: `claude` works through what was already written, then exits. |
| `job.cancel` | Job id | Interrupts, closes stdin and escalates to signals. |
| `job.upload` | Job id; request id; upload URL; file paths | Reads the files and uploads them to the URL (see [Uploading files](#uploading-files)). |
| `worktree.remove` | Worktree path; bare clone path or none | Deletes the Worktree directory. Branches stay. |
| `ack` | Job id; seq | Everything up to and including that seq is processed. |
| `ping` | | Answered with `pong`. |

The git spec holds the Git Proxy clone URL (without credentials), the Job token as the proxy password, the Repository's stable identity, the Base Branch, the Task Branch, a hint on whether the Task Branch exists remotely, the bare clone path and the commit identity (name and email). The Claude arguments are the model, the effort, the permission mode, the text appended to the system prompt, the tools to disallow and the MCP configuration (a JSON string carrying the Task Tools server with the Job token, plus the Agent's MCP Extensions). The environment is the merged map of the Project's env vars and secrets, the Credential's variable and, for a resumed interrupted Turn, the resume flag. Paths are relative to the Agent's home. The values themselves are chosen by the backend (see [Agent sessions](agent-sessions.md), [Agents](agents.md) and [Git integration](git-integration.md)).

Runner to backend:

| Message | Fields | Meaning |
| --- | --- | --- |
| `hello` | protocol version; Runner version; `claude` version; active Job id or none | First message of every connection. The active Job is the one being prepared or running, or else the oldest Job with unacknowledged messages. |
| `job.accepted` | Job id; seq | The Runner took the Job and starts preparing it. |
| `job.worktree_ready` | Job id; seq; created; remote branch missing | The git Worktree is ready (sent only for Jobs with a git spec). |
| `job.setup_output` | Job id; seq; chunk | Output of the git steps, the tool install and the Setup Script. |
| `job.event` | Job id; seq; line | One raw stdout line of `claude`. |
| `job.result` | Job id; seq; event seq | The `job.event` with that seq was a `result` line: a Turn ended. |
| `job.stderr` | Job id; seq; chunk | `claude`'s stderr, plus the Runner's own notes about the Job. |
| `job.exited` | Job id; seq; exit code or none; signal name or none | The `claude` process ended. Last message of a Job that started. |
| `job.failed` | Job id; seq; stage (`worktree`, `setup` or `spawn`); message | The Job ended before `claude` started. Last message of that Job. |
| `pong` | | Answer to `ping`. |

Messages of unknown type or that fail to parse are logged and ignored on both sides.

```mermaid
sequenceDiagram
  participant B as Backend
  participant R as Runner
  participant C as claude
  R->>B: hello (active Job: none)
  B->>R: job.start
  R->>B: job.accepted
  R->>R: git steps, tool install, Setup Script
  R->>B: job.setup_output ...
  R->>B: job.worktree_ready
  R->>C: spawn in the Worktree, write initial Message
  C-->>R: stdout lines
  R->>B: job.event (seq n)
  B->>R: ack (seq n)
  B->>R: job.input (a Comment arrives mid-turn)
  R->>C: user message on stdin
  C-->>R: result line
  R->>B: job.event, then job.result
  B->>R: job.end
  R->>C: close stdin
  C-->>R: exits
  R->>B: job.exited
  B->>R: ack
```

### Delivery: seq, ack and resend

Every Job-scoped message gets the Job's next seq, goes into the outbox and is sent at once when connected. The backend processes each message inside a transaction, records the highest seq it processed for the Job, and then sends `ack` with that seq. A message with a seq it has already processed is skipped and acknowledged again, and a message for a Job unknown to the backend or belonging to another Agent is acknowledged without effect. An `ack` drops every message up to that seq from the outbox.

A Job stays in the Runner's memory while its process runs or while its outbox holds anything. Once it has finished and everything is acknowledged, the Runner forgets it.

The outbox keeps up to 50 MiB of messages in memory per Job. Beyond that, further messages spill to a file on the Agent Volume, readable only by the `agent` user, and the file is deleted once the outbox empties. Memory use therefore stays bounded however long a disconnect lasts. A new Runner process starts with an empty outbox.

On `hello` the backend reconciles the active Job:

- When it is still active in the backend, the backend acknowledges up to the last seq it processed, so the Runner keeps only the rest; when the Task's conversation was reset in the meantime, it also cancels the Job.
- When the backend has already settled it, the backend acknowledges everything and sends `job.cancel`.
- Every other Job the backend considers active for this Agent is gone (the container restarted or crashed) and the backend recovers it as interrupted (see [Agent sessions](agent-sessions.md)).

The backend also recovers a Job as interrupted when the Runner stays disconnected for more than 5 minutes.

### Receiving a Job

The Runner runs one Job at a time:

- A `job.start` for a Job id the Runner already holds (a resend) is ignored.
- With no other Job in progress, the Runner starts it right away.
- When the Job in progress is being cancelled, the new Job waits for it to end. The backend dispatches the next Job as soon as it cancels one, so this is the normal path after closing a Task. The wait lasts at most the cancel's kill delay plus 5 seconds (25 seconds with the defaults); after that, or if the waiting Job is itself cancelled, it fails at stage `spawn`.
- When another Job is running normally, the new Job fails at once at stage `spawn` with "another job is running", without `job.accepted`.

`job.input`, `job.interrupt`, `job.end` and `job.cancel` for a Job the Runner doesn't hold, or that has already finished, are logged and ignored. For a Job still preparing, they wait in order (up to 1024) and apply once `claude` starts, after the initial Message. A `job.cancel` also starts its signal escalation immediately.

### Preparing the Worktree

On `job.start` the Runner sends `job.accepted` and prepares the Worktree. Preparation and Worktree removal for all Jobs happen one at a time, in the order the backend asked for them.

Every path in a Job (the Worktree, the bare clone, each attachment) must resolve inside its base directory: the Agent's home for the Worktree and the bare clone, the Worktree for attachments. A path that is absolute or leads outside fails the Job at stage `worktree` (or, for an attachment, skips that file).

**With a Repository** (the Job has a git spec), the Runner runs the git steps described in [Git integration](git-integration.md): it discards a bare clone that belongs to a different Repository, creates or updates the bare clone with the Git Proxy as `origin`, fetches with prune, leaves an existing valid Worktree untouched, or else creates it on the Task Branch (from the remote Task Branch when it exists, otherwise from the latest Base Branch), sets the commit identity and keeps the platform's directory inside the Worktree out of git. Each git command runs with terminal prompts disabled and a 30-minute limit, and its command line and output stream as setup output. A newly created Worktree receives the setup-pending mark as soon as it exists. The Runner then sends `job.worktree_ready` with whether the Worktree was created and whether the remote Task Branch is missing. Any git failure fails the Job at stage `worktree`.

**Without a Repository** (no git spec), the Runner creates the Worktree directory when missing and gives a new one the setup-pending mark.

**Tool install.** For Jobs with a Repository, when the Worktree was just created, still carries the setup-pending mark or the Job starts a new Claude Code session, and the Worktree root holds a mise configuration (`.tool-versions` or one of mise's standard TOML locations), the Runner runs `mise install --yes` in the Worktree. Resuming a session in an existing, fully set-up Worktree skips it. A failure fails the Job at stage `setup`.

**Setup Script.** When the Worktree carries the setup-pending mark and the Project has a Setup Script, the Runner runs it with `bash -lc` in the Worktree, with the same environment `claude` gets. When it succeeds (or there is none), the mark is removed. A failure fails the Job at stage `setup` with the exit code ("setup script exited with code N"), and the mark stays, so the next Job on that Worktree (after a Retry or a new Comment) runs the Setup Script again. The same holds when preparation failed right after creating the Worktree.

The tool install and the Setup Script each:

- run in their own process group, with stdout and stderr streamed as setup output;
- get 30 minutes; past that the whole group is killed and the Job fails with "timed out after" the limit;
- end with their whole process group killed, so the Job ends even when they left a background process behind.

**Attachments.** Before starting `claude`, the Runner downloads the `job.start` attachments into the Worktree. Each download uses the Runner token as bearer, has 5 minutes, writes to a temporary file and renames it into place. The backend serves only attachments of the Task of an active Job of this Agent, from non-internal, non-deleted Comments or from the Task description. A failed download is reported on stderr as a Runner note and the Job continues. Attachments of a `job.input` are downloaded the same way right before that Message is written.

### Running claude

The Runner starts `claude` (the path is configurable, so tests can use a fake) in the Worktree with:

- `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`;
- `--session-id <session id>` for mode `new`, `--resume <session id>` for mode `resume`;
- `--model` and `--effort` when set, `--permission-mode` when set, `--append-system-prompt` when non-empty, `--mcp-config` when non-empty, and `--disallowedTools <name>` for each tool to disallow.

The Runner leaves `--bare` out, so the repository's CLAUDE.md, `.claude/` settings, skills and `.mcp.json` load as in a normal session.

The environment is the Runner's own environment (already without the Runner token and the backend URL) plus the Job's environment: Project env vars and secrets, the Credential's variable (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) and `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` for a resumed interrupted Turn. These secrets exist only in the environment of that Job's processes.

`claude` runs in its own process group, so signals reach the tools it started. Once it is running, the Runner writes the initial Message to stdin as one stream-json user message (nothing when the initial Message is empty), then the queued control messages in order. A spawn error fails the Job at stage `spawn`. The CLI's own refusals (for example a session id already in use for mode `new`, or a missing transcript for mode `resume`) come back as stderr plus a non-zero `job.exited`; the backend reads them (see [Agent sessions](agent-sessions.md)).

### Messages, interrupt, end and cancel

Control messages for a running Job apply in arrival order:

- **`job.input`**: the Runner writes the Message to stdin as one stream-json user message, whether a Turn is in progress or not. Mid-turn, `claude` picks it up at its next model call, within the same Turn; while idle, it starts a new Turn. The backend merges queued Comments into one Message before sending it. When stdin is already closed, the Runner reports "could not deliver a message: claude's stdin is already closed" on stderr.
- **`job.interrupt`**: the Runner writes a stream-json `control_request` with subtype `interrupt` and a unique request id. `claude` ends the Turn and stays alive for the next Message. When stdin is already closed, the Runner sends SIGINT to the process group instead, which ends the Turn and the process.
- **`job.end`**: the Runner closes stdin. `claude` processes every Message already written, each possibly producing its own Turn, then exits.
- **`job.cancel`**: the Runner interrupts and closes stdin, which normally makes `claude` exit on its own. If the Job hasn't ended 10 seconds after the cancel, the process group gets SIGTERM; at 20 seconds, SIGKILL. When the cancel arrives during the tool install or the Setup Script, that step's process group gets SIGTERM right away (it has no gentler stop), and the Job fails with "cancelled". A cancel during the git steps takes effect when the current git command ends. A Job cancelled before `claude` starts fails at stage `spawn` with "cancelled before start".

### Uploading files

`job.upload` asks for files the Agent posts through a Task Tool (see [Agent sessions](agent-sessions.md)). It is a request outside the Job's message stream, so it carries no seq and gets no `ack`. The Runner handles it while the Job is running, alongside the Job's other messages:

- Each path is resolved against the Job's Worktree when relative, or taken as given when absolute, with symlinks followed. It must name a regular file of at most 25 MB.
- The Runner answers with one `multipart/form-data` POST to the upload URL, with the Runner token as bearer. The first part is a manifest listing every requested path in order, each with an error message when it failed ("not found", "not a regular file", "larger than 25 MB", or the read error). One file part per successful path follows, in order, named after the file's base name, with its content type taken from the extension, otherwise detected from its first 512 bytes, otherwise `application/octet-stream`.
- The backend accepts the POST only from the Runner of the Agent it asked, while the request is pending, and answers `404` otherwise. The upload has 60 seconds, the time the backend's tool call waits for it. A failed POST is reported on the Job's stderr as a Runner note while the Job runs, and in the container log once it has ended; the waiting tool call then times out on the backend. A `job.upload` for a Job the Runner doesn't hold is logged and ignored.

### Streaming output

The Runner reads `claude`'s stdout line by line through a 1 MiB buffer. Each non-blank line, with its line ending trimmed, becomes one `job.event`, verbatim. The Runner parses a line only to read its `type`; when that is `result`, it sends `job.result` right after the event, carrying the event's seq. The backend answers `job.result` with `job.end` (see [Agent sessions](agent-sessions.md)): ending the Job is the backend's decision.

**Oversized lines.** Every outgoing message is capped at 32 MiB, half of the 64 MiB the backend accepts, because a bigger message would drop the connection again on every resend. A stdout line longer than the cap, or one whose escaped message would exceed it, is replaced by a placeholder line: a stream-json object of type `unparsed`, marked truncated, carrying the first 16 KiB of the line (cut on a character boundary) and its full size in bytes. The projection skips it. When the oversized line starts with a `type` of `result`, the Runner still sends `job.result`.

**Stderr and setup output** stream as chunks of at most 64 KiB. A chunk always ends on a whole UTF-8 character: an incomplete one waits for the next bytes or for the end of the stream. The backend keeps the last 64 KiB of each per Job, for Job details and failure comments.

### Exit and cleanup

When `claude` exits, the Runner:

1. Kills its whole process group, so background processes started by tools (servers, watchers) release ports and files before the next Job.
2. Keeps forwarding output already written: it reads stdout and stderr until they stay silent for 2 seconds, for at most 1 minute in total, since a leftover process could hold a pipe open forever.
3. Closes stdin.
4. Sends `job.exited` with the exit code, or with the signal name (`SIGKILL`, `SIGTERM`, `SIGINT`, or `SIG<n>`) and no exit code when a signal ended it.

`job.exited` and `job.failed` are each a Job's last message. The Runner marks the Job finished as it sends either one, so a `job.start` the backend sends right after reading it is always accepted.

### Removing a Worktree

`worktree.remove` names a Worktree path and, for Projects with a Repository, the bare clone path. The removal waits for any earlier Worktree work and for every unfinished Job on that Worktree (closing a Task cancels its Job and removes its Worktree at once), without holding up the connection. Then the Runner runs `git worktree remove --force` in the bare clone, deletes the directory and prunes the clone's Worktree list. Local and remote branches stay. Errors are logged. A removal sent before a later `job.start` for the same Worktree happens first, so the new Job recreates the Worktree.

### Git credentials

The Base Image configures the Git credential helper for every host, with the request path included. Git uses it for every HTTP(S) request that needs authentication:

- **`get`**: the helper reads the protocol, host and path git sends. It accepts only `http` or `https` with a non-empty host and path, free of control characters, backslashes and `.` or `..` segments. It asks the Runner over a Unix socket in the Agent's home (mode 0600, directory 0700), with 3 seconds to connect and 40 seconds for the exchange, and prints the username and password it gets.
- **`store` and `erase`** do nothing, so git keeps no credential on disk.

The Runner answers from memory, with no backend round trip. It returns username `claude-task` and the Job token when there is a current, unfinished Job with a git spec and a token, and the request matches that Job's clone URL exactly: same scheme, same host and port (case-insensitive), and the same path once the leading slash and a trailing `.git` are ignored. Any other request, or one with no current Job, gets "no active task for this repository"; when the Runner is unreachable the helper reports "the task Runner is unavailable". Either way the helper exits with an error and git falls back to its normal behaviour, so public repositories on other hosts keep working.

The token works from `job.start` until the process exits, so it covers the Runner's own git steps and every git command `claude` runs, including during the final Turns after `job.end`. The backend's Git Proxy separately checks that the Job is still active (see [Git integration](git-integration.md)).

### Shutdown and restarts

On SIGTERM or SIGINT (the container stopping), the Runner sends SIGTERM to the running process group, gives it 5 seconds before SIGKILL, and exits. Unacknowledged messages are dropped with the process. When the container comes back, the new Runner has no Job: its `hello` reports none, and the backend recovers the interrupted Job and queues its resumption (see [Agent sessions](agent-sessions.md)). Worktrees, bare clones and Claude Code transcripts live on the Agent Volume and survive.

## Architecture

```mermaid
flowchart LR
  subgraph Container["Agent Container"]
    E[Entrypoint] -->|token over a pipe| R[Runner]
    E --> S[Dev services]
    R -->|spawn, stdin| C[claude]
    C -->|stdout, stderr| R
    C --> T[Tools and git]
    T --> H[Git credential helper]
    H -->|Unix socket| R
  end
  R <-->|WebSocket, Runner token| B[Backend Runner endpoint]
  R -->|attachments and uploads, Runner token| B
  C -->|MCP, Job token| M[Backend Task Tools]
  T -->|git, Job token| P[Backend Git Proxy]
```

- **Entrypoint**: starts the selected development services, then the Runner, and hands the Runner token to the Runner alone.
- **Runner**: the connection loop (dial, `hello`, resend, read, heartbeats, reconnect), the outbox per Job, Job execution (preparation, process supervision, stdin feeding, output forwarding) and the credential socket.
- **Git credential helper**: a small separate binary git calls; it only relays to the Runner's socket.
- **Backend Runner endpoint**: authenticates the Runner token, keeps at most one connection per Agent, processes messages from one Runner one at a time and in arrival order, and acknowledges them. Its handling of each message (Turns, Timeline projection, Queue, recovery) is described in [Agent sessions](agent-sessions.md).

The Runner reaches the backend at its internal URL; every connection starts from inside the Agent Container.

### Configuration

The Runner reads its settings from the container environment. Besides the backend URL and the Runner token, these are configurable, mostly for tests:

| Setting | Default |
| --- | --- |
| `claude` executable | `claude` on the path |
| Agent home | the user's home directory |
| Cancel: SIGTERM after | 10 seconds |
| Cancel: SIGKILL after | 20 seconds |
| Tool install and Setup Script limit, each | 30 minutes |
| Outbox memory per Job | 50 MiB |
| Git credential socket | a socket in the Agent home |

## Data model

The Runner keeps no database. In memory it holds:

- the connection, when there is one;
- the Jobs still running or with unacknowledged messages, oldest first, each with its `job.start`, its seq counter, its outbox, its process group and its stdin;
- the Job currently being prepared or running;
- the order of pending Worktree work.

On the Agent Volume it relies on:

- the bare clones and Worktrees (layout in [Git integration](git-integration.md)), each new Worktree with its setup-pending mark until setup succeeds;
- the outbox spill files, one per Job, while a Job's outbox exceeds its memory budget;
- the Git credential socket.

## Limits and timeouts

| What | Value |
| --- | --- |
| Dial | 15 s |
| Reconnect wait | 1 s doubling to 30 s, randomized between half and all of it; reset after a successful connection |
| Runner ping | every 30 s, 15 s to answer |
| Backend ping | every 30 s; disconnect after a silent interval |
| Write of one message | 10 s |
| Incoming message | up to 64 MiB (`job.start` can carry base64 images) |
| Outgoing message | up to 32 MiB; backend accepts up to 64 MiB |
| Placeholder for an oversized line | first 16 KiB plus the original size |
| Setup output and stderr chunks | up to 64 KiB, whole UTF-8 characters |
| Outbox in memory per Job | 50 MiB, then spill to the Agent Volume |
| Control messages waiting for a Job to start | 1024 |
| Each git command | 30 min |
| Tool install, Setup Script | 30 min each |
| Attachment download | 5 min each |
| File upload | 10 files of 25 MB each per request, 60 s per request |
| Cancel escalation | interrupt and close stdin at once, SIGTERM at 10 s, SIGKILL at 20 s |
| New Job waiting for a cancelled one | kill delay + 5 s (25 s) |
| Output drain after exit | 2 s of silence, 1 min at most |
| Runner shutdown | SIGTERM, SIGKILL after 5 s |
| `claude --version` | 10 s |
| Credential helper | connect 3 s, exchange 40 s; request up to 4 KiB, answer up to 20 000 bytes |
| Backend reconnect timeout before recovery | 5 min |
| Setup output and stderr kept by the backend | last 64 KiB each per Job |

## Non-functional requirements

- **Secrets.** The Runner token reaches only the Runner process: the entrypoint passes it over a pipe, the Runner removes it from its environment before starting anything, and on Linux the Runner is non-dumpable. Every process the Runner starts (git, mise, the Setup Script, `claude` and its tools, repository git hooks) runs without it. The Job token and the Job's environment exist only for that Job's processes. The Runner keeps them out of its logs; the Git credential helper prints a token only to git.
- **No lost output.** Every Job-scoped message is processed by the backend exactly once and in order, across reconnects and backend restarts, for as long as the Runner process lives. Output written by `claude` before it exits is forwarded.
- **Containment.** Every file the Runner writes for a Job stays inside the Agent's home, and attachments inside their Worktree. Uploads read files wherever the `agent` user can read them, which is what the Agent itself can already read and show. Processes started for a Job end with it.
- **Memory.** The Runner's memory stays bounded per Job (50 MiB of outbox, 32 MiB per message) whatever the length of a disconnect or the size of a line.
- **Observability.** The Runner logs connection changes, ignored messages and Worktree removal errors to the container log. Everything about a Job reaches the backend as setup output, stderr or a failure message, and the Runner's own notes on stderr start with `[runner]`.

## Decisions

- **The Runner dials out and holds no scheduling state.** The backend owns the Queue, Sessions, Jobs and Comment Delivery in Postgres. Calling into the container would need reachable ports or `docker exec` plumbing tied to Docker networking, and a queue inside the Runner would be lost on container recreation and invisible to the UI. With an outbound, stateless Runner, a restart or a dropped connection loses no work, and the same design works on remote hosts later.
- **One seq per Job across every message type, cumulative acks, full resend after `hello`.** The backend processes Runner messages in transactions and must apply each exactly once and in order: setup output, events, results and exits all affect the same Job. A single counter makes that a simple "highest processed seq" check, and resending everything unacknowledged after `hello` needs no negotiation.
- **The outbox spills to the Agent Volume past 50 MiB.** A Job can produce a lot of output during a long disconnect; spilling keeps memory bounded without dropping anything.
- **Secrets travel with each Job, outside the container environment.** Rotating a Credential or a project secret applies at the next Job, and a Project's secrets reach only that Project's Jobs. The container environment carries only what the Runner needs to connect.
- **Messages go to stdin mid-turn.** A Comment for the running Task is written to stdin right away, and `claude` takes it at its next model call within the same Turn. This was verified against the pinned CLI; the alternative of holding Comments until the `result` was kept only as a fallback and is unused. Since Messages written while idle each start their own Turn, merging queued Comments into one Message happens in the backend before sending.
- **Interrupt through a stream-json `control_request`.** It ends the Turn and keeps the process and Session alive. SIGINT also ends the Turn but exits the process, so it is used only when stdin is already closed.
- **The backend decides when a Job ends.** The Runner reports each `result` and the backend answers with `job.end`; `claude` then finishes what was already written and exits. This keeps "inject or queue" for new Comments a backend decision.
- **Every child runs in its own process group, killed when it exits.** Tools and setup steps start servers and watchers; left running, they hold ports and files into the next Job, or keep a pipe open and hang the Job.
- **Oversized lines become a placeholder.** A message above the backend's limit drops the connection, and since it would be resent after every reconnect, the Job would stay stuck. A 32 MiB cap, half the backend's limit, leaves room for escaping.
- **A setup-pending mark instead of "the Worktree was just created".** A Setup Script that failed or was interrupted leaves a Worktree that exists but isn't ready. The mark makes the next Job run the setup again, and a successful setup runs exactly once.
- **The Runner token stays inside the Runner process.** It outlives every Job, while `claude`, its tools, the Setup Script and git hooks run Agent-controlled code whose output reaches the Timeline. Handing it over on a pipe, removing it from the environment and making the Runner non-dumpable keep it out of their environments and memory.
- **The Git credential helper is answered locally from the current Job.** The Job token already lives in the container for the MCP server, so using it for the Git Proxy adds no secret. Answering from the Runner's memory, only for the exact proxy URL of the current Job, needs no backend round trip, cache or expiry handling. Provider credentials stay in the backend.
- **Worktree work runs one at a time, in arrival order.** A removal and a new Job for the same Task can arrive back to back; ordering them, and making a removal wait for the Jobs on its Worktree, keeps a reopened Task from losing a freshly created Worktree.
- **Files go up on request, over HTTP.** The backend asks with a small `job.upload` message and the Runner streams the files in a multipart POST, the mirror of attachment downloads. Large bytes stay off the WebSocket, whose messages are capped and resent after reconnects, and the request needs no seq because a lost one simply times out the tool call that asked for it.
- **A Job arriving during a cancel waits for it.** The backend dispatches the next Queue Entry as soon as it cancels a Job, so the Runner lets the new Job wait out the cancel escalation rather than refusing it.

## Related specs

- [Agent sessions](agent-sessions.md): the backend side of the protocol: Sessions, Jobs, Turns, the Queue, dispatch, `job.start` composition, recovery and the Timeline projection.
- [Agents](agents.md): Agent configuration, Credentials, the Base Image, Agent Containers and their recreation, Extensions.
- [Git integration](git-integration.md): the git steps of Worktree preparation, Worktree layout, Task Branch naming, the Git Proxy and its Push Policy.
- [Conversation](conversation.md): Comments, Messages, Delivery and attachments as Users see them.
- [Wikis](wikis.md): Wiki conversations run through the same Runner and Jobs.
