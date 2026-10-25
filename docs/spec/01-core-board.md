---
status: done
---

# Spec 01 — Core Board: users, projects, statuses, tasks, comments

## Problem Statement

Our team wants to delegate development work to Claude Code agents. Before agents can do anything, we need a place to organize that work: projects tied to repositories, a ClickUp-style kanban board per project, tasks with rich descriptions, and a comment thread on every task. The comment thread is the conversation channel with the agent (Spec 02), so it has to be solid, real-time, and able to tell which comments are meant for the agent and which are notes between humans.

No such tool exists in-house today. The off-the-shelf boards (ClickUp, Linear, Jira) can't host our own agents' sessions as task conversations.

## Solution

A self-hosted web application for a small internal team. Users log in with email and password. They create projects, each with its own configurable set of kanban statuses, and manage tasks on a drag-and-drop board. Each task has a detail view with description, fields, and a comment timeline. Comments support markdown and attachments, and can be flagged as **internal notes** (never sent to an agent). Every change appears live for everyone viewing the same board or task.

This spec covers the board without agents. Spec 02 adds agents, sessions, and the agent-facing timeline items. Spec 03 adds the repository link, branches, and pull requests.

## User Stories

### Authentication & users

1. As the person deploying the app, I want the first admin account to be created from environment variables on first boot, so that I can log in immediately without a setup wizard.
2. As the person deploying the app, I want a CLI command that creates an admin user, so that I can recover access if every admin is locked out.
3. As a user, I want to log in with my email and password, so that only team members can access the app.
4. As a user, I want my session to persist across browser restarts until I log out or it expires, so that I don't have to log in constantly.
5. As a user, I want to log out, so that I can end my session on a shared machine.
6. As a user, I want to change my own password, so that I can keep my account secure.
7. As an admin, I want to create user accounts with a temporary password, so that I can onboard teammates.
8. As a new user, I want to be forced to change my temporary password at first login, so that the admin doesn't know my real password.
9. As an admin, I want to assign the Admin or Member role to a user, so that only trusted people manage agents, credentials, and secrets.
10. As an admin, I want to deactivate a user, so that a departing teammate loses access immediately (including their open sessions).
11. As an admin, I want to reset another user's password to a new temporary one, so that I can help someone who forgot theirs.
12. As a user, I want to see a list of team members, so that I can assign tasks to people.

### Projects

13. As a member, I want to create a project with a name and a short uppercase key (e.g. `API`), so that tasks get readable identifiers like `API-42`.
14. As a member, I want a new project to start with a sensible default set of statuses, so that I can begin working immediately.
15. As a member, I want to edit a project's name and description, so that it stays accurate.
16. As a member, I want to archive a project, so that it disappears from the main list without losing its history.
17. As a member, I want to unarchive a project, so that I can resume work on it.
18. As an admin, I want to permanently delete an archived project, so that I can remove test projects.
19. As a member, I want to see a list of all projects with task counts per status category, so that I can see where work stands.
20. As a member, I want project keys to be unique and immutable, so that task identifiers never change or collide.

### Statuses

21. As a member, I want to add, rename, recolor, and reorder a project's statuses, so that the board fits that project's workflow.
22. As a member, I want each status to belong to a category (`open`, `active`, `review`, `done`, `closed`), so that the system (and agents) understand what a status means regardless of its name.
23. As a member, I want to be prevented from deleting the last `open` or the last `closed` status, so that the project always has an entry point and an exit.
24. As a member, I want to delete a status only after choosing where its tasks go, so that no task is left without a status.
25. As a member, I want statuses with the `closed` category hidden from the board by default with a toggle to show them, so that the board stays focused on live work.

### Tasks & board

26. As a member, I want to create a task with a title in a given column directly from the board, so that capturing work is fast.
27. As a member, I want each task to get a sequential per-project number (`KEY-n`), so that I can reference it in conversation and in branch names.
28. As a member, I want to write the task description in markdown with a live preview, so that I can give structured instructions with code blocks and checklists.
29. As a member, I want to set a task's priority (urgent, high, normal, low, none), so that important work stands out.
30. As a member, I want to create project-scoped labels with colors and attach several to a task, so that I can categorize work.
31. As a member, I want to assign one or more people to a task, so that it's clear who is responsible or reviewing.
32. As a member, I want to drag a task between columns to change its status, so that updating the board is one gesture.
33. As a member, I want to drag a task within a column to reorder it, so that I can express ordering inside a status.
34. As a member, I want board changes made by others (including agents, see Spec 02) to appear live without reloading, so that I never act on stale information.
35. As a member, I want to filter the board by assignee, label, priority, and free text, so that I can focus on a subset of tasks.
36. As a member, I want to open a task in a detail panel without leaving the board, so that I keep my context.
37. As a member, I want a direct URL for each task, so that I can share links.
38. As a member, I want to see who created a task and when, and when it was last updated, so that I have context.
39. As a member, I want a task's field changes (status, title, description, priority, labels, assignees) recorded in its timeline, so that I can see what happened and who did it.
40. As a member, I want to delete a task (with confirmation), so that I can remove mistakes.
41. As a member, I want task cards to show key, title, priority, labels, assignee avatars, and comment count, so that I can scan the board.

### Comments

42. As a member, I want to post markdown comments on a task, so that I can discuss it (and, with Spec 02, instruct the agent).
43. As a member, I want to mark a comment as an **internal note** before posting, so that teammates can discuss without the agent receiving it.
44. As a member, I want internal notes to look visually distinct, so that I always know what the agent did and didn't see.
45. As a member, I want to edit and delete my own comments, so that I can fix mistakes.
46. As a member, I want new comments to appear live for everyone viewing the task, so that the conversation feels like a chat.
47. As a member, I want to attach files to a comment (drag & drop or paste images), so that I can share screenshots, logs, and specs.
48. As a member, I want image attachments previewed inline, so that I don't have to download them.
49. As a member, I want to see comment authors distinguished by type (person, agent, system), so that I can read the timeline at a glance.
50. As a member, I want the timeline ordered chronologically, with field-change events and comments interleaved, so that I can follow the full story of the task.

## Implementation Decisions

### Architecture & modules

- Monorepo managed with pnpm workspaces, containing: backend (Node + TypeScript + Fastify), frontend (React + Vite + TypeScript), shared (TypeScript types for API payloads and real-time events), and runner (Go, Spec 02).
- PostgreSQL is the only datastore. Drizzle ORM for schema and migrations. Migrations run automatically at backend startup.
- The backend is one deployable process, shipped as a Docker image. In production it runs in a container with a data volume for attachments (and the Docker socket mounted, Spec 02).
- Backend modules for this spec (deep modules with narrow interfaces):
  - **Auth**: password hashing (argon2id), server-side sessions, login/logout, password changes, role checks. Interface: authenticate request → current user or 401; require role.
  - **Users**: CRUD for users (admin), self-service password change.
  - **Projects**: CRUD, archive/unarchive, key uniqueness.
  - **Statuses**: per-project ordered statuses with categories and the deletion/migration rule.
  - **Tasks**: CRUD, numbering, ordering, labels, assignees, revisions.
  - **Comments**: CRUD, internal-note flag, author types, attachments linkage.
  - **BlobStore**: interface for storing and retrieving attachment bytes. The MVP implementation writes to the local filesystem under the data volume. Interface: put(stream, metadata) → blob id; get(blob id) → stream + metadata; delete(blob id).
  - **Realtime**: WebSocket hub for browsers. Clients subscribe to topics (`project:<id>` for board-level events, `task:<id>` for timeline events). Domain modules publish events after the database transaction commits.
- Frontend: React Router, TanStack Query for server state, dnd-kit for the kanban, a markdown editor with preview, and a single WebSocket connection that updates the TanStack Query caches.

### Authentication

- Sessions are stored in Postgres (session id → user id, created/expires/last-seen). The session id goes in an httpOnly, Secure, SameSite=Lax cookie. Sessions expire after 30 days of inactivity.
- Bootstrap: on startup, if there are zero users and `ADMIN_EMAIL` + `ADMIN_PASSWORD` are set, create that user with the Admin role. A CLI subcommand of the backend creates or promotes an admin by email.
- Users created by an admin get a temporary password and a `must_change_password` flag. While the flag is set, only the change-password endpoint and logout are allowed.
- Deactivating a user deletes all their sessions and blocks login. Their comments and history stay.
- Roles: **Admin** (everything) and **Member** (everything except user management, agent/credential management, project secrets, and permanent project deletion). There are no per-project permissions: every member sees every project.
- Login is rate-limited per IP and per email (e.g. 10 attempts / 15 minutes).
- State-changing requests require a CSRF defense: SameSite cookie plus a required custom header on all mutating requests.

### Data model (conceptual)

- **User**: id, email (unique, case-insensitive), display name, password hash, role, active, must_change_password, timestamps.
- **Project**: id, key (unique, 2–6 uppercase letters, immutable), name, description, archived_at, next_task_number, timestamps. (Agent-related settings in Spec 02; repository link in Spec 03.)
- **Status**: id, project id, name (unique within project), color, category ∈ {open, active, review, done, closed}, position.
  - Default set on project creation: Backlog (open), Todo (open), In Progress (active), Ready for Review (review), Done (done), Closed (closed).
- **Label**: id, project id, name (unique within project), color.
- **Task**: id, project id, number (unique within project, assigned atomically from `next_task_number`), title, description (markdown), status id, priority ∈ {urgent, high, normal, low, none}, position (fractional index string for ordering within a status), created_by (actor), version (integer, incremented on every content change), timestamps. Agent assignment, session, branch, and PR fields come in Specs 02 and 03.
- **TaskAssignee** (people): task id, user id.
- **TaskLabel**: task id, label id.
- **TaskRevision**: task id, version, actor, changed fields with before/after values, timestamp. Written in the same transaction as every task update. It drives the timeline's field-change events and (Spec 02) the "notify agent of changes" diff.
- **Comment**: id, task id, author actor, kind ∈ {user, agent, system}, body (markdown), internal (boolean), edited_at, deleted_at (soft delete), timestamps. Spec 02 adds delivery fields.
- **Attachment**: id, comment id, blob id, filename, content type, size. Max 25 MB per file, 10 files per comment.
- **Actor** (used across the model): a polymorphic reference to a user, an agent (Spec 02), or the system, stored as type + id.

### API

- REST + JSON under a versioned prefix. Shapes are defined once in the shared package and validated server-side (e.g. with zod).
- Resource groups: auth (login, logout, me, change password), users (admin), projects, statuses (nested under project, with a reorder endpoint and a delete-with-migration endpoint), labels, tasks (list by project with filters, create, get, patch, delete, move = status + position in one call), comments (list by task, create, patch, delete), attachments (upload via multipart; download with an authorization check through the task).
- The **task timeline** endpoint returns comments and revision events merged in chronological order with cursor pagination. Spec 02 adds agent timeline items to it.
- Moving a task to a status in another category is an ordinary task update. This spec attaches no side effects to it (Spec 02 handles `closed`).
- Concurrency: task patches carry the `version` the client last saw. If the server version is newer and the patch touches a field that changed since then, the server returns 409 with the current task, and the client refreshes and shows a notice. Moves and reorders never conflict: last write wins.

### Real-time events

- Board topic events: task created/updated/moved/deleted (with the card projection), status list changed, label list changed.
- Task topic events: comment created/updated/deleted, revision created. Spec 02 adds session/turn/activity events to the same topic.
- Events are notifications that carry the new projection. On reconnect, clients refetch the queries they have open instead of replaying missed events.

### Frontend views

- Login, change-password (forced and voluntary), projects list, project board, task detail (side panel on the board plus a full-page route), project settings (general, statuses, labels), users admin.
- The board uses horizontal columns per non-closed status in status order, plus a "show closed" toggle. Drag & drop does optimistic updates and rolls back on error.
- The comment composer has a markdown editor, an internal-note toggle (changing the composer's styling while on), attachment drop/paste, and Cmd/Ctrl+Enter to submit.

## Testing Decisions

- **What a good test is**: it exercises external behavior through the public seam and asserts observable outcomes (HTTP responses, data later readable through the API, real-time events received by a subscribed client). Tests never assert on internal function calls, ORM queries, or table layouts.
- **Seam 1 — backend public API** is the primary seam. Tests start the Fastify app in-process against a real PostgreSQL (throwaway database per test run, transactions or truncation between tests). They drive it over HTTP and, for real-time behavior, over a WebSocket test client. The BlobStore uses a temp-directory implementation.
- Modules covered at Seam 1: Auth (login, sessions, forced password change, role enforcement, deactivation kills sessions, rate limiting), Projects, Statuses (category invariants, delete-with-migration), Tasks (numbering under concurrency, ordering, filters, version conflicts, revisions), Comments (internal notes, edit/delete permissions, attachments), Realtime (subscribers receive events after commit and never for rolled-back transactions).
- Frontend: a small Playwright suite against the real backend (seeded database) for the key flows: login, create a task on the board, drag between columns (another browser context sees the move live), post a comment and an internal note, upload an image.
- Prior art: none (greenfield). These tests set the conventions for Specs 02 and 03: test helpers for creating users, projects, and tasks through the API, a WebSocket test client, and per-run database setup.

## Acceptance Criteria

1. On a fresh database with `ADMIN_EMAIL`/`ADMIN_PASSWORD` set, the admin can log in. Without them, the CLI command creates an admin.
2. Users created by an admin must change their password before doing anything else. Deactivated users are logged out everywhere and can't log in.
3. Members can't access user management, permanent project deletion, or (Spec 02) agents, credentials, and secrets. Attempts return 403.
4. Creating a project creates the six default statuses. Project keys are unique and immutable.
5. A project always has at least one `open` and one `closed` status. Deleting a status requires a target status and moves its tasks there.
6. Task numbers are sequential per project with no duplicates, even when tasks are created concurrently.
7. Dragging a task to another column changes its status, dragging within a column reorders it, and both persist across reloads and appear live in another browser within one second.
8. Task updates create revisions, and the timeline shows field changes and comments interleaved chronologically.
9. A stale task patch that touches a changed field returns 409 without overwriting.
10. Comments render markdown. Internal notes are visually distinct and flagged in the API.
11. Image attachments preview inline. Files over 25 MB are rejected. Attachment downloads require an authenticated user.
12. Closed-category statuses are hidden on the board by default and visible with the toggle.
13. Board filters (assignee, label, priority, text) work together.

## Out of Scope

- Agents, sessions, the agent timeline, and anything about delivering comments to agents (Spec 02).
- Repository link, branches, and pull requests (Spec 03).
- Subtasks, due dates, time tracking, custom fields, multiple views (list/calendar/gantt), saved filters.
- Notifications (email, in-app inbox), @mentions.
- SSO / OAuth login, per-project permissions, multiple workspaces/tenants.
- Comment reactions and threaded replies.
- Full-text search beyond the board's simple text filter.

## Further Notes

- Domain vocabulary used across all specs: **Project**, **Status** (with **Category**), **Task** (identified by **Task Key** `KEY-n`), **Comment** (kind user/agent/system), **Internal Note**, **Revision**, **Actor**. The canonical glossary is [CONTEXT.md](../../CONTEXT.md).
- The task `version` and `TaskRevision` exist mainly for Spec 02's "the task changed since the agent last read it → Notify agent" feature, so they must be in place from the start.
