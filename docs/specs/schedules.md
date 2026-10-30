# Schedules

Schedules make Agents work on their own. An Admin configures a **Schedule** with a name, an Agent, a cron expression, a time zone and an initial prompt. At every due time the platform starts a **Scheduled Run**: it creates a Task, assigns the Agent and posts the prompt as the first User Comment, so the normal Session, Queue and Timeline machinery does the work. A Schedule is tied to a Repository, and then its runs work on a clean Worktree of it, or it is global, and then its Agent can read the state of every board and act on Tasks. Schedules and their runs live in their own section of the web app, shown as a list with a history table instead of a kanban board. It exists for recurring, unattended work (a nightly review, a morning triage, a weekly report) that would otherwise depend on someone remembering to start it.

## Concepts

- A **Schedule** is a configured recurring job: name, Agent, cron expression, time zone, initial prompt, an optional Repository with its Base Branch, a read-only flag and an enabled flag.
- A **Schedule Project** is the Project of kind `schedule` that carries one Schedule. It is hidden from the Projects list and the Boards list, like a Wiki Project, and each Scheduled Run is a Task of it.
- A **Scheduled Run** is one execution of a Schedule: a Task of its Schedule Project with one Session, normally with one Job. Its first User Comment is the Schedule's prompt, authored by the Schedule.
- A **skipped run** is a due time that did not start a run. It has no Task and appears as a row in the Schedule's history with its reason.
- A **tied Schedule** has a Repository. A **global Schedule** has none, and its Agent receives the global Task Tools.
- A **read-only Schedule** has every git push of its Jobs refused by the Git Proxy. Nothing else about the Agent's permissions changes.
- The **run history** of a Schedule lists its Scheduled Runs and skipped runs, newest first.

## Behaviour

### Permissions

| Action | Who |
| --- | --- |
| List Schedules, open one, read its run history and open a run's Task | Every User |
| Create, edit, pause, resume, delete and run a Schedule | Admins |

Requests outside these permissions are answered with `403`.

### Creating and editing a Schedule

| Field | Rule | Default |
| --- | --- | --- |
| Name | 1 to 100 characters, trimmed, unique ignoring case among Schedules (`409` otherwise) | required |
| Agent | an existing enabled Agent | required |
| Cron expression | five fields (minute, hour, day of month, month, day of week), with lists, ranges and steps; at most one run per minute | required |
| Time zone | an IANA name such as `Europe/Rome` | `UTC` |
| Prompt | 1 to 50,000 characters | required |
| Repository and Base Branch | optional; checked like a Project's Repository (see [Git integration](git-integration.md)) | none, meaning global |
| Read-only | yes or no | no |
| Enabled | yes or no | yes |

An invalid field is answered with `400` and nothing is stored. The Schedule Project is created in the same transaction, with a Project Key generated from the name and the fixed Statuses below. The creator is recorded. Editing any field applies from the next run; runs already started keep what they started with. Changing the cron expression, the time zone or the enabled flag recomputes the next run time. Deleting a Schedule deletes its Schedule Project, its Tasks and its history, and stops its running Sessions.

The list shows each Schedule with its Agent, the cron expression in words, its scope (Repository or global), a read-only badge, the next run time, the outcome of the latest run and an enabled switch.

### Starting a run

The scheduler's 30-second tick looks for enabled Schedules whose next run time has passed. Each due Schedule goes through these steps in order:

1. **Skip checks.** The tick skips the run, and records the reason, when the Agent is disabled or deleted ("agent unavailable") or when the previous run is still active ("previous run still active"). A run is active while its Session is `running` or `idle` with a Job waiting or active.
2. **Catch-up check.** After downtime, a Schedule that is overdue by less than its own period starts one catch-up run, however many due times it missed. When it is overdue by its period or more, the overdue run is skipped and recorded ("missed"), and the Schedule continues from the next due time.
3. **Creating the run.** The platform creates a Task titled "<Schedule name> · <date and time in the Schedule's time zone>" in the Schedule Project, created by the Schedule, in the `Running` Status, assigns the Agent (a `pending` Session) and posts the prompt as the first User Comment, authored by the Schedule. That Comment is the trigger of the first Job, as for any Task.
4. **Next time.** The next run time is computed from the cron expression in the Schedule's time zone, after every start or skip.

**Run now** starts a run immediately, for Admins, ignoring the "previous run still active" check but not the Agent availability check, and leaves the next run time unchanged. The request is answered with the new run.

The cron expression is evaluated in the Schedule's time zone. A time that does not exist on a daylight saving change runs at the first valid minute after the gap; a time that happens twice runs once, at its first occurrence.

### Statuses and the end of a run

A Schedule Project has three fixed Statuses that no one edits:

| Status | Category |
| --- | --- |
| Running | open |
| Succeeded | closed |
| Failed | closed |

When the Job of a run ends, the scheduler moves the Task: to `Succeeded` when the Job completed, and to `Failed` when it failed, was interrupted or never started. The `closed` Category ends the Session at once and removes the Worktree, as for any Task. While the run is `Running`, Users can still write Comments to it, for example to steer or stop the Agent. A closed run accepts no Comments, its Timeline stays readable, and starting the Schedule again goes through Run now. A Task of a Schedule Project that a person moves to another Status is refused.

### Global Schedules and the global Task Tools

A global Schedule has no Repository, so its runs work in a plain directory without git, the same as any Project without a Repository (see [Runner](runner.md)). Its Agent receives, besides the Task Tools of its own run, the global Task Tools, which act on every Project:

| Tool | Behaviour |
| --- | --- |
| `list_projects` | The ordinary Projects that are not archived: key, name and Task counts per Category. |
| `list_tasks` | Gains an optional `project` key; without it, lists the Project of the run's own Task. |
| `get_task` | Accepts the key of a Task of any Project. |
| `update_task_by_key` | Updates the title, description, priority and tags of any Task, as Revisions attributed to the Agent. |
| `set_task_status` | Moves any Task to a Status of its Project. Statuses of the `closed` Category are refused: closing is for humans. |
| `create_task_in_project` | Creates a Task in any ordinary Project, in its first `open` Status, with no assignees and no Agent. |
| `assign_task_to_me` | Assigns the Agent to a Task. This opens a `pending` Session and starts no work. |
| `start_task` | Posts a User Comment on a Task assigned to the Agent, authored by the Schedule, so the first Job of that Task's Session is started. |

A Task started this way is an ordinary Task in an ordinary Project: it joins the Agent's Queue, runs in the same Agent Container one Job at a time, and its Timeline is read there. Tied Schedules keep the Task Tools of their own Project and receive no global tools. Wiki Projects and Schedule Projects do not appear in the global tools' project list and their Tasks are refused as targets.

### Read-only Schedules

The Git Proxy rejects every push of a Job whose Schedule is read-only, with `claude-task: this schedule is read-only`, and keeps accepting fetches. Claude's tools, Bash and the Task Tools work as for any Job. The flag is stored on the run's Job when the run starts.

### Runs without a person

Nobody answers an Agent during a Scheduled Run. The Task Tools for Questions and Surveys (`ask_question`, `create_survey`) are not offered in a Scheduled Run, and the Job's system prompt tells the Agent that it works unattended, that no human will answer, and that it should decide on its own or finish with an explanation.

### Notifications

A failed run produces a `schedule.run_failed` Notification Event, and the third skipped run in a row produces `schedule.blocked`. Both are delivered as phone alerts, with the fixed texts "A scheduled run failed." and "A schedule keeps being skipped.", to the creator of the Schedule only. The consecutive skip counter resets when a run starts. A succeeded run and a single skipped run produce no alert. These alerts are not suppressed by the closed Status of the run's Task, since a failed run is always closed. When the creator is deleted or deactivated, nobody is notified. Delivery eligibility (active User, registered phone, valid Login) is the one of [Conversation](conversation.md).

### Where Schedules appear

The web app has a **Schedules** section in the main navigation, open to every User, with the list described above and a detail page holding the configuration and the run history. The history table shows start time, duration, outcome (`Running`, `Succeeded`, `Failed`, `Skipped` with its reason) and a link to the run's Task, which opens in the ordinary Task view. Skipped rows have no link. The Tasks of Schedule Projects do not appear in the Projects list, the Boards list or Project search. The native app does not list Schedules; a run's Task opens from an alert as any Task does.

## Architecture

```mermaid
flowchart LR
    TICK[Scheduler tick, 30 s] --> DUE{Due Schedule?}
    DUE -->|skip rule| SKIP[Skipped run row]
    DUE -->|ok| TASK[Create Task in Schedule Project]
    TASK --> ASG[Assign Agent: pending Session]
    ASG --> CMT[Prompt as first User Comment]
    CMT --> Q[Queue, Job, Runner]
    Q --> END[Job ends]
    END --> ST[Task moved to Succeeded or Failed]
    ST --> CLOSE[Session closed, Worktree removed]
    ST -->|failed| NOTE[Alert to the creator]
```

- The **Schedules module** owns the Schedule configuration, the run history, the skip and catch-up rules, the next run time computation and the creation of runs. It calls the same Task, assignment and Comment operations as the API.
- The **Scheduler** gains the Schedule step in its tick. It reads time from an injectable clock and exposes the tick, so the behaviour can be tested without waiting.
- The **Task Tools server** resolves the Job to its Schedule and exposes the global tools only for global Schedules, and withholds the Question and Survey tools for every Scheduled Run.
- The **Git Proxy** reads the read-only flag from the Job.
- The **Notifications module** records `schedule.run_failed` and `schedule.blocked` in the transaction that reports them.

## Data model

- **Schedule**: id, its Schedule Project, name, Agent, cron expression, time zone, prompt, read-only, enabled, next run time, consecutive skips, creator.
- **Schedule run**: id, Schedule, due time, state (`started` or `skipped`), the Task (null for skipped), skip reason, created at. The outcome of a started run is its Task's Status.
- The Schedule Project reuses the Project's Repository and Base Branch fields; its Statuses are the three fixed ones.
- A Task's creator can be a Schedule, and a Comment's author can be a Schedule.

## Non-functional requirements

- A run starts at most 30 seconds after its due time while the backend is running; the scheduler's tick is the only clock.
- A tick creates at most one run per Schedule, whatever the number of missed due times.
- A prompt, a cron expression or a time zone is validated at the API; a Schedule that cannot compute a next run time is not stored.
- Schedule creation, edits, deletion, manual runs and failures are logged without the prompt text.

## Decisions

- **A Schedule is a Project of kind `schedule`, and each run is a Task.** Session, Queue, Timeline, Worktree, Git and alerts all assume a Project, so reusing them as the Wiki does costs one more Project kind. Making `project_id` of Tasks nullable would touch every query and invariant, and a separate run entity would need its own Session, Timeline and UI.
- **The Schedule's prompt is a User Comment, so the first-Comment invariant holds.** The Agent still starts only on a User Comment; the Schedule stands in as the author.
- **Skipped runs overlap rather than queue.** When the previous run is active, the new one is skipped. Queueing would build a backlog behind a slow Agent and replay stale work.
- **At most one catch-up run.** Replaying every missed due time after downtime would start a burst of identical work; one catch-up bounded by the period keeps recent work and drops the rest.
- **Succeeded and Failed are closed.** Unattended runs need no follow-up conversation. Closing at the end of the first Job frees the Worktree and uses the one existing mechanism that ends a Session.
- **Read-only means read-only git.** The Push Policy is the only guard that the platform can enforce reliably for every provider, while restricting Claude's tools or Bash would remove most of what a review or report needs. The Task Tools stay available, so a read-only global Schedule can still change Tasks.
- **Global tools exist only for global Schedules.** Ordinary Jobs keep Project-scoped tools. The global tools give a few explicit, auditable ways to act across boards, not a wider scope for every Agent.
- **Alerts for Schedules are phone alerts to the creator.** The platform has no other notification channel. Alerts go to one person, since an Admin who created the Schedule is the one expected to fix it.

## Related specs

- [Board](board.md): Project kinds, Statuses and Task creation.
- [Agent sessions](agent-sessions.md): Sessions, Jobs, the Queue, the Task Tools and the system prompt.
- [Agents](agents.md): the Agents that Schedules run.
- [Git integration](git-integration.md): the Repository, Worktrees and the Push Policy.
- [Wikis](wikis.md): the hidden Project pattern that Schedules follow.
- [Conversation](conversation.md): Notification Events and alert delivery.
- [Clients](clients.md): the Schedules section of the web app.
