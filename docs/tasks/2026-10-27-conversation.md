---
status: done
---

# Task conversation: Comments, Internal Notes, Attachments, delivery and notifications

## Specs

- [Conversation](../specs/conversation.md)
- [Agent sessions](../specs/agent-sessions.md) (how Comments become Messages)
- [Clients](../specs/clients.md) (composer, Timeline UI, push delivery)

## Problem Statement

The team delegates work to Claude Code Agents, and the only channel between people and an Agent is the Task's conversation. People need to discuss a Task among themselves without the Agent reading along, share screenshots, logs and specs, fix or remove what they wrote, and know at a glance whether the Agent has actually received each instruction. When an Agent finishes a Turn or gets stuck, the people involved need to hear about it even when the app is closed, without being alerted for every streamed fragment, and they need to see which Tasks have something new to read.

## Solution

Every Task has a conversation of Comments in Markdown, written by Users, Agents and the system, shown live to everyone on the Timeline. Users can post a Comment or an Internal Note, attach up to 10 files of up to 25 MB, edit their own Comments and delete them (Admins can delete any Comment). Each User Comment shows whether it is queued, delivered or not delivered to the Agent, with the reason. When Users edit a Task after the Agent last read it, Notify agent sends the Agent a diff of the changes. Users follow Tasks automatically when they create them, are assigned to them or take part in the conversation, and can follow, unfollow and mute explicitly. The server keeps a per-User read position for unread indicators and sends phone alerts to followers for completed Turns, failed Turns and Jobs that need intervention.

## User Stories

1. As a Member, I want to post Markdown Comments on a Task, so that I can discuss it and instruct its Agent.
2. As a Member, I want code blocks, lists and links rendered in Comments, so that instructions stay readable.
3. As a Member, I want to mark a Comment as an Internal Note before posting, so that teammates can talk without the Agent receiving it.
4. As a Member, I want Internal Notes to look clearly different (dashed box, lock, "Internal chat" label), so that I always know what the Agent saw.
5. As a Member, I want the composer itself to change style and tell me "only people see this, never the agent" while in internal mode, so that I never send a note to the Agent by mistake.
6. As a Member, I want the internal flag fixed once posted, so that a note never becomes deliverable after the fact and a delivered Comment never pretends to be private.
7. As a Member, I want to edit my own Comments, so that I can fix mistakes.
8. As a Member, I want edited Comments marked "edited", so that readers know the text changed.
9. As a Member, I want an edit to a still-queued Comment to reach the Agent in its edited form, so that I can correct an instruction before the Agent reads it.
10. As a Member, I want to delete my own Comments after a confirmation, so that I can remove mistakes.
11. As an Admin, I want to delete any Comment, Agent and System Comments included, so that I can moderate the conversation.
12. As a reader, I want a deleted Comment to leave a "deleted a comment" tombstone with its author and time, so that the Timeline stays coherent.
13. As a Member, I want deleting a queued Comment to withdraw it from the Agent's pending Message, and to drop the Queue Entry when nothing is left to deliver, so that no Job starts for nothing.
14. As a Member, I want new, edited and deleted Comments to appear live for everyone viewing the Task, so that the conversation feels like a chat.
15. As a Member, I want each card's Comment count to update live, so that the Board shows where discussion happens.
16. As a Member, I want to attach files by drag and drop, paste or a picker, so that I can share screenshots, logs and specs.
17. As a Member, I want to post a Comment made only of attachments, so that a screenshot can speak for itself.
18. As a Member, I want image attachments previewed inline, so that I don't have to download them.
19. As a Member, I want other files offered as downloads under their original names, so that I can open them locally.
20. As a Member, I want a clear error when a file exceeds 25 MB or a Comment carries more than 10 files, before anything is posted, so that I can fix the upload.
21. As an operator, I want uploaded file names stripped of directories and control characters, so that no upload can escape the Agent's attachments folder.
22. As an operator, I want SVG and other active formats always served as downloads with a sandboxing policy, so that uploads never run scripts in the app.
23. As an operator, I want attachment downloads to require a signed-in User, so that files stay inside the team.
24. As a Member, I want to insert images and files in a Task description, so that the brief carries screenshots and specs, and I want them to reach the Agent too.
25. As an operator, I want description uploads that the description no longer links to be cleaned up after a grace period, so that abandoned uploads don't pile up.
26. As a Member, I want my Comment to reach the Agent immediately when it is working on this Task, so that I can steer it mid-Turn.
27. As a Member, I want my Comment queued when the Agent is busy elsewhere and delivered when it is free, so that nothing is lost.
28. As a Member, I want each Comment to show its delivery state (queued, delivered, not delivered with a reason on hover), so that I know whether the Agent saw it.
29. As a Member, I want Comments on a Task whose Agent was unassigned, whose Session is paused or which is closed to be marked not delivered with the reason, so that I don't wait for an answer that will never come.
30. As a Member, I want Comments of a Job that failed to start to go back to queued, waiting for Retry, so that a setup error doesn't lose my instructions.
31. As a Member, I want image attachments delivered to the Agent as images and other files saved in its Worktree, so that I can share screenshots and logs with it.
32. As a Member, I want Internal Notes and their files never to reach the Agent, not in Messages, not in its Task Tools and not through the Runner, so that private discussion stays private.
33. As a Member, I want a banner when Users edited the Task's title, description, priority or Tags after the Agent last read it, so that I know the Agent works on stale information.
34. As a Member, I want a one-click Notify agent that sends the Agent a field-by-field diff of those changes, so that I don't have to retype them.
35. As a Member, I want a visible System Comment saying who notified the Agent, with its own delivery badge, so that everyone sees the Agent was told.
36. As a Member, I want the banner to disappear once the notice is delivered, so that it reflects what the Agent knows.
37. As a Member, I want to see who wrote each Comment and whether it is a person, an Agent or the system, so that I can read the Timeline at a glance.
38. As a Member, I want to keep an unsent draft per Task while I move around the app, so that I don't lose what I was writing.
39. As a Member, I want text I type while a Comment is being sent to stay in the composer, so that I can keep writing.
40. As a phone user, I want to follow a Task automatically when I create it, am assigned to it, or post a Comment or Internal Note on it, so that I hear about the work I'm involved in.
41. As a phone user, I want to unfollow or mute a Task, and have that choice survive later participation, so that noisy Tasks stay quiet.
42. As a User with several devices, I want my follow and mute preferences shared across them, so that I set them once.
43. As a User, I want my preferences and read positions private, so that others don't see what I follow or read.
44. As a phone user, I want unread indicators per Task based on what I actually read, shared across my devices, so that I know where something new happened.
45. As a phone user, I want receiving data in the background to leave my read position alone, so that a Task stays unread until I look at it.
46. As a phone user, I want a phone alert when a Turn completes, when a Turn fails, and when a Job needs intervention, on Tasks I follow, so that I can react without watching the app.
47. As a phone user, I want at most one alert per event and device, never repeated by retries, so that I'm not spammed.
48. As a phone user, I want no alerts for streaming fragments or for the Agent's prose, so that alerts mean something happened.
49. As a phone user, I want lock-screen alerts that reveal no Task content, so that sensitive work stays private.
50. As a phone user, I want tapping an alert to open the Task's conversation after signing in, so that I land where the update is.
51. As an Admin, I want deactivated Users, Users with expired Logins and Users who muted or unfollowed in the meantime to receive nothing, so that alerts respect the current state.

## Implementation Decisions

- **Comments module** owns Comments and Attachments: create (JSON or multipart), edit, soft delete, upload for the description editor, download, and the merged Timeline read with cursor pagination (newest first, 1 to 200 entries, 50 by default).
- **Comment** shape: Task, kind (`user`, `agent`, `system`), author Actor, Markdown body (up to 100,000 characters), internal flag, edited at, deleted at, attachments, and a Delivery (state, reason, Job) that is empty for Internal Notes, Agent and System Comments and Comments on a Task that never had an Agent Session.
- A Comment needs a non-blank body or at least one Attachment. Editing requires non-blank text; the edit body accepts only the text, so the internal flag cannot be sent. Unchanged edits are no-ops.
- Edit: author of a User Comment only. Delete: author of a User Comment, or any Admin for any Comment. Deletion clears the body, deletes the Attachment records and, after commit, their blobs.
- **Delivery** is decided by the Session lifecycle (see [Agent sessions](../specs/agent-sessions.md)): injected into the running Job, queued into the Task's Queue Entry, or not delivered with a reason (`no agent assigned`, `task closed`, `agent unassigned`, `removed from queue`, `comment deleted`). Deleting a queued Comment drops its Queue Entry when it has no live Comments left, unless it resumes an interrupted Turn.
- **Notify agent** posts a System Comment carrying a hidden notice (the change list) and the Task version it covers, and delivers it like a Comment. It requires an assigned Agent, an idle or running Session and at least one unseen change by a User to title, description, priority or Tags; otherwise it answers 409.
- **Attachments**: 25 MB per file and 10 files per Comment (413 with `file_too_large` or `too_many_files`), 100 description files per Task (400). Names are cleaned (directories, control characters, 255 characters, dot-only names become `file`). PNG, JPEG, GIF, WebP and AVIF render inline; everything else downloads as `application/octet-stream`. Every download sends `nosniff`, a sandboxing CSP and a one-hour private cache. Description files are Task Attachments linked by URL; unlinked ones older than 24 hours are pruned on the next description upload, under the Task's lock.
- **Blob store** interface (put a stream with name and type, get, delete), implemented on the filesystem in the data directory with a JSON sidecar per blob.
- **Notifications module**: Task Preferences (following, muted, explicit follow, read position), read-position updates, push device registration. Automatic following is applied on Task creation (creator), User assignment (new assignees) and User Comments (author), and never overrides an explicit follow choice or a mute.
- **Timeline positions** are assigned by the database when a Comment, Revision or Agent item is inserted, serialized per Task so positions follow commit order. Read positions advance only through an explicit request naming an entry of the same Task, and only forward. Unread means latest position above read position. Timeline pages carry each entry's position.
- **Notification Events** are written by database triggers in the same transaction as the Turn insert (`turn.completed` or `turn.failed`) or the Job turning `failed` without an error Turn (`session.intervention`), keyed by Turn or Job. Deliveries are planned per following, unmuted, active User and registered phone with a valid Login, rechecked at send time, dropped after 24 hours, and claimed before sending.
- **Real-time**: Comment events on the Task topic, card updates on the Project topic, preference changes on the User's private topic (other Users' private topics are refused).
- Web composer: Enter sends, Shift+Enter adds a line, files by drop, paste or picker, client-side size and count checks, drafts kept per Task in memory until reload or logout, Internal chat switch with distinct styling.

## Testing Decisions

- Seam 1, backend public API against real Postgres with the fake Runner and fake push transport:
  - Comments: posting, Internal Notes flag, empty Comments, missing Task, card counts, editing rules, fixed internal flag, soft deletion, Admin deletion, attachments inline and as downloads, SVG as download, authentication for downloads, 25 MB and 10-file limits, deleted Comment attachments, filename cleaning (`backend/test/comments.test.ts`).
  - Delivery: injection into the running Job, Internal Notes never delivered, queued and merged delivery, Comments after a Turn's result, not delivered on unassignment, Task closing, Queue Entry removal and deletion of the only queued Comment, Notify agent diff and banner, Runner downloads of public Comment files and refusal of Internal Note files, description file pruning and removal with the Task (`backend/test/sessions.test.ts`).
  - Task Tools returning only non-internal Comments and clearing Unseen Changes (`backend/test/mcp.test.ts`).
  - Live Comment, edit, deletion and card count events (`backend/test/realtime.test.ts`), Timeline interleaving (`backend/test/tasks.test.ts`).
  - Following, muting, read positions, private preference events, push selection, deduplication, rechecks before dispatch, device ownership and token rotation, invalid tokens and retries (`backend/test/mobile.test.ts`).
- Frontend Playwright suite: Comment and Internal Note seen live in another browser and image upload with inline preview (`frontend/e2e/board.spec.ts`), delivery badges and Notify agent (`frontend/e2e/agents.spec.ts`), drafts per Task, text typed while sending, and edits of older Comments (`frontend/e2e/concurrency.spec.ts`).
- Flutter tests: Internal Notes keep their flag when posted manually (`mobile-app/test/controller_test.dart`), composer sending and long Comment clamping (`mobile-app/test/widget_test.dart`).

## Acceptance Criteria

- [x] Comments render Markdown; Internal Notes are visually distinct and flagged in the API.
- [x] An empty Comment answers 400; a Comment on a missing Task answers 404.
- [x] Only the author edits a User Comment, Admins included; the internal flag cannot change.
- [x] Authors delete their own Comments and Admins delete any Comment; deleted Comments stay as tombstones without body or attachments.
- [x] Image attachments preview inline; files over 25 MB and more than 10 files are rejected with 413 and create no Comment.
- [x] SVG is never rendered inline; downloads require a signed-in User; attachments of deleted Comments answer 404.
- [x] Description files reach the Agent, are pruned when unlinked for 24 hours, and are removed with the Task.
- [x] A Comment posted while the Agent works on that Task is delivered immediately.
- [x] Comments on another Task of a busy Agent are queued and later delivered together in one Message with authors and times.
- [x] Internal Notes are never delivered, never returned by Task Tools, and their files are never served to the Runner.
- [x] Unassigning, closing and removing a Queue Entry mark queued Comments not delivered with the reason.
- [x] After a human edits the description, the banner appears; Notify agent delivers a diff, and the banner disappears once delivered.
- [x] Creators, User assignees and participants (Internal Notes included) follow automatically; explicit unfollow and mute survive later participation.
- [x] Read positions advance only for persisted entries of the same Task, only forward, never on reads, and never make the User follow.
- [x] Preference changes reach only the User's own connections.
- [x] One alert per completed Turn and device; none for fragments or prose; mute, unfollow, deactivation and expired Logins are rechecked before dispatch.
- [x] Devices are removed on logout, bound to their User, and invalid tokens are discarded; transport failures are retried durably.
- [ ] Phone push verified end to end on a real device with production push credentials.

## Out of Scope

- @mentions, Comment reactions and threaded replies.
- Email and in-app inbox notifications; desktop notifications while the app is closed.
- Read positions and unread indicators in the web app.
- Moving attachments to object storage.

## Further Notes

- The conversation channel was built across the core board, agents runtime and Flutter app work, with mid-turn delivery as decided in [Agent sessions](../specs/agent-sessions.md).
- The web app labels Internal Notes "Internal chat" in the UI; the domain term stays Internal Note.
- Agent Comments and System Comments come from the Timeline projection, covered by the agent sessions work.
