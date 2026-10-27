# Claude Task

Self-hosted kanban board (ClickUp-style) where tasks are worked by Claude Code agents running in Docker containers. People talk to agents through task comments, and each task keeps one continuous Claude Code session until it's closed. It's for internal team use.

## Docs (read before changing behavior)

- `docs/CONTEXT.md`: the domain glossary. Use its terms in code, UI and docs (Session/Job/Turn, Comment vs Message, Status vs column, etc.). If you need a new concept, add it there first.
- `docs/specs/`: one living spec per area, with its architectural decisions: users-and-auth · board · conversation · agents · agent-sessions · runner · git-integration · wikis · clients. Read the affected specs first; don't contradict a recorded decision silently: change it in the spec, with the new rationale.
- `docs/tasks/`: units of work with their `status`. See Workflow below.

## Stack & layout

pnpm monorepo:
- `backend`: Node + TypeScript, Fastify, PostgreSQL via Drizzle (migrations run on startup), dockerode on the host's mounted `/var/run/docker.sock`, MCP server (Streamable HTTP) for agent Task Tools, Git Proxy (smart HTTP) to GitHub/GitLab Git Connections.
- `frontend`: React + Vite, TanStack Query, dnd-kit, a single WebSocket for live updates. UI kit: shadcn/ui (Radix base, `src/components/ui/`, add components with `pnpm dlx shadcn@latest add <name>` from `frontend/`), Tailwind v4 tokens in `src/index.css`, dark theme by default.
- `shared`: TS types for API payloads, real-time events and the runner protocol. It's the single source of truth.
- `runner`: Go static binary (plus git credential helper), baked into the Base Image `claude-task/agent-base`, built locally by the backend.

## Commands

Needs Node 22+, pnpm and a local PostgreSQL (tests create throwaway databases through `TEST_DATABASE_URL`, default `postgres://localhost:5432/postgres`).

- `pnpm install`
- `pnpm typecheck`: all packages.
- `pnpm test`: backend suite (Vitest, real Postgres). One file: `pnpm --filter @claude-task/backend exec vitest run test/tasks.test.ts`.
- `pnpm test:e2e`: Playwright (recreates the `claude_task_e2e` database, starts backend on :3100 and Vite on :5174). First time: `pnpm --filter @claude-task/frontend exec playwright install chromium`.
- Dev: `cp .env.example backend/.env`, then `pnpm dev:backend` (:3000) and `pnpm dev:frontend` (:5173, proxies `/api`).
- `pnpm --filter @claude-task/backend cli create-admin --email <e> [--password <p>]`: create or promote an admin.
- `pnpm --filter @claude-task/backend db:generate --name <name>`: new migration after editing `backend/src/db/schema.ts`.
- `docker build -t claude-task .` / `docker compose up`: the production image serves API, WebSocket and frontend.

## Invariants (don't break these)

- **The first User Comment is the trigger.** Assigning an Agent only creates a `pending` Session; its first Job starts on the first User Comment. Notify agent works only on `idle` or `running` Sessions. Task Status never drives an Agent, except that a `closed`-category Status ends the Session.
- **One Job at a time per Agent.** The Queue lives in the backend DB. The Runner is stateless, dials out over WebSocket, and resends events using seq/ack.
- **One Session per (Task, Agent)**, resumed with `claude --resume <id>`. Worktree paths are deterministic per (project, task) because resume needs the same cwd.
- **Agents run `claude -p --input-format stream-json --output-format stream-json`**, not `--bare` (repo CLAUDE.md, `.claude/` and `.mcp.json` must load). Comments for the running Task are written to stdin mid-turn. Everything else waits in the Queue.
- **The Timeline is projected from the stdout stream, never from hooks.** The platform configures no hooks. The projection is a pure function over stored raw events.
- **The `claude` version is pinned centrally** (`CLAUDE_CODE_VERSION`, auto-updater off). The stream-json format is a contract.
- **Secrets** (Credentials, project secret env) are encrypted at rest (`SECRETS_MASTER_KEY`), write-only in the API (last4 only), never logged, and sent per Job, never as container env.
- **The agent user is non-root** (`bypassPermissions` refuses root). Agent Dockerfiles must start `FROM claude-task/agent-base` and end as `USER agent`.
- **Agents reach git only through the Git Proxy** with their Job token, valid only for that Job's Repository while the Job is active (see `docs/specs/git-integration.md`). Provider credentials (Git Connections) never leave the backend. The proxy's Push Policy (only the Task Branch, no deletions or tags) keeps Agents off the Base Branch; provider-side protection is informational.
- **Internal Notes are never delivered** to an Agent.

## Testing

Test external behavior only, at the highest seam:
1. **Backend public API** (HTTP + WebSocket + MCP) against real Postgres, with a fake runner (replays recorded stream-json fixtures), a fake `AgentRuntime` and a fake `GitProvider`. This is where most tests go.
2. **Runner as a black box**: the Go binary against a fake backend WebSocket, a fake `claude` executable (path configurable) and a local bare git repo as origin.
3. **Opt-in e2e smoke** with real Docker, `claude` and GitHub.

The event projection gets table-driven unit tests over recorded fixtures. Frontend gets a small Playwright suite.

## Workflow

This project is developed spec-first with the `write-spec`, `write-task`, `grill-with-task` and `implement` skills.

- `docs/specs/`: living specs, one per area of the system, describing in detail what it does and the architectural decisions behind it. Every change to behaviour or architecture updates the affected specs in the same change, using the `write-spec` skill.
- `docs/tasks/`: one file per unit of work. Keep the `status` in its frontmatter (`to-do`, `in-progress`, `done`) current while working on it.
- `docs/CONTEXT.md`: the domain glossary. Use its terms in code, specs and tasks.
