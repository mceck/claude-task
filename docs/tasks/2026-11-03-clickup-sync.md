---
status: done
---

# ClickUp sync

## Specs

- [Board](../specs/board.md) (ClickUp link, mirrored Statuses, locked fields, Agent on creation)
- [Agents](../specs/agents.md) (the ClickUp token Credential kind)
- [Agent sessions](../specs/agent-sessions.md) (no Agent automation on Status changes)
- [Conversation](../specs/conversation.md) (ClickUp Attachments)
- [Users and authentication](../specs/users-and-auth.md) (who can use what)
- [Clients](../specs/clients.md) (Web app)

## Problem Statement

The team plans its work in ClickUp. Today every ClickUp task has to be retyped on a Project's Board, and its Status then lives in two places that drift apart. People want to work the same tasks in claude-task without duplicating them, and the feature must stay optional for installations that don't use ClickUp.

## Solution

An Admin stores a ClickUp personal API token as a Credential of a new kind. When creating a Project, a User can link it to a ClickUp **List** or **View**, with an optional query string of ClickUp filters. The Project's Statuses become a mirror of the ClickUp Statuses, and the matching ClickUp tasks are imported at once and kept in sync every 5 minutes (or on demand):

- ClickUp → claude-task: Statuses, task name, description and attachments.
- Both ways: the Task's Status. A Status change in claude-task is pushed to ClickUp; when both sides changed, ClickUp wins.

A task name and the Project's Statuses become read-only (except each Status's Category); the description is read-only-by-sync only until someone edits it, with a button to restore ClickUp's text. Attachments uploaded in claude-task stay local.

The same task also changes one rule of the board: Agents are no longer assigned automatically on Status changes.

## User Stories

1. As an Admin, I want to store a ClickUp API token as a Credential, so that Projects can read ClickUp without anyone seeing the token again.
2. As an Admin, I want a ClickUp Credential to be refused by Agents and a Claude Credential to be refused by ClickUp links, so that tokens are never mixed up.
3. As a Member, I want the ClickUp options to appear in the "New project" dialog only when a ClickUp Credential exists, so that I never see a feature my team doesn't use.
4. As a Member, I want to pick the Credential, the workspace, and a List (Space → List) or a View, so that I don't need to look up ids by hand.
5. As a Member, I want to add ClickUp filters as a query string, so that only the tasks I care about are imported.
6. As a Member, I want the matching tasks imported before the new Board opens, so that I can start working at once.
7. As a Member, I want the Project's Statuses to follow the ClickUp list, so that columns mean the same on both sides.
8. As a Member, I want each imported Task to show an "Open in ClickUp" link, so that I can jump to the original.
9. As a Member, I want a Status change on the Board to reach ClickUp, so that the team on ClickUp sees progress.
10. As a Member, I want a Status change made in ClickUp to show up on the Board within 5 minutes, so that both sides agree.
11. As a Member, I want ClickUp to win when both sides changed the same Task's Status, so that there is one clear rule.
12. As a Member, I want a failed push to show an error on the Task until the Board is realigned, so that I know why my move was undone.
13. As a Member, I want a "Retry" for a failed push, so that I can push my change again.
14. As a Member, I want a "Sync now" button in the Project's settings, so that I don't wait for the next poll.
15. As a Member, I want to see when the last sync ran and the last error, so that I can trust the link.
16. As a Member, I want task names to be read-only on linked Tasks, so that they stay equal to ClickUp.
17. As a Member, I want to edit a linked Task's description, so that I can refine it for the Agent; and I want it to stop being overwritten from then on.
18. As a Member, I want to see that a description is out of sync and restore ClickUp's text with one button, so that I can undo my edit.
19. As a Member, I want ClickUp's attachments copied to the Task and marked as from ClickUp, so that Agents can read them.
20. As a Member, I want to add my own attachments to a linked Task without them being sent to ClickUp or removed by the sync.
21. As a Member, I want a task that leaves the filter, is deleted or moved on ClickUp to stay on the Board unlinked, so that Sessions and work are never destroyed.
22. As a Member, I want an unlinked task to relink if it comes back into the filter.
23. As a Member, I want the Project's Status names, colors, order, creation and deletion locked, so that the mirror stays exact, while I can still change each Status's Category.
24. As a Member, I want to create Tasks by hand in a linked Project, staying local to claude-task.
25. As a Member, I want to change or remove the ClickUp link from the settings, with Tasks kept as local ones when I remove it.
26. As an Admin, I want a Credential used by a Project to be undeletable, so that no link loses its token.
27. As a Member, I want new Tasks to get the Project's default Agent (when enabled), whatever their Status, and no Agent change on any Status change, so that Agents are assigned only on purpose.
28. As a Member, I want a closed ClickUp task (when the filter includes closed tasks) to move to a `closed` Status and end its Session.

## Implementation Decisions

- **Credential kind.** `clickup_token` is added to the Credential kinds (secret encrypted like the others). It has no environment variable and no Agent: the Agent create/update/duplicate paths refuse it, the Agent form and the Credential-per-Agent lists exclude it, and deleting a Credential used by a Project's ClickUp link answers `409` naming the Project. Admins manage it on the Credentials page; any User lists the ClickUp Credentials (id, name, last four) to pick one.
- **ClickUp Link.** A Project optionally carries a ClickUp Link: Credential, workspace (team) id, source (`list` or `view`) and its id, the free query string, last sync time and last error. It is set only when the Project is created; it can be edited (source, query, Credential) or removed from the Project's settings afterwards, never added to an existing Project. Removing it unlocks everything and turns every Task into a plain local Task; the Statuses stay.
- **Source and query.** For a List the Tasks come from `team/{team}/task?list_ids[]={id}` plus the query string; for a View from `view/{id}/task` (the View's own filters; the query string is not used). The query is parsed as URL parameters, checked against an allowlist of ClickUp filter names (`statuses[]`, `assignees[]`, `tags[]`, `due_date_gt/lt`, `date_created_gt/lt`, `date_updated_gt/lt`, `include_closed`, `subtasks`, `custom_fields`, `order_by`, `reverse`) and refused with `400` otherwise. `include_closed` and `subtasks` are never added by the platform: ClickUp's defaults apply unless the query sets them. Subtasks arrive as flat Tasks.
- **Creation.** The backend fetches the Statuses and all pages of Tasks first; a ClickUp failure answers `400` and creates nothing. Then, in one transaction, the Project is created with the mirrored Statuses (the default Statuses are not created), the link is stored and the Tasks are imported. Attachments are downloaded right after commit.
- **Mirrored Statuses.** A Status stores its ClickUp status id. A List's Statuses come from the List; a View's from the union of the Lists of its tasks. The sync creates, renames, recolors and reorders Statuses to match, matching by ClickUp id then by name. A Status that disappeared from ClickUp stays while Tasks use it. Category: ClickUp type `closed` → `closed`, `open` and `custom` → `open`, except a name containing "review" → `review` and "done"/"complete" → `done`. A new Status takes that deduction; an existing one keeps the Category a User set. If the deduction would leave no `open` or no `closed` Status, the Status keeps its previous Category.
- **Task fields.** Each linked Task stores its ClickUp task id, URL, whether it is linked, ClickUp's last-updated time, ClickUp's last description, whether the description is detached, the ClickUp Status last seen, whether a Status push is pending and the last sync error. Title always follows ClickUp (changes recorded as Revisions by the system). The description follows ClickUp until a User or Agent edits it: that sets `descriptionDetached`; "Restore from ClickUp" copies the last ClickUp description back and clears the flag. Title edits of a linked Task answer `403 clickup_managed`. Status edits and moves are allowed.
- **Status sync.** A Status change by anyone but the sync marks the Task push-pending and, after commit, pushes it (`PUT task/{id}` with the Status name) with 3 attempts and growing delays; pending pushes are also retried at each tick (and so survive a restart). On success the pending flag clears. After a definitive failure the error is stored and the pending flag cleared. At each sync: if a push is pending and ClickUp's Status is the one last seen, the local Status is kept; in every other case a different ClickUp Status moves the Task (a regular move by the system, so Sessions follow the usual rules) and the error clears. "Retry" sets the pending flag again and pushes.
- **Reconciliation.** A sync lists the Tasks and applies them in one transaction per Project: new ones imported, known ones updated, those not returned unlinked, those returned again relinked. A List or View that fails to load changes nothing. Local Tasks and their Sessions are never deleted by the sync.
- **Attachments.** ClickUp attachments are copied to the Blob store as description attachments flagged with the ClickUp attachment id: they are listed with a "ClickUp" mark, are read-only, and disappear when ClickUp drops them. A file beyond the upload size limit stays out and is mentioned in the sync error. User-added attachments are untouched.
- **Agent on creation.** A new Task gets the Project's default Agent when enabled, whatever its Status (including `backlog`). Moving a Task between Statuses and assigning an Agent never change anything else: the three `backlog` rules (no Agent on creation in `backlog`, default Agent when leaving it, moving to `open` when assigning in it) are removed, and so are the clients' confirmations. Tasks created by Agents and schedules keep their current explicit rules.
- **Polling.** `ClickUpSync` runs a tick every 5 minutes over the linked, non-archived Projects, one Project at a time, and is stoppable like the Git sync. "Sync now" runs one Project at once. A request throttle keeps the calls under ClickUp's limit; a `429` ends the pass with a stored error and the next tick tries again. Calls go through a `ClickUpClient` interface so tests can replace ClickUp.
- **API.** `GET /clickup/credentials`, `GET /clickup/teams|spaces|lists|views` (pick a workspace, Space, List or View with a chosen Credential), `createProjectBody.clickup`, `PATCH`/`DELETE /projects/:id/clickup`, `POST /projects/:id/clickup/sync`, `POST /tasks/:id/clickup/restore-description`, `POST /tasks/:id/clickup/retry`. `Project.clickup` and `TaskCard.clickup` carry the state to clients. Status create/rename/recolor/reorder/delete in a linked Project answer `403 clickup_managed`; Category edits are allowed.
- **Web app.** Credentials page gains the kind. The "New project" dialog gains an optional ClickUp section. Project settings gain a ClickUp section (status of the link, Sync now, edit, remove) and the Statuses settings lock what is locked. The Task view shows the "Open in ClickUp" link, the error with Retry, the title read-only, and the out-of-sync description with Restore. Attachment rows show the ClickUp mark.
- **Migration.** Adds the enum value, the Project link columns, the Task and Status ClickUp columns and the Attachment ClickUp id.

## Testing Decisions

- **Seam: backend public API** (HTTP) against real Postgres with a **fake ClickUp** (an in-memory `ClickUpClient` installed through the server overrides, like the fake Git provider) and the existing fake runtime. It covers creation/import, Status mirroring, both-way Status sync and conflicts, push failure, unlink/relink, locks, description detach/restore, attachments and the Agent-on-creation rule. The sync is driven through `POST …/clickup/sync` and `tick()`.
- A small unit test of the query-string allowlist and the Category deduction (table-driven).
- Prior art: `git.test.ts`, `schedules.test.ts` and `tasks.test.ts` for helpers and fakes. Existing `tasks.test.ts` cases about Backlog and default Agent are updated.
- Frontend: typecheck only; no new Playwright cases (the e2e suite stays as it is).

## Acceptance Criteria

- [x] Creating a Project with a List or View link imports its Statuses and Tasks before answering; a ClickUp failure creates nothing.
- [x] Polling every 5 minutes and "Sync now" apply ClickUp's Status, name, description and attachments.
- [x] A local Status change is pushed to ClickUp; a conflicting ClickUp change wins; a failed push is shown and then realigned, and Retry works.
- [x] Tasks leaving the filter are unlinked, kept and relinked on return; local Tasks and Sessions are never deleted.
- [x] Title and Statuses (except Category) are locked in linked Projects; the description detaches on edit and can be restored.
- [x] ClickUp attachments are copied and read-only; local ones are kept.
- [x] The ClickUp Credential kind is refused by Agents, protected from deletion while linked, and invisible in the UI when absent.
- [x] New Tasks get the default Agent whatever their Status, and no Status change changes the Agent.
- [x] Specs and glossary updated; `pnpm typecheck` and the backend suite pass.

## Out of Scope

- Webhooks, creating or deleting tasks on ClickUp, syncing priority, assignees, tags, dates or comments, reproducing subtask hierarchy.
- Linking an existing Project, and the native app's own ClickUp UI (it receives the same data from the API but title edits are refused by the backend).
- Custom Fields filters beyond the query string; a count preview.

## Further Notes

- ClickUp API: v2 (`https://api.clickup.com/api/v2`), personal token in the `Authorization` header; limit of 100 requests per minute per token.
