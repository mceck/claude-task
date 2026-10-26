# Agents & Runtime — running and verification

Implementation of [Spec 02](spec/02-agents-runtime.md). The backend, Go runner and
frontend are implemented. Acceptance with a real Claude conversation remains pending
because the available organization has exhausted its monthly spend limit; see
[ADR 0005](adr/0005-mid-turn-message-injection.md).

## Local development

Use Node 22.20+, pnpm, PostgreSQL and a running Docker daemon. Copy `backend/.env.example` to
`backend/.env`. Set `DATABASE_URL`, the bootstrap admin details, and
`SECRETS_MASTER_KEY` to the output of `openssl rand -base64 32`. Keep that key stable
and backed up alongside the database: existing encrypted credentials need it.

Run `pnpm install`, `pnpm dev:backend` and `pnpm dev:frontend`. With a host backend,
`AGENT_BACKEND_URL=http://host.docker.internal:3000` lets the containers connect back.
For a demo without Docker, set `AGENT_RUNTIME=fake`; this simulates images and
containers, but does not run Claude or automatically attach a Runner.

As an admin, open **Credentials**, save an OAuth token from `claude setup-token` or an
Anthropic API key, then open **Agents → New agent**. The image builds automatically;
its logs are in **Builds**. The first build also builds the Base Image, including the
pinned Claude CLI and the Go runner. Wait for **Idle** before assigning a task.

The task view has a separate agent picker, session state, Stop/Retry, delivery badges
and Notify agent. The expand button beside Activity opens a full-screen conversation
with live output and a composer at the bottom; Escape returns to the task and keeps drafts and attachments.
Project settings → Agents holds the setup script, instructions,
environment variables and write-only secrets. Queue management is available to all
members; agent configuration, container controls and credentials require an admin.

## Docker Compose

Export `ADMIN_PASSWORD` and `SECRETS_MASTER_KEY`, then run
`docker compose up --build`. The app joins the `claude-task-agents` network, mounts
the host Docker socket and gives agent containers `http://app:3000` as the backend URL.
On Linux, set `DOCKER_GID` to the socket's group id (for example,
`stat -c %g /var/run/docker.sock`) so the non-root backend can access it. Docker Desktop
typically uses group 0, the default in the compose file. Set `COOKIE_SECURE=true` when
serving over HTTPS.

The production image includes the Base Image Dockerfile and runner sources, so the
backend can build agent images without a source checkout. Updating
`CLAUDE_CODE_VERSION` rebuilds images; busy agents wait until their job finishes before
container recreation. Agent home volumes survive recreation.

## Agent development environment

The Base Image includes mise, PostgreSQL 16 and Redis. The entrypoint starts both
services as the non-root `agent` user before starting the runner. They listen only
on `127.0.0.1`, with no host ports published:

- PostgreSQL: `postgresql://agent@127.0.0.1:5432/agent`, local trust authentication.
  The `agent` role is a development superuser and can create project/test databases.
- Redis: `redis://127.0.0.1:6379`, no password, append-only persistence enabled.

Service data and logs live in `~/.local/share/claude-task/` in the persistent Agent
Volume. Each agent has its own services; tasks assigned to that agent share them.
Use separate database names and Redis key namespaces/databases for separate projects.

For a newly cloned git worktree or a new conversation, the runner executes
`mise install --yes` when it finds `.tool-versions` or a standard mise TOML config
in the repository root. This happens before the project setup script and Claude.
Installation output appears in the job setup logs; failure stops the job and can be
retried. Resuming an existing conversation does not repeat installation unless its
worktree had to be recreated. The command trusts the project's mise configuration.

Mise installs the declared tools/runtimes, not application packages: keep commands
such as `pnpm install` or `bundle install` in the project setup script. Tool installs
persist in the Agent Volume, and mise shims are on `PATH` for the runner, Claude and
login shells, including when reusing a pre-existing home volume.

## Shared skills and MCP servers

Admins manage the catalog in **Skills & MCP**, then select entries in each Agent's
configuration. Skill import uses the pinned `skills` CLI (`skills add <source>
--skill <names> --agent claude-code --copy --yes`) in a temporary project. Sources
accept `owner/repo`, HTTPS repository/directory links and SSH Git URLs, as supported
by the CLI. Git authentication must be available to the backend process; the
production backend image includes Git and OpenSSH. The existing project Git
Connections are not used by the skills CLI.

The catalog stores a snapshot of all imported files, including executable scripts
and binary assets, limited to 10 MB / 1000 files per import. **Reimport** explicitly
fetches newer content while retaining skill IDs and assignments. The CLI's lock
state is isolated in the temporary directory. Secrets must not be embedded in
source URLs.

Assigned skills are synchronized into the persistent home and linked under
`/home/agent/.claude/skills/`. Claude discovers them natively; no skill list or skill
instructions are added to the platform's system prompt. Updates and unassignments
wait until the Agent has no active Job, then apply without rebuilding its image or
recreating its container. Files not managed by the platform are preserved; a name
collision with an unmanaged skill reports an error instead of overwriting it.
Recreated containers synchronize the catalog again. Pending changes and failures
appear in the Agent view, and dispatch waits for successful synchronization.

MCP entries support HTTP, SSE and stdio. Headers and stdio environment values may
be secret: they are encrypted with `SECRETS_MASTER_KEY`, returned as redacted values,
and resolved only into the new Job's MCP configuration. Saving an unchanged redacted
secret preserves its value. The internal `claude-task` server is reserved and
always added by the platform. Install stdio servers and their runtimes in the
Agent's Dockerfile; commands execute inside the Agent container. Running Jobs keep
their original MCP configuration. Assigned catalog entries must be unassigned before
they can be deleted. Duplicating an Agent copies its catalog assignments.

Web and mobile comment composers complete `/` commands for the assigned Agent,
with filtering and descriptions. Skills with `user-invocable: false` stay hidden.
The session's `system/init.slash_commands` list supplies native Claude commands,
bundled skills, project commands and MCP prompts available in that environment.
Before the first runtime report, the menu offers assigned skills plus the basic
`compact`, `context` and `usage` commands. Commands that would replace the managed
conversation or override Agent configuration are omitted. Native commands are
suggested at the beginning of a message; skills can also be mentioned in a sentence.

Native slash inputs run as standalone Jobs, in order with queued Comments. A first
slash input gets the Task context through the system prompt so its command text
reaches Claude unchanged. Local command output is shown in the Timeline once.
The web menu supports arrows, Enter/Tab and Escape; mobile supports tap selection
and preserves the surrounding draft and caret. Internal Notes do not offer commands.

## Automated checks

- `pnpm typecheck`
- `pnpm test` — real PostgreSQL, fake runtime and controllable Runner WebSockets.
- `cd runner && go test ./...` — real runner processes, fake CLI and local git remotes.
- `pnpm test:e2e` — real backend/Postgres and browser, fake runtime and Runner. This
  recreates `claude_task_e2e`; set `TEST_DATABASE_URL` for the PostgreSQL admin connection.
- `docker build -t claude-task .`

The Playwright server is a separate test-only entry point,
`backend/test/e2e/server.ts`. Its control endpoints are never registered by the
production server or bundled into the production image's executable code.

On 2026-10-25, a production-container smoke check also passed: fresh PostgreSQL,
startup migrations, admin login, creating a credential and agent, real Base Image and
agent image builds, persistent volume creation, and a real non-root Go runner
connecting back and making the agent **Idle**. No model request was needed for this
check. The temporary containers and agent volume were removed afterwards.

On 2026-10-26, the updated Base Image also passed a Docker smoke check for
non-root PostgreSQL/Redis startup, SQL writes and Redis reads, persistence across
restart and container recreation with the same home volume, and a real
`mise install --yes` from `.tool-versions` (Node 22.16.0), usable from both plain
processes and `bash -lc`. The runner suite covers installation before project setup,
skipping installation on resume, and retrying a failed installation and pending setup.

## Remaining real-CLI acceptance

Claude Code 2.1.310 was retried on 2026-10-25 with stream-json input/output and a
fresh session id. It returned a spend-limit refusal (`result.subtype = success`,
`is_error = true`, exit code 1, cost $0). That verifies the refusal shape only.
It does not establish mid-turn delivery, interrupt, successful stdin-close draining,
resume or thinking behavior. ADR 0005 stays proposed, and Spec 02 stays in-progress.

With a funded credential, record sanitized stream fixtures while checking:

1. Start with `--session-id`, inject a second user input during a tool call, and
   check whether the first result reflects it.
2. Send a stream-json `control_request` interrupt; verify the turn ends and the
   process remains available until stdin closes.
3. Queue multiple inputs, close stdin after the first result and verify the CLI
   drains the already written inputs before exiting.
4. Start another process with `--resume` in the same worktree and verify its memory.
5. Capture thinking, nested subagent activity and compaction where available.

Then update ADR 0005 with the observations (or implement the documented fallback),
add the recordings under `backend/test/fixtures/streams`, and run the real
Docker/Claude smoke scenarios from Spec 02. GitHub branch/PR operations belong to
[Spec 03](spec/03-git-integration.md); this spec does not implement that provider.
