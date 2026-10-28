<div align="center">

# ✨ Claude Task

**A self-hosted kanban board where Claude Code agents do the work.**

*You talk to the agents through task **comments** — and each task keeps one continuous agent session until it's closed.*

</div>

![The board — a task with an agent assigned](manual/images/projects-and-boards/board.png)

---

## What is Claude Task?

Claude Task is a shared board for your team, built for **internal use**. You plan work as **Tasks**, discuss them in comments, and let **Claude Code agents** pick them up and actually do the work — inside isolated Docker containers.

People and agents converse in the same thread, and every task stays on a single agent session so the agent keeps full context from start to finish.

## Why it's different

- 🧵 **One continuous session per task** — the agent resumes with `claude --resume`, so it never "forgets" the task.
- 💬 **Conversation, not tickets** — you steer the agent the way you'd steer a colleague, by commenting.
- 🐙 **Safe Git access** — agents reach Git only through a Git Proxy with a job-scoped token, so they can only push to their own task branch.
- 🔒 **Secrets stay private** — credentials are encrypted at rest and never leaked into a container's environment.

## How it works

| Step | What happens |
| --- | --- |
| 1. Create a **Task** | A Task gets an **Agent** assigned. |
| 2. Add a comment | The task's first user comment triggers the agent to start. |
| 3. Follow the work | The agent's transcript, status updates and tool activity stream live into the task **timeline** and the board. |
| 4. Close it | When done, the task closes and the session ends. |

## Repository layout

| Package | What it is |
| --- | --- |
| `backend/` | Node + TypeScript, Fastify, PostgreSQL (Drizzle), WebSocket API, MCP "Task Tools" server and the Git Proxy |
| `frontend/` | React + Vite board UI (shadcn/ui, TanStack Query, dnd-kit), live updates over one WebSocket |
| `shared/` | Shared TypeScript types for the API, real-time events and the runner protocol |
| `runner/` | Small Go binary embedded in the agent base image; dials a WebSocket and drives `claude` |
| `mobile-app/` | Flutter app (Android/iOS) |
| `docs/` | Living specs, domain glossary, work units and the user manual |

## 🔎 Explore the manual

The full user manual lives in [`manual/`](manual/README.md). Start here:

1. 🚀 [**Getting started**](manual/getting-started.md) — sign in and create your first useful task.
2. 🗂️ [**Projects and boards**](manual/projects-and-boards.md) — organize tasks, statuses and tags.
3. 💬 [**Tasks and conversations**](manual/tasks-and-conversations.md) — describe work, assign people, comment and attach files.
4. 🤖 [**Agent sessions and queues**](manual/agent-sessions-and-queues.md) — start, steer, stop and retry agent work.
5. 📄 [**Agent questions and files**](manual/agent-questions-and-files.md) — answer agent questions and run surveys.
6. 📖 [**Wikis**](manual/wikis.md) — maintain shared knowledge backed by Git.
7. 🔀 [**Git repositories and pull requests**](manual/git-repositories.md) — connect repos and review changes.
8. 📱 [**Native app and notifications**](manual/native-app-and-notifications.md) — phone navigation, extensions and alerts.
9. 🛡️ [**Roles and limits**](manual/roles-and-limits.md) — permissions, input and file limits.
10. 🔧 [**Troubleshooting**](manual/troubleshooting.md) — fix sign-in, delivery and agent problems.

> Admins and operators: see the [**Users and access**](manual/admin-users.md), [**Agents and credentials**](manual/admin-agents.md), [**Extensions and environment**](manual/admin-extensions.md) and [**Installation and operations**](manual/installation-and-operations.md) guides.

## 📚 More reading

- [`specs/`](specs/) — one living spec per area (board, conversation, agents, agent-sessions, runner, git-integration, wikis, voice-rooms, users-and-auth, clients).
- [`CONTEXT.md`](CONTEXT.md) — the project's domain glossary.
- [`tasks/`](tasks/) — work units tracking the build.

## 🏃 Get started locally

Requires **Node 22+**, **pnpm** and a local **PostgreSQL**.

```bash
pnpm install
cp .env.example backend/.env

pnpm dev:backend    # API on :3000
pnpm dev:frontend   # Vite on :5173, proxies /api

pnpm --filter @claude-task/backend cli create-admin --email you@example.com
```

Or run the whole stack with Docker:

```bash
docker compose up
```

---

<div align="center">

*Built for internal team use — your data, your agents, your board.* 🧩

</div>
