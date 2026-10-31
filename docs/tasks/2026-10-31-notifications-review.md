---
status: in-progress
---

# Notifications review: chat-style Alerts and read feedback

## Specs

- [Conversation](../specs/conversation.md) (Notification Events, Alert content, unread Comment count)
- [Agent sessions](../specs/agent-sessions.md) (the `handled` Delivery state)
- [Wikis](../specs/wikis.md) (Delivery ticks in Chats)
- [Clients](../specs/clients.md) (phone Alerts, foreground behaviour, Android icon, card and Project indicators, Delivery ticks)
- [Schedules](../specs/schedules.md) (Schedule Alert texts)

## Problem Statement

Phone Alerts say nothing useful. Every Agent outcome reads "Claude Task / A Task you follow has an update.", so a finished Turn, a failed Turn and a blocked Job look the same, and the User can't tell which Task it is about without opening the app. Several Alerts for one Task replace each other instead of piling up like a chat. While the app is open, every Alert is silenced, even when the User is somewhere else in the app. On Android the small icon is a cramped, edge-to-edge silhouette of the whole logo, tinted orange.

Read feedback is also hard to read. A Task card with unread Comments shows the total Comment count in orange, so the User can't see how many are new without hovering. A User Comment's Delivery is a word ("delivered") that never says whether the Agent actually worked on it. The Projects list and the sidebar's unread badges lag up to 15 seconds behind.

## Solution

Alerts become chat notifications, like WhatsApp:

- the title names the Task (`API-42 · Fix login redirect`, or `Wiki · Chat` for a Wiki), and the body says who it is from and what happened, with an excerpt of the Agent's last Comment, the error, or the mentioning Comment;
- on Android, the Alerts of one Task stack into one conversation notification with the sender's initials as avatar, and several Tasks group under the app; on iOS, each Alert is its own notification, stacked per Task;
- with the app open, the Alert appears unless the User is looking at that very conversation;
- the content shows on the lock screen too, as WhatsApp does; the phone's own settings can hide it;
- the Android small icon becomes a solid speech bubble with the spark cut out of it, with no accent colour.

Read feedback:

- a Task card (web Board and native Task list) with unread Comments shows the orange glowing Comment icon with the **number of unread Comments**; without unread Comments it shows the grey icon with the total, as today. The native row's unread dot goes away; the bold title stays;
- the Projects list and the sidebar's unread and running indicators update live;
- the Delivery of a User Comment shows as ticks: a clock while queued, one grey tick once delivered, two indigo ticks once **handled** (the Turn that received it has ended), a warning sign when not delivered.

## User Stories

1. As a User following a Task, I want an Alert to name the Task by key and title, so that I know which Task it is about without opening the app.
2. As a User following a Task, I want an Alert for a completed Turn to show the Agent's name and the beginning of its last Comment, so that I can tell from the notification whether the Agent is done or needs me.
3. As a User following a Task, I want a completed Turn without any Agent Comment to say "Opus finished its turn.", so that the Alert is never empty.
4. As a User following a Task, I want a failed Turn to say "Opus: turn failed: " followed by the error, so that I can tell a failure from a reply at a glance.
5. As a User following a Task, I want a failed Job to say "Opus needs your attention: " followed by the reason, so that I know I have to step in.
6. As a mentioned User, I want the Alert to show who mentioned me and the beginning of their Comment, so that I can decide whether to answer now.
7. As a User, I want Markdown stripped from excerpts and the text cut at about 200 characters, so that the notification reads like a chat message.
8. As a User, I want a Comment that only carries files to read "📎 2 files", so that I know something was attached without seeing file contents.
9. As a User, I want an Alert for a Wiki's Chat to be titled with the Wiki's name and the Chat's title, so that I know which conversation it is.
10. As the creator of a Schedule, I want its failure Alerts to name the Schedule, so that I know which one to fix.
11. As a User on Android, I want several Alerts of one Task to stack into one conversation notification with one line per event, so that I can read what happened in order.
12. As a User on Android, I want the conversation notification to show the sender's initials on a coloured circle, so that Agent and people are easy to tell apart.
13. As a User on Android, I want the notifications of several Tasks grouped under Claude Task, so that the shade stays tidy.
14. As a User on iOS, I want each Alert as its own notification stacked with the other Alerts of the same Task, so that I see every event.
15. As a User with the app open on another screen, I want Alerts to appear with their sound, so that I don't miss what happens elsewhere.
16. As a User reading a conversation in the app, I want no Alert for that Task, so that I'm not interrupted by what I'm already watching.
17. As a User, I want opening a Task in the app to remove that Task's notifications from my phone, so that the shade only holds what I haven't seen.
18. As a User, I want the Alert content visible on the lock screen by default, so that it works like my chat apps; I can hide it with the phone's settings.
19. As a User on Android, I want a clean, legible small icon in the status bar without an orange tint, so that Claude Task looks like a well-made app.
20. As a User looking at the Board, I want a card's orange Comment badge to show how many Comments I haven't read, so that I see at once how much is new.
21. As a User looking at the Board, I want cards without unread Comments to show the grey icon with the total, so that the Comment count is still there.
22. As a User of the native app, I want Task rows to use the same unread Comment badge, without the extra dot, so that both clients read the same way.
23. As a User, I want the Projects list and the sidebar badges to update as soon as something happens, so that I don't wait for a refresh.
24. As a User, I want reading a Task to clear its Project's unread badge right away, so that the badge matches what I've read.
25. As a User who wrote a Comment, I want a clock while it waits in the Queue, so that I know the Agent hasn't received it yet.
26. As a User who wrote a Comment, I want one grey tick once the Agent received it, so that I know it reached the Agent.
27. As a User who wrote a Comment, I want two indigo ticks once the Turn that received it has ended, so that I know the Agent has worked on it.
28. As a User who wrote a Comment, I want a warning sign with the reason when it couldn't be delivered, so that I can fix it.
29. As a User, I want the tick's tooltip and accessible label to say the state, the Agent and the time, so that the icons stay understandable and accessible.
30. As a User, I want the ticks to change live, so that I see the Agent pick up and finish my message.

## Implementation Decisions

### Alert content (backend)

- The push dispatcher builds the content at dispatch time from the current state of the Task, the Agent, the User and the Comment, so the newest title is used and a Comment deleted in the meantime falls back to the text without excerpt.
- Title: `<Task Key> · <Task title>`; for a Wiki's Chat, `<Wiki name> · <Chat title>` (the title the Chat list shows). The Schedule-blocked Alert, which has no Task, is titled with the Schedule's name.
- Body, by kind:

  | Kind | Sender | Text |
  | --- | --- | --- |
  | `turn.completed` | Agent name | Excerpt of the Turn's last Agent Comment, or "finished its turn." when the Turn wrote none (shown as "Opus finished its turn.") |
  | `turn.failed` | Agent name | "turn failed: " + excerpt of the System Comment reporting the error, or "turn failed" alone |
  | `session.intervention` | Agent name | "needs your attention: " + excerpt of the System Comment reporting the failure, or "needs your attention" alone |
  | `comment.mentioned` | Comment author | Excerpt of the mentioning Comment |
  | `schedule.run_failed` | — | `Schedule "<name>": run failed` |
  | `schedule.blocked` | — | `Schedule "<name>": keeps being skipped` |

- The Notification Event records the Comment it previews. For Turn events, that is the last Agent Comment the Job produced within that Turn (for a failed Turn, the System Comment its `result` produced, falling back to the last Agent Comment), recorded in the same transaction as the Turn. For a failed Job, the System Comment that reports the failure. For a mention, the mentioning Comment. Schema: `notification_events` gains a nullable `comment_id` (no cascade: a missing or deleted Comment just drops the excerpt).
- Excerpt: Markdown rendered to plain text (emphasis, headings, links reduced to their text, code blocks and images dropped, mentions shown as `@Name`), whitespace collapsed, cut at 200 characters on a word boundary with "…". A Comment with Attachments appends "📎 N files" ("📎 1 file"); a Comment with only Attachments shows just that. Attachment names and contents are never included. The excerpt builder is a pure function, shared by every kind.
- The Agent's generated text now reaches the phone: this replaces the recorded decision "Lock-screen alerts reveal no Task content". Content is visible on the lock screen (Android visibility `public`); the phone's own settings can hide it.

### Push payload (backend → phone)

- `PushMessage` gains `title`, `sender` (name or null), `senderKind` (`agent`, `user` or null), `text`, and `taskKey`.
- Android: **data-only** high-priority message carrying `taskId`, `eventId`, `kind`, `title`, `sender`, `senderKind`, `text`. No `collapseKey`, so an offline phone receives every event. The app renders the notification.
- iOS: APNs alert with `title` and body `"<sender>: <text>"` (or `text` alone), `thread-id` = Task id (or the Schedule id for a blocked Schedule), sound default, and the same data fields. No `apns-collapse-id`, so Alerts stack instead of replacing each other.
- The recipients, eligibility rechecks, 24-hour expiry, closed-Status suppression, retries and the 2-second dispatch interval are unchanged. No delay and no unread check before sending.

### Native app

- Add `flutter_local_notifications` for rendering and removal.
- Android: the background message handler and the foreground handler both render the Alert as a `MessagingStyle` notification, one per Task (notification id and tag from the Task id), titled with `title`. Each event adds a message (sender as a `Person` whose icon is the initials on the colour the app uses for that name), keeping the last 5. The lines of each Task are kept in a small file in the app's support directory so a new event, in any isolate, rebuilds the conversation. Notifications share the group `claude-task` with a summary notification "Claude Task". Channel "Task updates" with default importance and sound. Lock-screen visibility public.
- iOS: background Alerts are shown by the system. In the foreground, the app shows the Alert itself as a local notification with the same title, body and thread identifier, unless suppressed.
- Foreground suppression: an Alert is not shown when its Task's conversation is the open, visible screen of the foreground app (the same condition that advances the read position, without the scroll-to-bottom part). Otherwise it is shown with sound. `setForegroundNotificationPresentationOptions` stays all off so iOS never shows the remote copy twice.
- Opening a Task's conversation removes its notifications from that phone and clears its stored lines (Android: cancel by id; iOS: remove the delivered notifications with that thread identifier, through a small platform channel if the plugin can't). Swiping a notification away also clears its stored lines. No silent "read" pushes: notifications otherwise stay until dismissed.
- Tapping a notification opens the Task as today (and the Wiki's Chat for a Wiki).
- Android small icon: a vector drawable of design A (solid speech bubble, tail bottom-left, with the eight-armed spark cut out of it), within Android's 24 dp grid with standard padding. The `default_notification_color` metadata and the `notification_accent` colour are removed, so the system's neutral colour applies; the locally rendered notifications use the same icon and no colour. The PNG `ic_notification` files are deleted. The SVG drawn during the design discussion is the source (24×24 viewBox: bubble from (2,3) to (22,17.5), radius 5, tail to (5.5,20.8); spark centred at (12,10.25), arms 8.8 long and 2.1 wide with round caps).

### Delivery `handled`

- `DELIVERY_STATES` gains `handled` (Postgres enum value added in a migration). A `delivered` Comment becomes `handled` when a Turn of its Task's current Session ends after its delivery, whether completed, failed or stopped: in the same transaction as the Turn, every `delivered` Comment of that Session's Task moves to `handled`. `handled` is final; nothing moves back from it.
- Comments gain `delivery_changed_at`, set whenever the Delivery state changes (including the initial state). `Delivery` in the shared types gains `at` (ISO time) next to `state`, `reason` and `jobId`.
- Moving to `handled` publishes a Comment updated event on the Task topic, so the ticks change live.
- Everything that reads Delivery today (`delivered` checks in the Session lifecycle, recovery, Queue) treats `handled` as already delivered; recovery never re-queues a `handled` Comment.

### Delivery ticks (web and native)

| State | Icon | Tooltip / accessible label |
| --- | --- | --- |
| `queued` | clock, muted | "Queued · 12:40" |
| `delivered` | one tick, muted grey | "Delivered to Opus · 12:41" |
| `handled` | two ticks, indigo (`--primary`) | "Handled by Opus · 12:43" |
| `not_delivered` | warning sign, amber | "Not delivered: task closed" |

The ticks replace the text badge in the Comment header on both clients. The Agent's name comes from the delivering Job's Agent (the Task's Agent when unknown).

### Card and row indicators

- Web Board card and native Task row: when `unreadComments > 0`, the orange glowing Comment icon is followed by `unreadComments` instead of the total; tooltip and accessible label "N unread comments of M". Otherwise the grey icon and the total, as today. The card still hides the indicator when the Task has no Comments.
- Native rows lose the unread dot; the bold title stays as the signal for unread activity without new Comments.
- The Chat Dock's dot and halo and the Wiki Chat list's unread indicator stay as they are.

### Live Project activity

- New global topic `projects` with the event `project.activity` `{ projectId }`, published after commit when a Project's unread or running indicators may have changed: a Timeline entry stored or a Comment deleted on one of its Tasks, a Task created, deleted or moved into or out of a `closed` Status, or a Session of the Project changing state. The backend coalesces these to at most one event per Project per second. Wiki and Schedule Projects publish nothing.
- The web app subscribes to `projects` and refetches the Projects list (shared by the Projects page and the sidebar) on `project.activity`, and also on the User's own `task.preference` events, debounced by 250 ms. The 15-second polling is removed; reconnection refetches the list.
- The native app subscribes to `projects` and refetches its Project list the same way.

## Testing Decisions

- **Backend public API** (most of the tests, in the existing mobile and Schedule notification suites, with the fake push transport and the fake runner):
  - completed Turn with Agent text: the recorded push carries title `KEY-n · title`, sender the Agent's name, `senderKind: agent`, and the excerpt of the last Agent Comment of that Turn, not of an earlier Turn of the same Job;
  - completed Turn without Agent text: "finished its turn.";
  - failed Turn: "turn failed: " with the System Comment's detail; failed Job at setup: "needs your attention: " with the stage;
  - mention: the author and the excerpt, Markdown stripped, mentions as `@Name`; Attachment-only Comment: "📎 2 files";
  - Wiki Chat title, Schedule titles and texts;
  - a Task renamed and a Comment deleted between recording and dispatch: new title, no excerpt;
  - the excerpt function gets table-driven unit tests (Markdown, code blocks, links, images, length cut, whitespace, attachments);
  - Delivery: a Comment written mid-Turn and a queued Comment both become `handled` with `at` when the Turn ends, also for a failed or stopped Turn, with a Comment updated event on the Task topic; `delivered` stays `delivered` until then; recovery leaves `handled` Comments alone;
  - `project.activity`: published on the `projects` topic for a new Comment, a closed Status and a Session state change, coalesced within a second, never for Wiki or Schedule Projects.
- **Transport**: a unit test of the FCM message built for Android (data only, no collapse key) and iOS (alert, thread id, no collapse id), with the Firebase messaging client faked.
- **Native app** (Flutter unit and widget tests, as in the existing `test/` suite): the pure model that turns push data plus stored lines into the notification to show (accumulation up to 5, per-Task id, group), the foreground-suppression decision, clearing on opening a Task, the Task row badge (unread count vs total, no dot) and the Delivery ticks with labels.
- **Web** (Playwright, next to the Board and sidebar specs): the card shows the unread count and goes back to the total after reading; the sidebar badge updates without waiting for polling; the ticks of a User Comment go from one tick to two after the fake runner ends the Turn.

## Acceptance Criteria

- [ ] Every Alert kind carries the title, sender and text described above, built at dispatch time.
- [ ] Turn Alerts preview the last Agent Comment of that Turn; failed Turns and Jobs preview the System Comment's detail.
- [ ] Excerpts are plain text, at most about 200 characters, and never include file names or contents.
- [ ] Android receives data-only messages without collapse key; iOS receives alerts with the Task's thread id and no collapse id.
- [ ] On Android, Alerts of one Task stack in one conversation notification (last 5 events) with initials avatars, grouped under Claude Task.
- [ ] On iOS, Alerts stack per Task.
- [ ] With the app in the foreground, an Alert appears unless its Task's conversation is the visible screen.
- [ ] Opening a Task in the app removes its notifications from that phone.
- [ ] The Android small icon is the bubble-with-spark vector with no accent colour; the old PNGs and colour are gone.
- [ ] A delivered Comment becomes `handled` when a Turn of the Session ends after its delivery, live, and shows two indigo ticks on web and native; queued, delivered and not delivered show their icons with labelled tooltips.
- [ ] Cards and native rows show the unread Comment count in the orange badge, the total otherwise; native rows have no unread dot.
- [ ] The Projects list and sidebar indicators update live through the `projects` topic, without 15-second polling.
- [ ] Specs and `docs/CONTEXT.md` describe the new behaviour; the "Lock-screen alerts reveal no Task content" decision is replaced with its rationale.
- [ ] `pnpm typecheck`, `pnpm test`, the Playwright suite and the Flutter tests pass.

## Out of Scope

- Notifications on the web app and the desktop apps (browser or system notifications, in-app toasts).
- Any delay or unread check before sending an Alert.
- Removing notifications from a phone when the Task is read on another client (silent pushes).
- Real avatar images in Alerts: the background handler has no authenticated access to avatars, so Alerts use initials.
- A Notification Service Extension or communication notifications on iOS.
- Changes to who receives Alerts, follow and mute rules, the Chat Dock indicators and the Wiki Chat list.
- Per-Agent-Comment Alerts during a Turn: Alerts stay per Turn outcome.

## Further Notes

- Designed in the CLAT-29 discussion; the Android icon variants were compared in a rendered sheet and design A was chosen.
- The iOS foreground copy and the removal of delivered notifications by thread may need a few lines in `AppDelegate` if `flutter_local_notifications` doesn't cover them.
