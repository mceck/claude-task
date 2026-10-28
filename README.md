# Claude Task

A self-hosted kanban board where tasks are worked by **Claude Code agents** running in Docker containers. People talk to the agents through task **comments**, and each task keeps **one continuous agent session** until the task is closed. Built for internal team use.

## How it works

- A **Task** gets an **Agent** assigned; the task's first user **comment** triggers the agent's work.
- A **Session** (one per task + agent) is resumed with `claude --resume`, so the agent keeps full context across turns.
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
docker compose up
```

A single production image serves the API, the WebSocket and the built frontend; Postgres runs alongside. An optional voice relay (TURN) can be added with `docker compose --profile turn up` by setting `VOICE_TURN_HOST`, `VOICE_TURN_SECRET` and `VOICE_TURN_EXTERNAL_IP`.

## Testing

- `pnpm test` — backend suite (Vitest against real Postgres, with a fake runner that replays recorded stream-json fixtures).
- `pnpm test:e2e` — Playwright smoke suite against backend + frontend.
- `pnpm typecheck` — all packages.

## Further reading

- `docs/specs/` — one living spec per area (board, conversation, agents, agent-sessions, runner, git-integration, wikis, voice-rooms, users-and-auth, clients).
- `docs/CONTEXT.md` — the project's domain glossary.
- `docs/manuale` — user manual.
