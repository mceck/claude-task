---
status: done
---

# Scheduled agents

## Specs

- [Scheduled agents](../specs/schedules.md)
- [Agents](../specs/agents.md)
- [Agent sessions](../specs/agent-sessions.md)
- [Board](../specs/board.md)
- [Git integration](../specs/git-integration.md)
- [Clients](../specs/clients.md)

## Problem Statement

Agents only work when a person writes a Comment on a Task. Recurring work (a nightly review of the repository, a morning triage of the boards, a weekly report) needs someone to remember to start it every time. There is also no way for an Agent to look at the state of all boards, pick up Tasks by itself and start them.

## Solution

An Admin configures a **Schedule**: a name, an Agent, a cron expression, a time zone and an initial prompt. At every due time the platform starts a **Scheduled Run**: it creates a Task, assigns the Agent and posts the prompt as the first User Comment, so the normal Session, Queue and Timeline machinery does the work.

A Schedule is either tied to a Repository, and then each run works on a clean Worktree of it, or global, and then its Agent can read every board, edit Tasks, create Tasks, assign Tasks to itself and start them. A Schedule can be read-only for git: its runs cannot push.

Schedules and their runs live in their own **Schedules** section, shown as a list of Schedules with a history table of runs instead of a kanban board. Runs end by themselves: they are closed as `Succeeded` or `Failed`, with no one needed to supervise them. The person who created the Schedule is notified when a run fails.

## User Stories

1. As an Admin, I want to create a Schedule with a name, an Agent, a cron expression and an initial prompt, so that recurring work starts without anyone remembering it.
2. As an Admin, I want to choose the time zone of a Schedule, so that "every day at 09:00" means 09:00 where my team works, also across daylight saving changes.
3. As an Admin, I want to tie a Schedule to a Repository, so that its Agent works on a clean Worktree of that Repository on every run.
4. As an Admin, I want to leave a Schedule without a Repository, so that its Agent works on the boards instead of on code.
5. As an Admin, I want an Agent of a global Schedule to see every Project's Tasks, so that it can report on the state of all boards.
6. As an Admin, I want an Agent of a global Schedule to assign Tasks to itself and start them, so that it can pick up work without a person assigning it.
7. As an Admin, I want an Agent of a global Schedule to edit and create Tasks in any Project, so that it can triage, re-prioritise and report issues.
8. As an Admin, I want to mark a Schedule read-only for git, so that its runs can fetch and read the code but never push.
9. As an Admin, I want to pause and resume a Schedule, so that I can stop it without losing its history.
10. As an Admin, I want to start a Schedule right now with "Run now", so that I can test it or run it outside its cadence.
11. As an Admin, I want the list of Schedules to show a readable cadence, scope, read-only badge, next run and last outcome, so that I understand them at a glance.
12. As an Admin, I want to edit a Schedule and delete it, so that I can keep it up to date or remove it.
13. As a User, I want to see all Schedules and their runs, so that I know what the Agents do on their own.
14. As a User, I want to open the Task of a run and read its Timeline, so that I can see what the Agent did and why.
15. As a User, I want runs that were skipped to appear in the history with the reason, so that I understand why nothing ran.
16. As the creator of a Schedule, I want to be notified when a run fails, so that I notice it without watching the history.
17. As the creator of a Schedule, I want to be notified when it was skipped three times in a row, so that I notice a Schedule that never gets to run.
18. As an Admin, I want a run to be skipped when the previous one is still active, so that runs do not pile up behind a slow Agent.
19. As an Admin, I want a backend restart to cost at most one catch-up run, so that downtime does not start a burst of runs.
20. As an Agent in a scheduled run, I want to be told that nobody will answer, so that I decide on my own or fail instead of waiting.
21. As a User, I want the Tasks of Schedules out of my Projects list and boards, so that ordinary boards stay clean.

## Implementation Decisions

- A **Schedule** is a Project of kind `schedule`, following the Wiki pattern: hidden from the Projects list, with each run a Task of it. It reuses Session, Queue, Timeline, Worktree, Git and notifications. The alternative, making `project_id` of Tasks nullable, would touch every query and invariant that assumes a Project.
- Schedule configuration, stored next to the Project: Agent, cron expression (standard five fields), IANA time zone (default `UTC`), initial prompt (up to 50,000 characters), read-only flag, enabled flag, `nextRunAt`, the creator, and an optional Repository with its Base Branch (reusing the Project's Repository settings). Name, Agent and prompt are required. The Agent must be enabled when a run starts; a disabled or deleted Agent makes the run a recorded skip.
- Only Admins create, edit, pause, delete and run Schedules. Every User can read them and their runs. Other requests get `403`.
- **Scheduler tick:** the existing 30-second tick also looks for enabled Schedules whose `nextRunAt` has passed. It uses an injectable clock and a tick that tests can call, so the cron behaviour can be tested without waiting. `nextRunAt` is computed from the cron expression and time zone after every start or skip, and when the Schedule is created, edited or resumed.
- **Starting a run:** create a Task in the Schedule's Project titled "<Schedule name> · <date>", assign the Agent (a `pending` Session), post the prompt as the first User Comment authored by the Schedule, which is the trigger. A tied Schedule's Worktree comes from the Base Branch, as for any Task.
- **Skips:** a run is skipped, without a Task, when the previous run's Session is still `running` or `idle` with work, or when the Agent is disabled or missing. The skip is stored as a history row with its reason. Catch-up: after downtime at most one run starts for a Schedule, and only when it is overdue by less than the Schedule's period; otherwise the overdue run is skipped and recorded.
- **Manual run:** "Run now" starts a run immediately, ignoring the previous-run check, and does not move `nextRunAt`.
- **Statuses:** a Project of kind `schedule` has a fixed Status set: `Running` (open), `Succeeded` and `Failed` (both in the `closed` category). Nobody edits them. The scheduler moves the Task to `Succeeded` or `Failed` when the run's Job ends, and the `closed` category ends the Session at once and removes the Worktree. A running run still takes Comments (for example to stop it); a closed one does not, and there is no Retry, only "Run now".
- **Read-only:** the Git Proxy refuses every push for the Jobs of a read-only Schedule. Nothing else is restricted: Claude's tools, Bash and Task Tools keep working.
- **Global Task Tools:** the MCP server exposes, to Jobs of a global Schedule only, tools to list Projects, list and read Tasks of any Project, update a Task, move it to a Status, create a Task in any Project, assign a Task to the Agent (a `pending` Session) and start it (the first User Comment, posted on behalf of the Schedule). Statuses of the `closed` category stay reserved for humans. Jobs of a tied Schedule keep today's Task Tools, scoped to their Project. The Task Tools tools for Questions and Surveys are not exposed in scheduled runs, and the Job's system prompt says that nobody will answer.
- **Notifications:** a failed run notifies the Schedule's creator, as does the third consecutive skip. Succeeded and single skipped runs do not notify. When the creator is deleted, nobody is notified.
- **API:** Schedules are listed, read, created, edited, deleted, paused or resumed and run through the HTTP API, with a run history endpoint that returns Task-backed and skipped rows. Payloads and the real-time event live in the shared package: one `schedule.changed` event on the `schedules` topic for every change to a Schedule or its runs, on which clients refetch.
- **Web app:** a "Schedules" section in the main navigation. The list shows name, Agent, human-readable cadence, scope (global or Repository), read-only badge, next run, last outcome and an enabled switch. A Schedule's detail has its configuration and a history table with start time, duration, outcome and a link to the run's Task, which opens in the normal conversation view. Skipped rows have no link. Tasks of Schedules are absent from the ordinary Projects list, boards and Project search.
- **Glossary:** add **Schedule**, **Scheduled Run** and **Schedule Project** to the glossary, with Wiki-style hiding of the Project, and extend the definition of Task Tools to cover the global tools.

## Testing Decisions

- Seam 1, the backend's public API (HTTP, WebSocket and MCP) on real Postgres, with the fake runner, the fake `AgentRuntime` and the fake `GitProvider`. Prior art: `wikis`, `mcp`, `git-proxy`, `sessions` and `runs` tests. It covers the Schedule CRUD and its Admin-only permissions; a due tick creating the Task, assigning the Agent and posting the prompt; Status moves and the Session closing on success and failure; the skip rules and the catch-up rule; Run now; the global Task Tools; the read-only push refusal; Question tools being absent; notifications to the creator only; and that Schedule Projects stay out of the Projects list.
- The scheduler takes an injectable clock and a callable tick, so these tests move time instead of waiting. This is a parameter of Seam 1, not a new seam.
- Seam 2, table-driven unit tests for the cron parser and `nextRunAt`: time zones, daylight saving gaps and overlaps, month ends, invalid expressions. Prior art: the event projection tests.
- Seam 3, one Playwright test: create a Schedule, use "Run now", and see the run in the history with a link to its Task.
- The Runner is not changed, so it has no new tests.

## Acceptance Criteria

- [x] An Admin can create, edit, pause, resume, run and delete a Schedule; other Users can only read.
- [x] Invalid cron expressions, time zones and missing fields are rejected with `400` and nothing is stored.
- [x] A due Schedule creates one Task, assigns its Agent and posts the prompt as the first User Comment, which starts the first Job.
- [x] A tied Schedule's run works on a clean Worktree of its Repository's Base Branch; a global Schedule's run works in a plain directory without git.
- [x] A global Schedule's Agent can list Projects, read and update any Task, create Tasks in any Project, assign a Task to itself and start it; it cannot move a Task to a `closed` Status.
- [x] A tied Schedule's Agent keeps the Task Tools of its own Project only.
- [x] A read-only Schedule's Jobs have every push refused by the Git Proxy and can still fetch.
- [x] Questions and Surveys are not available in scheduled runs, and the Job's system prompt says nobody will answer.
- [x] A finished Job moves its Task to `Succeeded` or `Failed` and ends the Session and removes the Worktree at once; a running run still accepts Comments.
- [x] A run is skipped, recorded in the history and without a Task, when the previous run is still active or the Agent is unavailable.
- [x] After downtime at most one catch-up run starts, and only when overdue by less than the Schedule's period.
- [x] `nextRunAt` follows the cron expression in the Schedule's time zone, also across daylight saving changes.
- [x] "Run now" starts a run immediately and does not move `nextRunAt`.
- [x] The creator, and only the creator, is notified of a failed run and of the third consecutive skip.
- [x] Tasks of Schedules never appear in the Projects list, boards or Project search.
- [x] The Schedules section shows the list and the run history as described, in the web app.
- [x] The affected specs and the glossary are updated. The manual is left to the user's decision.
- [x] The backend suite, typecheck and the new e2e test pass.

## Out of Scope

- An inline preview of the last run's output.
- Automatic deletion of old runs.
- More than one Repository per Schedule.
- Restricting Claude's tools, Bash or Task Tools for read-only runs.
- A native-app screen for Schedules.
- Catching up on every missed run after downtime.

## Further Notes

- Depends on the existing Wikis implementation, whose hidden-Project pattern this task follows, and on the Task Tools and Git Proxy already in place.
- Open points decided as defaults: the Task title format, and prompt placeholders (none in this version).
