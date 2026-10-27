# Clients

Users work with Claude Task through two clients that share one backend: the **web app**, a React single-page application served by the backend itself, and the **native app**, a Flutter application for phones and desktops. Both read and change data through the same HTTP API and keep themselves live through one WebSocket per client, on which the backend pushes events about everything the client is looking at. This spec covers what each client shows, how it navigates, how it stays consistent while many people and Agents change the same data at once, and how the real-time layer that feeds them behaves. The domain rules behind what the clients display (Tasks, Comments, Sessions, Wikis and so on) live in the sibling specs linked at the end.

## Concepts

- **Web app**: the full interface, used from a browser. It covers every area of the product, including administration (Users, Agents, Credentials, Extensions, Git Connections, Project settings).
- **Native app**: a conversation-first client for iOS, Android, macOS, Windows and Linux. It covers Projects, Tasks, their conversations, Agent assignment and Wikis, plus basic settings (Projects, Agents, and for Admins Users and Credentials); infrastructure configuration stays in the web app. Its layout borrows from chat apps: Projects play the role of servers and Tasks the role of channels, grouped by Status. These are presentation metaphors only; the domain terms stay authoritative.
- **Installation**: one deployment of Claude Task, identified by its origin URL (for example `https://tasks.example.com`). The web app always talks to the installation that served it; the native app asks for the installation URL at sign-in.
- **Live connection**: the single WebSocket a client keeps open to the backend while a User is signed in.
- **Topic**: a named stream of events a client subscribes to over its live connection: one Project's Board, one Task's Timeline, the Agents list, one Agent, the Wikis list, or the User's own private stream.
- **Event**: a notification pushed on a topic. It carries the new projection of what changed (the updated card, the new Comment, the whole Status list), so a client can apply it without a further request.
- **Live Turn preview**: the text, Thinking, API-retry status and Setup Script output of a running Turn, streamed as it is produced. It is transient: the stored Agent Comment, Thinking or Activity replaces it on the Timeline as soon as it is persisted (see [Agent sessions](agent-sessions.md)).
- **Draft**: an unsent Comment kept per Task, with its Internal Note flag and the files picked for it.
- **Following, mute and read position**: per-User, per-Task state, shared by both clients for unread indicators and by the native app for push notifications. Their data rules belong to [Conversation](conversation.md); this spec covers how the clients use them.
- **Conversation generation**: a counter on a Task's conversation that grows each time a Wiki's Reset Chat clears it. Clients use it to notice a reset they missed while disconnected.

## Behaviour

### Real-time layer

#### Connection and authentication

Each signed-in client opens one WebSocket to the API's real-time endpoint. The handshake is authenticated with the same Login cookie as HTTP requests: the browser sends it automatically, and the native app attaches the cookie it keeps in secure storage. A handshake without a valid Login is refused, which the clients treat as a possibly expired Login (see [Reconnection and resync](#reconnection-and-resync)).

The backend accepts a handshake whose `Origin` header, when present, matches the host being called, and refuses the others with `403`. This blocks cross-site WebSocket hijacking from other web pages; native clients send no `Origin` and pass.

#### Topics and subscriptions

A client subscribes and unsubscribes by sending small control messages listing topics. Every User can see every Project, so any well-formed topic is accepted, with one exception: a User's private topic is accepted only for that User's own id, and any other User topic in a request is silently dropped.

| Topic | One per | Carries |
| --- | --- | --- |
| Project (`project:<id>`) | Project | The Board: Task cards created, updated, moved and deleted; the Status list; the Tag list; Project details. |
| Task (`task:<id>`) | Task (including a Wiki's conversation) | The Task view: Task fields, removal, Comments, Revisions, Agent Timeline items, Session state, Live Turn preview, Setup Script output, conversation reset. |
| Agents (`agents`) | installation | Agent created, updated or deleted, for the Agents list and Agent pickers. |
| Agent (`agent:<id>`) | Agent | One Agent's detail view: the Agent itself, its Queue, builds and build logs, Jobs. |
| Wikis (`wikis`) | installation | A Wiki was created, changed, reset or deleted. |
| User (`user:<id>`) | User | Private changes to the User's own following, mute and read state. |

A subscribe request lists up to 100 topics; extra topics are ignored. The backend answers every subscribe with an acknowledgement listing the topics now being delivered. Events start flowing at that moment, so anything that changed between a client's HTTP fetch and its subscription would be missed; both clients close that gap by refetching once the acknowledgement arrives (the web app refetches the data each acknowledged topic keeps current; the native app moves to its "connected" state and refreshes its open views).

Control messages are limited to 64 KB; a larger message closes the connection with code `1009`. A message that isn't valid JSON, or has an unknown type, gets an error reply and the connection stays open.

#### Event catalogue

Events are grouped by the area that emits them. Each one carries the new state, so clients apply it directly.

| Area | Topic | Events | What the clients do with them |
| --- | --- | --- | --- |
| Board | Project | Task created, updated or moved (each with the Task card); Task deleted; Status list changed (whole list); Tag list changed (whole list); Project updated | Put the card in every cached Board list of that Project, or take it out; replace the Status or Tag list; refresh Project details and repository settings. A card update also reflects Session state and Queue position, since the scheduler emits one whenever they change. |
| Task view | Task | Task changed (full Task); Task removed; Comment created, updated or deleted; Revision created; Session changed (new Session state, or none) | Replace the Task (and refresh its Session for the "unseen changes" flag); show the Task as deleted; place the item on the Timeline; replace the Session. |
| Agent work | Task | Agent Timeline item created or updated (Thinking, Activity, Turn Summary, notices); Live Turn text or Thinking delta; Live Turn retry status (or cleared); Setup Script output chunk | Place stored items on the Timeline; append deltas to the Live Turn preview; show the retry line; show the Worktree preparation output. |
| Wiki conversation | Task | Conversation reset | Empty the Timeline and the Live Turn preview for everyone viewing it, then refetch. |
| Wikis | Wikis | Wiki changed | Refetch the Wikis list and that Wiki. |
| Agents | Agents and Agent | Agent updated (full Agent); Agent deleted | Update the Agents list and the Agent's detail view; drop a deleted Agent. |
| Agent detail | Agent | Queue changed (whole Queue); build updated; build log chunk; Job updated | Replace the Queue; update the build list and append log text; update the Job list, the Job's detail and usage figures. |
| Private | User | Task preference (following, mute, read and latest positions, unread) | Every client of that User updates unread and following indicators, whichever one moved the read position. |

Domain changes publish their events only after their database transaction commits, so a rolled-back change publishes nothing. Scheduler and Agent-management events (Session changes, Queue changes, builds, Jobs, Agent updates) are published as soon as the scheduler has written them.

#### Ordering and consistency

The backend writes events to each connection in the order it publishes them, but a client also receives HTTP responses, and the two race: a response fetched before a change can arrive after that change's event. Events from different code paths can also reach a client in a different order from the order things happened. Clients therefore never trust arrival order:

- Task data is guarded by the Task's version: a card or Task older than the one already cached is ignored.
- Timeline items are placed by their position in the server's order (creation time, then kind, then id), and an item already shown is replaced in place.
- The Session's state from an event wins over an HTTP snapshot already in flight.

The web app's detailed rules are in [Consistency under concurrent and out-of-order updates](#consistency-under-concurrent-and-out-of-order-updates); the native app's are in [Live updates](#live-updates).

#### Heartbeat, limits and backpressure

- The backend pings every connection every 30 seconds. A connection that hasn't answered the previous ping by the next one is terminated, so a dead client is dropped within about a minute.
- Before writing an event, the backend checks how much data is still queued for that connection. A connection with more than 16 MB waiting is terminated on the spot instead of receiving more. A browser tab that stops reading (asleep, frozen, on a stalled network) would otherwise make the backend hold every event for it, and Live Turn deltas can grow that to hundreds of megabytes. The client sees an ordinary disconnection, reconnects and refetches everything, so nothing is lost.
- Event messages from the backend can be large (a whole Status list, a whole Queue, a full Task with its description); the limit above applies to what the backend has queued, not to single messages.

#### Reconnection and resync

Events are notifications, not a log: a client catches up by refetching, not by replaying. After any disconnection, a client resubscribes and refetches what it shows.

```mermaid
sequenceDiagram
  participant C as Client
  participant B as Backend
  C->>B: Open WebSocket (Login cookie)
  B-->>C: Connected
  C->>B: Subscribe to every topic in use
  B-->>C: Subscribed (topics)
  C->>B: Refetch data behind those topics (HTTP)
  B-->>C: Events from now on
  Note over C,B: Connection lost (network, server restart, backlog over 16 MB, missed ping)
  C->>C: Clear Live Turn previews
  C->>C: Wait with exponential backoff
  C->>B: Reopen, resubscribe, refetch
```

- **Web app**: waits 0.5 s, then 1, 2, 4, 8, 16 s, and then 30 s between attempts, resetting after a successful connection. On every reopen after the first, it marks every cached query stale so open views refetch, and each subscribe acknowledgement triggers a refetch of that topic's data.
- **Native app**: waits 1, 2, 4, 8, 16 and then 32 s between attempts, resetting after a successful connection, with a 15-second timeout on each attempt. On reaching "connected" again it clears Live Turn previews, refreshes its global lists and the open Project and Task, and retries any pending logout (see [Sign-in, Login and profiles](#sign-in-login-and-profiles)). Coming back to the foreground also reconnects and refreshes.

#### When a Login ends

When a Login ends (logout, deactivation, password change or reset), the backend closes that Login's live connections with code `4001`. On `4001` the web app stops reconnecting and re-checks the Login, which sends the User to the sign-in page; the native app treats it as an expired Login and returns to sign-in. On any other close, the web app also re-checks the Login before reconnecting, so a Login that expired while the connection was down leads to sign-in rather than to endless reconnection attempts.

### Web app

#### Sign-in and routing

Everything except the sign-in page sits behind the Login check. The web app asks the backend who the current User is; the answer is cached for one minute.

- Without a Login, any page redirects to sign-in, remembering the requested page; after signing in the User lands there (or on the Projects list). Only same-site paths are honoured as a return target.
- A User with a temporary password is sent to "Choose your password" and can reach nothing else until it is changed. The voluntary "Change password" form asks for the current password and the new one twice (at least 8 characters), and tells the User that their other Logins were logged out.
- When the backend can't be reached, the app shows "Can't reach the server" with the error instead of redirecting.
- Any request answered with `401` triggers a new Login check, so a Login ending anywhere leads back to sign-in.
- Signing in and logging out both clear every cached query and every Draft, since another User may sign in next in the same browser. Logging out also closes the live connection.

The live connection starts once the User is signed in with a usable password and stops on logout. Pages subscribe to the topics they display while mounted; the web app counts subscribers per topic and sends a subscribe for the first one and an unsubscribe after the last one.

| Page | Address | Who |
| --- | --- | --- |
| Projects list | `/` | everyone |
| Board | `/p/<Project Key>` (with optional `?task=<Task Key>` and `?closed=1`) | everyone |
| Project settings | `/p/<Project Key>/settings` | everyone (secrets and admin-only fields per [Board](board.md) and [Agents](agents.md)) |
| Task page | `/t/<Task Key>` | everyone |
| Wikis list and Wiki conversation | `/wikis`, `/wikis/<id>` | everyone |
| Agents list and Agent detail | `/agents`, `/agents/<id>` | everyone (editing for Admins) |
| Users, Credentials, Git Connections, Extensions | under `/admin/` | Admins |
| Sign-in, change password | `/login`, `/change-password` | everyone |

Members who open an admin page get the "not found" page (Users, Credentials, Git Connections) or "Admin access required" (Extensions). Any unknown address shows "not found".

#### Navigation

A fixed sidebar holds the product name, links to Projects, Wiki and Agents for everyone, links to Extensions, Credentials, Git and Users for Admins, and a "Boards" list with every non-archived Project (its key's first two letters as a badge, then its name). The User menu at the bottom shows the User's avatar, name and email and offers the theme choice, "Change password" and "Log out".

#### Projects list

Projects appear as cards with key, name and a bar of Task counts per Category. A "Show archived" switch swaps to archived Projects. "New project" opens a creation dialog. Project rules (keys, archiving, deletion) are in [Board](board.md).

The Project logo appears on its card, sidebar entry and Board header. General settings offers upload, replacement and removal with an image preview, format and size guidance, and feedback when saving succeeds or fails. The controls stay disabled while a logo change is being saved. Image loading failures show the Project Key. Accepted formats and lifecycle rules are in [Board](board.md#projects).

#### Board

The Board shows one column per Status in Status order, closed-category Statuses included only while "Show closed" is on (kept in the address so it survives reloads and links). Each column shows its colour dot, name and the number of cards currently shown, the cards in their stored order, and an "Add task" button.

A card shows the priority icon, Task Key, the assigned Agent's avatar with a state dot (animated while running) and its Queue position when queued, up to three User assignee avatars, the Pull Request badge (see [Git integration](git-integration.md)), the title, its Tags and the Comment count.

- **Quick add**: "Add task" opens a title field in the column. Enter creates the Task in that Status and keeps the field open for the next one; Escape or leaving it empty closes it.
- **Filters**: free text (matching title or Task Key), assignees (including "Unassigned"), Tags and priorities, each multi-select, combined together. "Clear" resets them. Filters apply to the cards shown and to the column counts, and last while the Board is open.
- **Drag and drop**: a card is dragged after the pointer moves 5 px, or with the keyboard. Crossing into another column places the card among that column's cards right away, so it can be dropped at a precise spot. Dropping moves the Task to that Status and position (see [Consistency under concurrent and out-of-order updates](#consistency-under-concurrent-and-out-of-order-updates)). The dragged card has no drop animation, so a new drag can start immediately after a drop.
- Clicking a card opens the Task in a dialog over the Board, recorded in the address so it can be shared and so the browser's back button closes it.

#### Task view

The Task view appears in two places with the same content: a large dialog over the Board, and a full page at the Task's address. The dialog adds "Open full page" and "Close". Pressing Escape while editing a field (title, description, Comment) ends that edit and keeps the dialog open.

The header shows the Project and Task Key, the editable title, and these controls:

- **Changes**: shows or hides Revisions on the Timeline; hidden by default.
- **Session chip**: the Session's state ("starting", "queued #N", "running", "waiting for messages", "paused", "waiting for retry", "closed"), coloured by state.
- **Stop** while the Session runs (the Interrupt), **Retry** when the Session is held after a failed Job, and **Notify agent** (with an explanatory tooltip) when the Task has Unseen Changes. These actions refetch the Session afterwards instead of trusting their own response, because the scheduler may already have moved it on.
- **Layout**: "Focus activity" or "Focus details" decides which panel takes the main area; the other sits in a collapsible right sidebar. Both choices are remembered per browser for every Task. The sidebar starts open on screens at least 1024 px wide and closed on narrower ones, where it slides over the main area.
- **Task actions**: "Copy link" (the Task page address) and "Delete task" (with confirmation).

The details panel holds Status, priority, User assignees, Agent (enabled Agents, plus the current one if disabled), Tags (with inline creation, cycling through eight colours), creator and creation time, last update, the Task Branch link and Pull Request badge, and the description.

The **description** is edited in place: clicking the text starts editing with the caret where the User clicked, the formatting toolbar appears in the heading's row, and the edit is saved once when it ends (clicking outside, Escape, or leaving the Task), producing one Revision per edit. Links in the description open in a new tab, and only for `http`, `https` and `mailto` addresses. Checkboxes stay clickable and selecting text doesn't start an edit. Images can be uploaded into the description or linked by URL. If someone else changed the description meanwhile, the draft is kept and a notice offers to save it over the other change (by clicking outside again) or to discard it.

The **activity panel** is the conversation: the Timeline, oldest first, with the composer docked below. While it is on screen and scrolled to the bottom, it moves the User's read position to the newest entry as entries arrive, and it does so again when the reader scrolls back down or returns to the browser tab. The read position itself is in [Conversation](conversation.md).

- Fifty items load first; "Load older activity" brings the previous page.
- Comments show the author's avatar (the Agent's avatar for Agent Comments), name, a badge for Agent and System Comments and for Internal Notes, time, "edited", and the Delivery badge (queued, delivered, not delivered with its reason in a tooltip). Internal Notes have a dashed slate border, Agent Comments a violet tint, System Comments an amber one. Bodies taller than 320 px are clamped with "Show more".
- Image attachments (PNG, JPEG, GIF, WebP, AVIF) show inline previews; other files are listed with name and size and download on click.
- A User's own Comments offer "Edit"; deletion is available to their author and to Admins, after confirmation. A deleted Comment leaves a one-line "deleted a comment" marker.
- Revisions read as sentences ("moved it from Todo to In Progress"); identical consecutive Revisions by the same Actor fold into one line with a count.
- Thinking and Activity are collapsed by default. Activity shows the number of actions, an icon per kind of tool, the number of failed actions and the last action's summary; expanding it lists each tool call with its outcome, expanding a call shows input and output, and subagent calls nest under the call that started them. Turn Summaries show outcome, duration, tool calls, tokens and cost.
- Below the stored items, the Live Turn preview shows "Preparing the worktree" with the Setup Script output (expandable, last 64 KB kept), a "Retrying the Claude API (attempt N/M)" line, "Thinking…", and the Agent's text as it is written, in a dashed bubble with a cursor.
- While the User is within 96 px of the bottom, new content keeps the view scrolled to the bottom; once they scroll up to read, it stays where they are.

The **composer** writes Markdown. Enter sends and Shift+Enter starts a new line. Files can be attached by button, drag and drop, or paste (pasted images get unique names), up to 10 files of 25 MB each per Comment; the composer reports the limit when a file would exceed it. The "Internal chat" switch turns the Comment into an Internal Note: the composer turns dashed and slate, shows "only people see this, never the agent", and the button reads "Send". Typing `/` at the start, or a skill name anywhere, suggests the Session's chat commands (skills, MCP prompts, Claude commands) for keyboard or mouse selection; suggestions are hidden in Internal Notes.

Sending keeps whatever the User typed or attached while the request was in flight: only the sent text and files leave the composer. The unsent Draft of each Task survives closing the Task and coming back to it, until the page reloads, the User signs in or the User logs out.

#### Wikis

The Wiki section lists Wikis as cards (name, description or repository, repository) with a "New wiki" dialog that asks for name, description, Agent and repository (grouped by Git Connection, with unreachable connections listed as errors) and an optional Base Branch prefilled from the repository. A Wiki opens as a conversation page: name, repository link, Session chip, Stop and Retry, "Reset chat" (with confirmation), settings and delete. The Task Branch and review link appear under the header when they exist. The conversation is the same activity panel as a Task's, with Revisions always hidden.

Resetting from this page empties the Timeline and Live Turn preview at once, without waiting for the event; everyone else viewing it sees the same through the reset event. Wiki rules are in [Wikis](wikis.md).

#### Agents and administration

The Agents list (everyone) shows each Agent's avatar, state, current Task, Queue length, Credential and last activity; Admins see "New agent". The Agent detail page has tabs for current work and Queue (Members can reorder by dragging and remove entries), builds with live logs, usage, container logs (the last 500 lines, refreshed every 3 seconds while the tab is open) and configuration. Project settings has tabs for General, Statuses, Tags, Agents and Repository. Admin pages manage Users, Credentials, Extensions (Skills, Plugins, MCP servers) and Git Connections. The behaviour behind each of these is in [Users and auth](users-and-auth.md), [Board](board.md), [Agents](agents.md) and [Git integration](git-integration.md).

Project Setup Scripts and Agent Instructions, and the non-Docker fields of an existing Agent's Configuration tab, save automatically after a 600 ms pause or when focus leaves a field. Pending edits are also submitted when switching settings tabs or navigating to another app view. Each section shows whether changes are being saved, have been saved or failed, with a Retry action on failure. Dockerfile, Development Services and CPU and memory limits share a separate explicit save action. Creating an Agent and managing Project environment variables and imports use their own submit actions. See [Agents](agents.md#editing-an-agent).

#### Theme

The web app uses a dark theme by default, with Light and System as alternatives in the User menu. The choice is stored per browser and applied before the first paint, so the first paint already uses it; when storage is unavailable the choice lasts for the open page. The UI kit and colour tokens are shared across pages.

#### Consistency under concurrent and out-of-order updates

The web app keeps server data in a query cache that HTTP responses and events both write into. These rules keep it correct when requests, responses and events cross:

- **Version guard for Tasks.** A card or Task arriving from any source is applied only if its version is at least the newest version cached anywhere (any Board list or Task view). A late HTTP answer can't bring back an older title, Status or Tag set that an event already replaced.
- **Closed-category filtering.** A card whose Status is closed-category is removed from Board lists that hide closed Statuses and added to those that show them. When the Status list changes, Board lists are refetched, since a Category change can move cards in or out.
- **Timeline placement.** An item already shown is replaced in place. A new item is inserted at its position in the server's order, so items arriving out of order still read in the order they happened. An item older than everything loaded, with older pages still unloaded, waits for "Load older activity" instead of appearing at the bottom. An item seen on two pages (because it crossed a page boundary between fetches) is shown once.
- **Session state.** A Session event cancels any Session request in flight and replaces the cached Session. Session actions (Stop, Retry, Notify agent) refetch afterwards.
- **Serialized field saves.** Edits to one Task are saved one at a time, in order. Each save sends the version the User saw, or the version of their own previous save if that is newer, so quick consecutive edits by the same User never conflict with each other. While a save is queued or in flight, its values are shown over the Task; a field stays pending until its latest save completes.
- **Conflicts.** A save that conflicts with someone else's change (`409`) applies the server's current Task and warns "Someone else changed this task", leaving the User's change unsaved. The title field follows remote renames except while the User is typing in it.
- **Optimistic Board moves.** A drop updates the card immediately, with a position computed between its new neighbours (when the neighbours share a position, the card keeps its old one until the server respaces the column and answers). The request names the neighbour the card goes after or before. On failure only that card goes back, unless newer news of it already arrived, so cards created or moved by others meanwhile stay; the Board and the Task view are then refetched and a "Couldn't move" message appears.
- **Deletions.** A deleted Task disappears from Boards; an open Task view shows "This task doesn't exist (or was deleted)".
- **Requests.** A request that fails with a server error or a network failure is retried up to twice; client errors are reported at once. Data stays current through events and reconnection, so refocusing the window leaves queries as they are.

### Native app

#### Sign-in, Login and profiles

The sign-in screen asks for the installation URL (prefilled from the build configuration when given), email and password. The URL must be an `http` or `https` origin with a host, no credentials, path, query or fragment. The app signs in through the regular login API and keeps the Login cookie, the installation URL, the User and a device id generated at sign-in in the platform's secure storage (Keychain, Android Keystore, Secret Service on Linux). Passwords are never stored. Every request carries the cookie and the CSRF header explicitly, and whenever the backend renews the cookie the app stores the new one.

One installation and one User are active at a time; switching requires logging out. Data cached for a profile is kept separately per installation and User. Responses that arrive after the profile changed are discarded.

- A temporary password leads to the change-password screen before anything else; a request rejected because a password change is required leads there too.
- A `401` or a live connection closed with `4001` ends the profile: the stored Login is removed and the sign-in screen says "Your Login expired. Sign in again."
- **Logout** asks the backend to end the Login, removes the push token, and deletes the profile's cache, Drafts, staged draft files, downloaded attachments and the Login. When the backend can't be reached, local data is cleared immediately and the old Login is kept only in secure storage as a pending logout, sent again on the next start and every reconnect until the backend confirms. A pending logout is never used as an active Login.

#### Navigation and presentation

The layout adapts to the window width.

| Width | Layout |
| --- | --- |
| Below 1000 px (phones, narrow windows) | Successive screens: Projects list, then the Project's Tasks, then the conversation. Back (button, gesture or system back) returns one level. Task details open on demand. |
| 1000 px to 1499 px | Three panes: a 76 px Project rail, a 340 px Task list, the conversation. Task details open on demand from the conversation header. |
| 1500 px and wider | The same three panes plus a 360 px Task details panel next to the conversation. |

The **Project rail** lists Projects as badges, with buttons for the Wiki section and the Profile. The phone's **Projects list** shows each Project's key, name, Task count and a completion bar (done and closed Tasks over all Tasks). Empty panes say what to pick next ("Select a Project", "Select a Task to join the conversation").

Project badges, Project list rows and the phone Task list header show the Project's logo when available, falling back to its key while loading, offline or after an image error. Logo downloads use the native client's authenticated API connection and the current Installation's origin validation. The selected Project refreshes its logo from the Project details alongside its Statuses and Tasks.

The **Task list** groups Tasks under their Status, in Status order, with collapsible group headers. Closed-category Statuses appear when the "Archive" chip is on. A search field matches Task Key and title; a filter sheet offers one priority, one Tag and one assignee (or "Unassigned") at a time, with a count on the "Filters" chip and a "Clear" action. While searching or filtering, empty groups are hidden. Each row shows priority, Task Key, title (bold with a dot when unread), Tags, up to two assignee avatars, the Agent's badge with Session state and Queue position, and the Comment count. "Create Task" opens the creation form.

The **Profile** sheet shows the User and their avatar, "Change photo", "Remove photo" when a photo is present, "Enable notifications" with the current push status, and "Log out". Photo changes are available while online, accept PNG, JPEG, GIF or WebP up to 2 MB, and update the User's avatars immediately after saving. Failures are shown in the sheet and leave the previous image visible.

User avatars show the profile image and fall back to initials while loading or after a download or decoding failure. Images use the authenticated API client with the current Installation's origin validation. Profile images appear in profile controls, User pickers, assignees and conversations. The Users list refresh supplies updated images, including changes made by an Admin from the web app.

The app uses a dark charcoal theme with neon teal accents, orange for Agents, slate for Internal Notes and amber for System Comments.

#### Conversation

The conversation shows the Task's Timeline oldest first, with day separators ("Today", "Yesterday", dates), and Comments by the same author, of the same kind and visibility, within 5 minutes grouped under one header. Markdown and code are rendered; long Comments are clamped with "Show more". Revisions are hidden behind a "Changes" toggle and read as sentences, with identical consecutive ones folded. Thinking and Activity are collapsed; Turn Summaries read "Turn completed" or "Turn failed" with duration and tool calls. Delivery state shows on User Comments. The Live Turn preview shows the Agent's text and "Thinking · streaming" as they arrive, and "Agent retrying request" during API retries.

Own Comments remain aligned to the right and show their body, timestamp and Delivery indicators. Other User avatars appear on the left at the start of each group. Consecutive grouped Comments reserve the same avatar space to keep their bubbles aligned. Internal Notes use the same presentation rules.

- While the reader is within 80 px of the bottom, new content keeps the view at the bottom. When they read older entries, their position is kept as content arrives and a "Jump to latest" button appears. "Load older entries" fetches the previous page.
- The header shows the Task Key and title, the Session state, Stop, Retry and Notify agent when they apply, a details button, Mute or Unmute, and an actions menu with Follow or Unfollow, the Session actions, and Delete Task.
- An empty conversation says "Your first Comment starts the Agent" when an Agent is assigned.
- Own User Comments offer copy, edit and delete while online.
- Attachments are listed with name and size. They download on request into the profile; a downloaded image shows a preview and any downloaded file opens with the system's viewer.

The **composer** stays visible at the bottom. Enter sends and Shift+Enter inserts a newline at the caret; Ctrl or Cmd+Enter also sends, and the phone keyboard shows a Send action. Text being composed by an input method is left to it. A compact 36 px icon button beside Attach switches between Comment and Internal chat within the composer row. Its speech-bubble icon changes to a lock with a muted slate background in Internal chat; its tooltip names the current mode and the action, and accessibility exposes the toggle state. Switching preserves the draft, focus, keyboard and composer position. Internal chat makes the Comment an Internal Note, with a dashed slate style and the hint "Hidden from the Agent…". Attaching files copies them into the profile (up to 10 files of 25 MB each), so they survive restarts; they are uploaded only as part of a manual send. Chat command suggestions work as in the web app.

#### Creating and editing Tasks

The "New Task" form asks for a title, a Markdown description and an optional Agent. With an Agent chosen, the button reads "Create and assign" and the form notes that the Agent starts on the first Comment. Creation is two requests: create the Task, then assign the Agent against the new Task's version. If the assignment fails, the Task stays created and opens, with a "Retry assignment" action that only repeats the assignment.

The details panel shows Status, priority, Agent, User assignees, Tags, Task Branch and Pull Request links and the description, and lets the User change Status, priority and Agent directly; "Edit Task" opens a form for title, description, assignees and Tags. Every change is sent with the Task's version, so a conflicting change by someone else is reported instead of overwriting. Task changes and Session actions are available while online.

The description editor offers a visual mode (headings, emphasis, inline code, links, lists, checklists, quotes, dividers, code blocks with a language, tables as Markdown blocks), a Markdown mode and a preview, all on the same Markdown text. Opening a description or switching modes keeps its source as it is; a visual edit may normalize spacing and delimiters. Content the visual mode can't represent opens in Markdown mode. Image links are kept and shown as linked cards, without fetching remote images.

#### Wikis

The Wiki section lists Wikis; "New wiki" asks for name, description, Agent, repository and Base Branch, and Wiki settings link to the repository, the Wiki's branch and its review. Opening a Wiki shows its conversation like a Task's, with Mute, Follow, Session actions, "Reset chat" (online only, with confirmation) and "Delete wiki". On wide windows the section shows the rail, the Wiki list and the conversation; on phones, the list and then the conversation.

#### Local state and offline use

The app caches what it has fetched in a file inside the profile's application-support folder, written atomically and one write at a time so an older write can't overwrite a newer Draft:

- global lists: Projects, Wikis, Agents, Users;
- per Project: Statuses, Tags, every Task (closed ones included) and the User's Task preferences;
- per Task: the Task, the loaded Timeline pages, the cursor for older pages and the Session;
- per Task: the Draft (text, Internal Note flag, staged files, and whether its last send had an unknown outcome).

Live Turn previews stay in memory only, so the offline cache holds stored Comments alone.

On start the app shows the cached data right away and refreshes it. Offline, cached Projects, Tasks and conversations stay readable, Drafts can be written and files attached, and downloaded attachments open; everything that changes data waits for a manual action once the app is back online. The top of the screen shows "Offline · loaded conversations and drafts are available" or "Reconnecting…" with a "Reconnect" button, and errors appear in a dismissible banner.

#### Sending and unknown outcomes

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Draft: offline Send (kept, "send manually after reconnecting")
  Draft --> Sending: Send while online
  Sending --> [*]: Comment stored (Draft cleared)
  Sending --> Draft: rejected by the server (reason shown)
  Sending --> Unknown: timeout, lost connection or server error
  Unknown --> Draft: Refresh and review
```

Before sending, the app marks the Draft as possibly sent. If the request times out, the connection drops or the server answers with an error of its own, the outcome is unknown: the Draft is kept and marked, and Send is disabled until the User chooses "Refresh and review". That refetches the conversation so the User can check whether the Comment arrived, and then send again manually or discard the Draft. Sending and changing Tasks always start from a User action; reconnecting only refreshes.

#### Live updates

The native app subscribes to its User topic, the Agents and Wikis topics, the open Project and the open Task, and replaces the set whenever the selection changes. It treats events like this:

- Comments, Revisions and Agent Timeline items of the open Task are merged into the Timeline at once, in the server's order. An update to an entry that isn't loaded waits for the next refresh instead of appearing at the bottom.
- When a stored Agent Comment, Thinking, Activity or Turn Summary arrives, the matching Live Turn preview is retired in the same update, so the text stays on screen continuously from preview to stored version.
- A Session change replaces the Session; when the Session is no longer running, the Live Turn preview is cleared.
- A Task removal closes the open Task.
- Any other event schedules a refresh 180 ms later (restarted by each new event, one refresh at a time), which refetches the global lists and the open Project and Task. Live Turn deltas, retry status and preference events are applied directly without a refresh.

#### Following, unread state and notifications

The native app shows the User's following, mute and unread state per Task, shared across all of the User's devices through the backend and the private User topic. The rules for automatic following, explicit choices and read positions are in [Conversation](conversation.md).

- A Task is unread while it has persisted entries newer than the User's read position, whether the User read it in the app or on the web. Its row is bold with a dot.
- Reading advances only when the conversation is the open, visible screen, the app is in the foreground and online, and the reader reaches the bottom (within 80 px): the app then reports the newest loaded entry as read. Fetching or receiving data marks nothing as read. The unread state is shared with the web app, which advances the read position as it reads.
- Follow, Unfollow, Mute and Unmute are in the conversation header and menu.

**Push notifications** reach iOS and Android phones through Firebase Cloud Messaging, including when the app is closed. "Enable notifications" first checks that the installation has push configured ("Phone push is not configured on this installation" otherwise), then asks the system for permission and registers the phone's token with the backend for the current Login and device id. Already authorized phones register again on every sign-in and app start, and token rotations are sent as they happen. If permission is declined, the app says so and unread indicators keep working. Notifications show only "Claude Task" and "A Task you follow has an update.", one per Task at a time, and carry the Task's id. Tapping one opens the app at that Task, after sign-in and any forced password change if needed; a Wiki's conversation opens in the Wiki section. While the app is in the foreground, notifications stay silent, since the app is already live. Desktops show live updates and unread state while the app runs. Which events notify whom, deduplication and retries are in [Conversation](conversation.md).

#### Reset detection

Every Task and Timeline page carries its conversation generation. When another User resets a Wiki's chat, the reset event clears the open conversation, its Live Turn preview and its cached pages, or just the cache for a Wiki not currently open. When the app missed the event (offline, closed), the next fetch finds a newer generation than the cached one and discards the cached conversation before showing the fresh one. A page that arrives with a different generation from the Task fetched with it is refetched, up to two more times.

### Serving the clients

The production image runs one process that serves the HTTP API and the WebSocket under the API prefix, the Git Proxy under its own path, and the built web app from a static folder. When the static folder contains the app, every `GET` outside the API that matches no file returns the app's page, so client-side addresses work on reload and from shared links; other methods there answer `404`. Unknown API paths answer `404` in JSON. Web app files are served with security headers: a Content Security Policy allowing scripts, styles, fonts and connections from the same origin only (inline styles allowed for the editors, images from the same origin, `data:`, `blob:` and any HTTPS URL), no framing by other sites, no MIME sniffing, and same-origin referrers.

Reverse proxies in front of the installation must forward WebSocket upgrades on the real-time endpoint. In development, the web app's dev server forwards API and WebSocket traffic to the backend.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    W[Web app] --> QC[Query cache]
    W --> LS[Live Turn store]
    W --> DR[Drafts in memory]
  end
  subgraph Device
    N[Native app] --> PC[Profile cache file]
    N --> SS[Secure storage: Login, pending logout]
    N --> FCM[Firebase Messaging]
  end
  subgraph Backend
    API[HTTP API]
    HUB[Realtime hub]
    STATIC[Static web app]
    PD[Push dispatcher]
  end
  W -- HTTP --> API
  W <-- WebSocket --> HUB
  N -- HTTP --> API
  N <-- WebSocket --> HUB
  Browser -- page load --> STATIC
  PD --> FCMS[FCM service] --> FCM
  API -- after commit --> HUB
```

- **Realtime hub** (backend): keeps each connection's User, Login and topics, fans events out to the connections subscribed to a topic, drops connections whose backlog passes 16 MB, and closes a Login's connections when it ends.
- **Web app**: React with a query cache for server data, a separate store for Live Turn previews (they change many times a second and would otherwise churn the cache), an in-memory Draft store and one live connection object that routes events into both stores.
- **Native app**: one controller holding the selection, cached data and connection state; an HTTP client and a socket client bound to the active profile; a profile store backed by a cache file and secure storage; a push adapter over Firebase Messaging.
- **Shared contracts**: API payloads, topics and events are defined once in the shared TypeScript package; the native app mirrors the shapes it uses in its own models.

## Data model

Client-side state, by client:

- **Web app**
  - Query cache: Login check, Users, Projects, Project bundles (Project, Statuses, Tags), Board lists per Project and closed-visibility, Tasks, Timelines, Sessions, Agents and Agent details, Wikis, Credentials, Extensions, Git Connections. Cleared on sign-in and logout.
  - Live Turn store per Task: text, Thinking, retry status, Setup Script output (last 64 KB). Cleared on disconnection and logout.
  - Drafts per Task: text, Internal Note flag, files. Kept until reload, sign-in or logout.
  - Per-browser preferences: theme, Task layout focus, Task sidebar open or closed.
- **Native app**
  - Secure storage: the Login (installation URL, cookie, User, device id) and an optional pending logout.
  - Profile folder, one per installation and User: the cache file (global lists, per-Project data, per-Task conversation and Draft), staged draft files, downloaded attachments. Deleted on logout.
- **Backend, used by the native app** (rules in [Conversation](conversation.md)): Task preference per User and Task (following, muted, read position, latest position, unread); device registration per phone (device id, platform, encrypted token, Login).

## Non-functional requirements

- **Liveness**: a change made by one User (a card moved, a Comment posted) appears in other open clients within one second.
- **Heartbeat**: ping every 30 s; dead connections are dropped within about 60 s.
- **Backpressure**: at most 16 MB queued per connection before it is terminated.
- **Control messages**: up to 64 KB and 100 topics per message.
- **Reconnection**: web backoff from 0.5 s up to 30 s; native backoff from 1 s up to 32 s with a 15 s connection timeout.
- **Native requests**: 30 s timeout per HTTP request and attachment download.
- **Security**: Markdown (descriptions, Comments) is rendered without its raw HTML, and description links open only for web and mail addresses, since Agents write content Users view. The Content Security Policy refuses inline and third-party scripts. The theme is applied by a same-origin script for the same reason. Native lock-screen notifications contain no Project names, Task titles, Comment text or secrets. Native Login material lives only in platform secure storage.
- **Privacy**: preference and read-position events go only to the User's own topic.
- **Native platforms**: iOS 15+, macOS 12+, Android with Google Play services for push; Windows and Linux desktop builds (Linux needs a Secret Service keyring).

## Decisions

- **One WebSocket per client, with topic subscriptions.** A client opens one connection and subscribes to the topics on screen. Separate connections per view would multiply handshakes, heartbeats and reconnection logic for no gain, and polling would make Agents' streaming output and Board moves feel slow.
- **Events carry projections; clients refetch instead of replaying.** Each event holds the new state of what changed, so applying it needs no request. After a disconnection, clients refetch what they show rather than asking for missed events. This keeps the backend free of per-client event logs and makes recovery identical for every cause of disconnection (network, restart, backpressure, missed ping).
- **Refetch on subscription acknowledgement.** Events flow only after the backend confirms a subscription. Refetching at that moment closes the window between a view's first fetch and its subscription, without ordering the two.
- **Terminate slow subscribers past 16 MB.** Buffering without limit for a browser that stopped reading would let backend memory grow by hundreds of megabytes during streaming Turns. Since clients already recover by refetching, dropping them is safe and bounded.
- **Arrival order is untrusted.** HTTP responses and events race, so clients order and filter by data the server provides (Task versions, the Timeline's order key, Session events over snapshots) instead of by when things arrive. Optimistic Board moves revert only the moved card, keeping concurrent changes by others.
- **Serialized saves of one Task's fields.** Saving one edit at a time, each counting the User's own previous save as seen, lets quick successive edits succeed while still detecting conflicts with other people.
- **Live Turn preview outside the query cache.** Deltas arrive many times a second; keeping them in a small separate store avoids re-rendering everything that reads the cache, and the stored item retires the preview when it lands.
- **A native app alongside the web app.** People want to follow and steer Agents from their phones, with alerts when an Agent finishes or needs them. Flutter gives one codebase for iOS, Android, macOS, Windows and Linux. The web app stays the place for infrastructure configuration (Dockerfiles, builds, Git Connections, Extensions, Project secrets and repository settings), which the native app does not duplicate. The native Settings screens (opened from the Profile sheet) cover Project details, archiving, Statuses and Tags, creating and configuring Agents (without Dockerfile, services or limits), and, for Admins, Users and Credentials, through the same API and permissions as the web app. All five platform projects exist; the native app targets native platforms only.
- **Chat-style navigation grouped by Status.** Projects as a rail and Tasks as channels grouped by Status match how people use the native app: picking a conversation, not rearranging a Board. The native app therefore has no Board view.
- **Native cookies kept in secure storage, one installation per profile.** The native app reuses the web's Login cookie and CSRF header rather than a separate token scheme, so every API rule (expiry, forced password change, logout everywhere) applies unchanged. Supporting several installations or Users at once was left out to keep cached data simply isolated per profile.
- **Offline reading and Drafts, manual sending.** Cached conversations and Drafts work offline, but nothing is submitted automatically after reconnecting. An automatic retry of a send whose outcome is unknown could post a Comment twice and start an Agent Turn twice; asking the User to review first trades a tap for correctness.
- **Following, mute and read positions live on the backend.** Storing them per User and Task lets phone and desktop share them and lets the backend decide whom to notify. An explicit unfollow or mute wins over later automatic following. Participation means posting a Comment or Internal Note; assignment means User assignment, not Agent assignment.
- **Reads advance only on visible content.** Marking read on fetch would clear unread state for conversations nobody looked at, including those refreshed in the background.
- **Generic push content through FCM HTTP v1.** Lock screens show a fixed message and the Task id only, so no project information leaks to a locked phone. Notifications are generated from persisted Turn and Session outcomes, not from streamed fragments or by reading the Agent's prose. A real provider is required for push to count as working; without credentials, the app reports an unconfigured state and everything else works. Desktop notifications while the app is closed are left to a later version.
- **Create and assign as two requests.** Task creation has no Agent field, so the native app creates the Task, then assigns the Agent against its version. A failed assignment keeps the Task and offers to retry only the assignment, so a retry never creates a duplicate Task.
- **Conversation generation for Reset Chat.** A reset event is transient and a closed or offline app misses it. A counter on the Task and on each Timeline page lets the native app detect the reset on its next fetch and drop cached pages from before it.
- **One image serves API, WebSocket and web app.** A single process and origin keeps cookies, CSRF checks and the WebSocket origin check simple and needs no separate web server. Client-side routes fall back to the app's page.
- **Dark theme by default.** It matches the product's intended look and suits the code and logs Agents produce; light and system themes remain available per browser.

## Related specs

- [Users and auth](users-and-auth.md): Logins, roles, forced password changes and the CSRF header the clients send.
- [Board](board.md): Projects, Statuses, Tags and Tasks shown on the Board and in Task views, including ordering and version conflicts.
- [Conversation](conversation.md): Comments, Internal Notes, attachments, Delivery, mentions, and the following, read-position and push notification rules the native app relies on.
- [Agents](agents.md): Agents, Credentials, builds and containers shown on the Agents pages.
- [Agent sessions](agent-sessions.md): Sessions, Jobs, the Queue and the Timeline projection behind the conversation and the Live Turn preview.
- [Runner](runner.md): the Runner's own WebSocket to the backend, separate from the clients' live connection.
- [Git integration](git-integration.md): Task Branches, Pull Requests and Git Connections linked from Task views and settings.
- [Wikis](wikis.md): Wikis, their shared conversation and Reset Chat.
