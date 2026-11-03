# ClickUp sync

A Project can mirror a ClickUp List or View. The Project's Statuses follow ClickUp's, the matching ClickUp tasks are imported as Tasks, and the Status of a Task is kept equal on both sides. The feature is optional: nothing about it appears until an Admin stores a ClickUp token.

## Concepts

- A **ClickUp token** is a Credential kind holding a ClickUp personal API token (see [Agents](agents.md#credentials)). Admins manage it; any User can pick one when linking a Project.
- A **ClickUp Link** belongs to one Project: the Credential, the ClickUp workspace (team) id, the source (a List or a View) with its id, an optional query string, the time of the last sync and the last error.
- A **Mirrored Status** is a Status that stores the id of the ClickUp status it follows.
- A **linked Task** stores the id and URL of its ClickUp task. A task that leaves the source becomes an **Unlinked Task**.

## Behaviour

### Linking

A User links a Project to ClickUp only in the "New project" dialog. The dialog shows the ClickUp section when at least one ClickUp token exists. The User picks the token, the workspace, and either a List (chosen by Space) or a View, and may add a query string of ClickUp filters.

For a List the tasks come from the workspace's task search restricted to that List, plus the query string. For a View they come from the View's tasks and the query string is ignored, since the View carries its own filters. The query string is made of ClickUp filter parameters (`statuses[]`, `assignees[]`, `tags[]`, `due_date_gt`, `due_date_lt`, `date_created_gt`, `date_created_lt`, `date_updated_gt`, `date_updated_lt`, `include_closed`, `subtasks`, `custom_fields`, `order_by`, `reverse`, with or without the brackets); any other parameter is answered with `400`. The platform adds no filter of its own: ClickUp's defaults apply, so closed tasks and subtasks arrive only when the query asks for them. Subtasks are imported as flat Tasks.

The Project is created together with its mirrored Statuses and imported Tasks, and the answer comes after the import. If ClickUp refuses the token or the source, the answer is `400` with ClickUp's message and nothing is created. The default Statuses are not created for a linked Project.

The link can be edited (token, source, query) or removed from the Project's settings. Removing it keeps the Statuses and turns every Task into a local Task. A Project that exists without a link cannot get one.

### Synchronization

The backend polls every linked, non-archived Project every 5 minutes, one Project at a time. "Sync now" in the Project's settings runs one pass at once. A pass fetches all pages of the source, then applies them in one transaction, so a failed fetch changes nothing; the error is stored on the link and shown in the settings.

- **Statuses.** A List's Statuses are the List's. A View's are the union of the Lists its tasks belong to. Statuses are matched by ClickUp id, then by name; new ones are created, others renamed, recolored and reordered. A Status that disappears from ClickUp stays while Tasks use it. The Category of a new Status comes from the ClickUp type: `closed` gives `closed`; `open` and `custom` give `open`; a name containing "review" gives `review`, and "done" or "complete" gives `done`. A Category set by a User survives later syncs. When a deduction would leave the Project without an `open` or a `closed` Status, the Status keeps the Category it had.
- **New tasks** become Tasks in the mirrored Status of their ClickUp status, created like any Task (default Agent included). Nothing starts until the first User Comment.
- **Name** follows ClickUp, recorded as a Revision by the system.
- **Description** follows ClickUp until a User or Agent edits it. From that edit the Task's description is detached: syncs no longer touch it and the Task view shows it as out of sync. "Restore from ClickUp" copies ClickUp's last description back and reattaches it.
- **Attachments.** ClickUp attachments are copied into the Blob store as attachments of the Task, marked as coming from ClickUp. They are read-only and disappear when ClickUp drops them. Files added in claude-task stay local and are never sent to ClickUp. A file larger than the upload limit is left out and named in the sync error.
- **Status.** See below.
- **Tasks leaving the source** (filtered out, deleted or moved on ClickUp) stay as Unlinked Tasks, keeping their Session, Comments and Worktree; they relink if they return.

### Status in both directions

A Status change made in claude-task (a move, an update, a bulk move, a Task Tool) marks the Task as push-pending and, right after commit, sends the new Status name to ClickUp. The push is tried three times with growing delays; pending pushes are retried at every tick, so they survive a restart. On success the flag clears.

At each sync, a different ClickUp Status moves the Task, like a regular move by the system (a move into a `closed` Status ends the Session), unless a push is pending and ClickUp still shows the Status the Task had when last synced. ClickUp therefore wins every conflict. When a push fails for good, its error is stored and shown on the Task; the next sync moves the Task back to ClickUp's Status and clears the error. "Retry" on the Task sets the push again.

### What is locked

In a Project with a ClickUp Link:

- Creating, renaming, recoloring, reordering and deleting Statuses is answered with `403`; a Status's Category can still be edited.
- A linked Task's title cannot be edited (`403`). Its Status can be moved, and its description can be edited (which detaches it).
- Tasks created in claude-task are local: the sync neither updates nor exports them.

### Reading

`Project` carries its ClickUp Link state and every Task card carries its ClickUp state (URL, linked, description detached, pending push, error). The Task view shows an "Open in ClickUp" link, the error with a Retry button, and the out-of-sync description with its Restore button; attachment rows from ClickUp are marked.

## Architecture

- A **ClickUp client** wraps the v2 API behind an interface (teams, spaces, lists, views, List and View tasks, update task status, download attachment). It spaces requests to stay under 100 per minute and reports a `429` as an error that ends the pass.
- A **sync service** runs the polling tick, "Sync now" and the status pushes, with at most one pass per Project at a time; it stops with the server.
- The Board modules call a small hook when a Status changes outside the sync, so pushes are queued in the same transaction.
- API: `GET /clickup/credentials`, `GET /clickup/teams`, `/clickup/spaces`, `/clickup/lists`, `/clickup/views` (pickers), `POST /projects` with a `clickup` object, `PATCH` and `DELETE /projects/:id/clickup`, `POST /projects/:id/clickup/sync`, `POST /tasks/:id/clickup/restore-description` and `POST /tasks/:id/clickup/retry`.

## Data model

- Project: ClickUp Link (token Credential, team id, source type and id, query, last sync time, last error).
- Status: ClickUp status id.
- Task: ClickUp task id, URL, linked flag, last seen ClickUp update time, last ClickUp description, description-detached flag, ClickUp Status last seen, push-pending flag, last sync error.
- Attachment: ClickUp attachment id.

## Non-functional requirements

- The token is encrypted at rest, write-only through the API and never logged or sent to Runners.
- A sync stays under ClickUp's limit of 100 requests per minute and per token.
- Sync failures never delete or modify local Tasks.

## Decisions

- **Polling, not webhooks.** The backend is self-hosted and often unreachable from the internet; polling needs no setup on the ClickUp side. Five minutes keeps request volume low. Webhooks can be added later as an accelerator.
- **Statuses mirror ClickUp.** One-to-one Statuses make the bilateral Status trivial and avoid a mapping UI. The Category cannot be expressed in ClickUp, so it stays editable and survives syncs.
- **ClickUp wins conflicts.** A single rule is predictable. The only exception is a push still pending against an unchanged ClickUp Status, so a quick local move is not undone by a poll that ran before the push.
- **Leaving the source never deletes.** A Task can hold a Session, Comments and a Worktree; unlinking keeps that work and costs nothing.
- **Description detaches on edit.** Agents and Users refine descriptions; overwriting that work would be worse than staleness, and Restore gives the way back. The title has no such escape: it stays equal to ClickUp.
- **The token is a Credential kind.** Reusing the secret store gives encryption and rotation for free; Agents refuse the kind and deletion is blocked while a Project uses it.
- **Link only at creation.** A Project that already has Statuses and Tasks would need a mapping, so linking is limited to new Projects.
- **No Agent automation.** Importing many Tasks must not start or assign anything beyond the default Agent every new Task gets.

## Related specs

- [Board](board.md): Projects, Statuses and Tasks.
- [Agents](agents.md): Credentials.
- [Conversation](conversation.md): attachments.
- [Clients](clients.md): the web screens.
