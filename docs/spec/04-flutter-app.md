---
status: in-progress
---

# Spec 04 — Flutter conversation frontend

Design date: 2026-10-26. Implementation started on 2026-10-26.

## Intent

Add a Flutter frontend in `mobile-app/`, alongside the existing React frontend,
using the same backend, Users, Projects, Tasks and Agent Sessions. The main
experience resembles Discord: Projects are the navigation equivalent of servers,
and Tasks are the equivalent of channels. These are presentation metaphors;
the existing domain terminology and execution rules remain authoritative.

## Decisions agreed during the interview

- Target iOS, Android, macOS, Windows and Linux. Prepare all five platform
  projects; perform initial native verification on the available macOS host.
- Provide Task management, Agent assignment and complete Task conversations.
  Infrastructure configuration and Credential administration remain on the web.
- Group a Project's Tasks by Status, like Discord channel categories.
- Allow optional Agent selection when creating a Task. With an Agent selected,
  label the action **Create and assign**; otherwise create a Task without an
  Agent. Assignment doesn't start the Agent: its first Job starts on the first
  User Comment.
- Include phone push notifications in the first version, including when the app
  is closed. Notify for completed Agent responses, errors and requests for
  intervention, rather than streaming fragments.
- Notify only Users following the Task. Automatically follow a Task when a User
  creates it, is assigned to it or participates in its conversation. Allow Users
  to follow, unfollow and mute a Task.
- Support reading already loaded conversations offline and saving drafts.
  Sending remains a manual action after connectivity returns; do not enqueue
  offline Comments for automatic submission.

## Proposed defaults for implementation

These fill gaps in the interview and are proposals, rather than independently
approved requirements.

### Navigation and presentation

- Wide windows show a Project rail, a Task list grouped by Status and the
  selected Task's conversation. A details panel exposes description, Status,
  priority, Tags, User assignees, Agent and Git links.
- Narrow windows use successive Project, Task list and conversation screens,
  with Task details opened on demand. Tablet and resized desktop layouts adapt
  to available width.
- Start with a dark theme consistent with the existing frontend. Retain Task
  Keys and titles in channel entries. Closed-category Tasks are available through
  an explicit archive toggle; done and closed keep their existing meanings.
- Show human and Agent Comments, Revisions and System Comments chronologically.
  Render Markdown and code, attachment previews and delivery state. Thinking and
  Activity are expandable and collapsed initially, as in the existing domain.
- Keep the composer visible. Internal Notes have a persistent, clear indicator
  and are never delivered to the Agent. Preserve the draft when navigating away.
- Follow streaming output when the reader is at the bottom; preserve their
  position while they read older items. Offer a jump to latest when appropriate.
- Provide Task search and filters, edit/delete own Comments under current API
  rules, Task field editing, Agent assignment, Interrupt, Retry and Notify agent.
  Show Branch and Pull Request links using existing API data.

### Connection and local state

- Let the User enter the installation URL at login. Initially support one active
  installation and User per app profile; switching installation requires logout.
- Reuse email/password login, forced password change, expiry and logout behavior.
  Store native login material using platform secure storage and authenticate both
  HTTP and WebSocket connections. No password is retained.
- Cache fetched Projects, Tasks and persisted Timeline entries, plus drafts by
  Task. Do not persist transient stream fragments as completed Agent Comments.
  Isolate stored data by installation and User and clear it on logout.
- Make offline, reconnecting, expired-login and failed-send states visible.
  Preserve drafts on failed requests. On reconnect, subscribe and refetch open
  views using the existing WebSocket contract.
- Do not retry an ambiguous Comment submission automatically. Give the User a
  way to reconcile the refreshed conversation before manually trying again.
- When offline, cached text remains readable; only downloaded attachments can be
  opened. Attaching a local file to a draft does not imply it has been uploaded.

### Following, unread state and notifications

- Persist following and mute preferences in the backend per User and Task, so
  phone and desktop installations share the same preferences. An explicit
  unfollow or mute choice takes precedence over later automatic-follow triggers.
- Participation means posting a human Comment or Internal Note. Assignment here
  means User assignment, distinct from Agent assignment.
- Propose per-User read positions and unread indicators shared across Flutter
  devices. Reading advances only while the conversation is visible and the
  relevant content is reached. Do not mark a Task read merely by receiving data.
- Generate notification events from persisted Turn completion, failure and
  actionable Session lifecycle events. Do not infer intervention requests by
  inspecting generated prose or push every Agent Comment during a Turn.
- Store notification work durably after the underlying transaction. Deduplicate
  by event, User and device; retries must not repeatedly alert for the same Turn.
- Register authenticated phone device tokens, handle token changes, remove
  registrations on logout and discard invalid tokens. Follow/mute changes and
  User deactivation apply before dispatch.
- Use minimal lock-screen notification content and a Task identifier for opening
  the relevant conversation after authentication. If permission is declined,
  Task conversations and unread indicators continue to function.
- Phone push support requires deployment credentials and native application
  identifiers. Document configuration and provide an honest unconfigured state;
  a scaffold or fake notification sender does not count as working phone push.
- Desktop notifications while the application is fully exited are outside the
  agreed phone-push requirement. Desktop retains live updates and unread state
  while running, and refetches on return.

## Backend and contract work

The current backend already provides Task CRUD, Comments and attachments,
Timeline pagination, Agent Session controls, cookie authentication and WebSocket
subscriptions. It does not currently provide following, human read positions,
device registrations or push delivery. These are new backend features in this
spec; notification exclusions in Spec 01 apply to that earlier delivery only.

Add migrations, authenticated API operations and shared TypeScript contracts for
following/mute preferences, read positions and device registrations. Expose
preference/read changes to a User's other connected app instances without
broadcasting their private preferences to other Users. Implement the matching
Dart models against the public API; the Flutter app cannot directly import the
shared TypeScript package.

Task creation currently does not accept Agent assignment. Implement **Create
and start** as Task creation followed by an explicit versioned assignment. If
assignment fails, retain the created Task, open it and offer assignment retry;
never create a duplicate Task to retry the operation.

Reuse the existing scheduler and lifecycle as the authority for execution.
Preserve one Job at a time per Agent, current Queue behavior, closed-category
Session behavior, optimistic concurrency and the Internal Note delivery rule.

## Scope boundaries

The React frontend remains available. No Flutter browser target, Kanban view,
voice channels, direct messages, multiple concurrent installations/accounts,
offline Task mutations or automatic offline sends are required by this version.
Agent/Credential administration, container builds, Git Connection setup and
project secrets stay in the existing web administration interface. Reading a
Task in React need not update the new Flutter read position in this version.

## Verification and delivery

- Backend API tests against real Postgres cover access control, following/mute
  overrides, read-position monotonicity, device lifecycle and notification
  selection/deduplication using a fake push transport.
- Flutter tests cover meaningful user flows: login and expiry, Project/Task
  navigation at narrow and wide widths, optional Agent assignment with partial
  failure, streaming and pagination, Internal Notes, offline drafts and failed
  sends, and opening a Task from a notification.
- Run Flutter analysis and tests, the relevant existing backend tests and
  monorepo type checks. Build/run macOS when host tooling permits. Report which
  other targets are scaffolded versus actually built and exercised.
- Provide development commands, backend URL setup, phone push configuration and
  native signing/build prerequisites in `mobile-app/README.md`. Real phone push
  verification requires configured credentials and a suitable device; document
  any remaining external setup precisely.
- Preserve unrelated working-tree changes already present in the repository.
