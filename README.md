# Claude Task

A self-hosted kanban board where tasks are worked by **Claude Code agents** in the Docker environments of **Workers**. People talk to the agents through task **comments**, and each task keeps **one continuous session** until the task is closed. Built for internal team use.

## How it works

- A **Task** gets an **Agent** assigned; the task's first user **comment** triggers the agent's work.
- A **Session** (one per task) is resumed with `claude --resume`, so the conversation survives Jobs and Agent changes.
- The agent's transcript, status updates and tool activity appear live in the task **timeline** and board.
- Agents reach git **only** through a Git Proxy with a job-scoped token, so they push only to their task branch.
- Secrets are encrypted at rest and never exposed to containers' environment.

Check the [documentation](docs/manual/README.md) for further information.

## Repository layout

| Package | What it is |
| --- | --- |
| `backend/` | Node + TypeScript, Fastify, PostgreSQL (Drizzle), WebSocket API, MCP "Task Tools" server and Git Proxy |
| `frontend/` | React + Vite board UI (shadcn/ui, TanStack Query, dnd-kit), live updates over one WebSocket |
| `shared/` | Shared TypeScript types for the API, real-time events and runner protocol |
| `runner/` | Small Go binary (static) embedded in the agent base image; dials a WebSocket to the backend and drives `claude` |
| `mobile-app/` | Flutter app (Android/iOS) |
| `docs/` | Living specs (`docs/specs/`), domain glossary (`docs/CONTEXT.md`), work units (`docs/tasks/`) and the manual |

## Getting started

Requires **Node 22+**, **pnpm** and a local **PostgreSQL**.

```bash
pnpm install
cp .env.example backend/.env

pnpm dev:backend    # API on :3000
pnpm dev:frontend   # Vite on :5173, proxies /api

pnpm --filter @claude-task/backend cli create-admin --email you@example.com
```

## Running with Docker

```bash
COMPOSE_PROFILES=db docker compose up
```

On a fresh Amazon Linux EC2 instance, clone the repo and run `scripts/deploy.sh`: it installs Docker, asks for the settings (bundled or external Postgres, S3, TURN), writes `.env` and starts everything. Persistent data lives in host directories under `~/claude-task` (`data/`, `postgres/`), not Docker volumes.

A single production image serves the API, the WebSocket and the built frontend; Postgres runs alongside. An optional voice relay (TURN) can be added with `docker compose --profile turn up` by setting `VOICE_TURN_HOST`, `VOICE_TURN_SECRET` and `VOICE_TURN_EXTERNAL_IP`.

Workers can also run on other machines. In **Workers → Hosts**, an Admin creates a Remote Host and gets a one-time Host Token. From a clone at the backend's version on that machine, run `scripts/deploy.sh host`: it installs Docker when needed, asks for the backend URL and token, builds the Host Controller image and starts it with the local Docker socket. The Controller connects outbound over WebSocket; the machine needs no inbound port. Use HTTPS, or explicitly allow insecure connections both on the Host and in the Controller for a trusted development network.

Choose the Host when creating a Worker. Moving an existing Worker requires closing its started conversations first and starts it over with empty volumes, including Development Service data. A disconnected Controller delays Docker operations while connected Runners keep processing Jobs. An installation with only Remote Hosts can set `LOCAL_HOST=false` and omit the Docker socket mount from the backend.

For a manual Controller deployment, build with `docker build --target host-controller -t claude-task/host-controller .`, then use the run command shown in the Host's connect dialog. The default `docker build -t claude-task .` still builds the backend image.

The container exposes `GET /health` for orchestration: it needs no Login and answers `503` while the database is unreachable. `docker-compose.yml` uses it as the app's healthcheck.

## Testing

- `pnpm test` — backend suite (Vitest against real Postgres, with a fake runner that replays recorded stream-json fixtures).
- `pnpm test:e2e` — Playwright smoke suite against backend + frontend.
- `pnpm typecheck` — all packages.

## Further reading

- `docs/specs/` — one living spec per area (board, conversation, agents, workers, agent-sessions, runner, git-integration, wikis, schedules, voice-rooms, users-and-auth, clients).
- `docs/CONTEXT.md` — the project's domain glossary.
- `docs/manual/` — user manual.
