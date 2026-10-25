# Agents & Runtime — running and verification

Implementation of [Spec 02](spec/02-agents-runtime.md). The backend, Go runner and
frontend are implemented. Acceptance with a real Claude conversation remains pending
because the available organization has exhausted its monthly spend limit; see
[ADR 0005](adr/0005-mid-turn-message-injection.md).

## Local development

Use Node 22+, pnpm, PostgreSQL and a running Docker daemon. Copy `.env.example` to
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
and Notify agent. Project settings → Agents holds the setup script, instructions,
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
