---
status: in-progress
---

# Scheduled messages and automatic resume after a usage limit

## Specs

- [Conversation](../specs/conversation.md)
- [Agent sessions](../specs/agent-sessions.md)
- [Board](../specs/board.md)
- [Clients](../specs/clients.md)

## Problem Statement

A User who wants the Agent to receive something later (after the night, after a colleague's review, at the start of the week) has to come back at that time and write the Comment by hand. Schedules start recurring Agent work, but there is no way to post one single Comment in the future on an existing Task.

When an Agent hits a Claude usage limit, its Turn stops with an error and nothing else happens. Someone has to notice, work out when the limit resets and write "continue" at that time. With several Agents sharing a Credential this is repeated for every Task.

## Solution

A User can **schedule a Comment** from the composer: pick a date and time, and the Comment is published at that time as an ordinary Comment, with the usual Delivery. Until then it is listed on the Task, where any User can edit its time, cancel it or send it now.

When a Turn stops at a usage limit that reports when it resets, the System Comment that reports the error offers "Schedule resume" and "No". Choosing the first creates a **Limit Resume**: a scheduled message due one minute after the reset. A Project setting and a Task setting, reachable from the Task's menu, make the platform create the Limit Resume without asking. Both clients, web and mobile, support all of it.

## User Stories

1. As a User, I want to pick a date and time next to the Send button, so that my Comment is posted later.
2. As a User, I want to schedule an Internal Note, so that a reminder for the team appears at the right time.
3. As a User, I want to schedule a Comment with files, so that a prepared message goes out complete.
4. As a User, I want to schedule a Comment that starts with a Native Command or a Skill, so that I can run `/compact` or a Skill later.
5. As a User, I want to see the scheduled messages of a Task in a list on the Task, so that I know what is going to be sent.
6. As a User, I want to change the time or the text of a scheduled message, so that I can correct a plan.
7. As a User, I want to cancel a scheduled message, so that it is never sent.
8. As a User, I want to send a scheduled message now, so that I do not have to wait for its time.
9. As a User, I want a scheduled message to be published under my name, so that the Timeline shows who wrote it.
10. As a User, I want the list to show messages that were sent, cancelled or replaced, with the reason, so that I understand what happened.
11. As a colleague, I want to see and cancel the scheduled messages of other Users on the Task, so that a plan can be stopped when the situation changes.
12. As a User, I want a message scheduled on a Task that was closed in the meantime to be published as "not delivered" with the reason, so that I see it did not reach the Agent.
13. As a User, I want a scheduled message due while the backend was down to be sent when it starts again, so that downtime does not lose it.
14. As a User, I want the time shown in my own time zone, so that "tomorrow 09:00" means 09:00 for me.
15. As a User, I want to be told when a time is in the past or too far ahead, so that I do not schedule something that cannot happen.
16. As a User, I want the System Comment of a usage limit to say when the limit resets and offer to schedule the resume, so that I do not need to compute and remember the time.
17. As a User, I want to decline the offer, so that the Agent stays idle until I decide.
18. As a User, I want the offer to disappear once it is no longer needed (the limit passed, or the Agent worked again), so that stale buttons do not mislead.
19. As a User, I want the first person who answers the offer to decide for everybody, with their name shown, so that the Task has one decision.
20. As a User, I want the resume to be a visible, cancellable scheduled message, so that I stay in control of an automatic action.
21. As a User, I want a new limit to replace the pending resume with the new time, so that only one resume is waiting.
22. As a User, I want the pending resume to be cancelled when the Agent already worked again, so that the Agent is not told to continue twice.
23. As a User, I want a pending resume to be cancelled when the Task is closed or the Agent is unassigned, so that nothing arrives for a Task nobody works on.
24. As a Member, I want to turn on automatic resume for one Task from its menu, so that a long job continues overnight without me.
25. As a Member, I want to turn on automatic resume for a whole Project, so that new Tasks start with it on.
26. As a Member, I want the Project setting to be copied to a Task when it is created and then be independent, so that changing one Task does not change the rest.
27. As a User, I want no offer when the limit does not say when it resets, so that I am not offered a time that does not exist.
28. As a mobile User, I want to schedule, edit, cancel and send now from the app, and to answer the offer, so that I can manage this away from my desk.
29. As a mobile User, I want my scheduled messages and the resume offer to update live, so that the screen matches the server.

## Implementation Decisions

- **Scheduled Message** is a new stored entity belonging to a Task: kind (`user` or `limit_resume`), author (the User; none for a Limit Resume), Markdown body, internal flag, due time, state (`pending`, `sent`, `cancelled`), a reason for cancellation, the Comment it became, and its creator and timestamps. Files live in the Attachments table, which gains a third possible owner (a Scheduled Message); when the message is published the files move to the new Comment, when it is cancelled or its Task is deleted they are removed with their blobs after commit.
- **Limits:** the due time must be at least one minute and at most 366 days ahead when created or edited (`400` otherwise); body and files follow the Comment limits; a body or a file is required. The internal flag and the files are fixed after creation; editing changes the body and the due time. Only `pending` messages are edited, cancelled or sent now (`409` otherwise).
- **API:** list, create (JSON or multipart like Comments), edit, cancel and send now, on a Task and by message id. Every signed-in User can use them on any Task. The list returns pending messages ordered by due time, then the 20 most recent finished ones. Create, edit, cancel, send and the automatic state changes publish a `scheduled_message.updated` event with the full message on the Task's topic.
- **Publishing:** the existing background tick (30 seconds) also publishes due messages, through an injectable clock and a tick tests can call, the way due Schedules are started. Each message is published in its own transaction that locks the row, so concurrent backends or a send-now racing the tick publish it once. A `user` message is created through the same path as a posted Comment (author follows the Task, mentions are notified, Delivery runs), then marked `sent` with the Comment's id. If the Task no longer exists nothing is left to publish. A message whose Comment is published on a closed Task, or without a usable Agent, shows the normal "not delivered" Delivery reason.
- **Limit detection:** the projection of a Turn remembers the last `rate_limit_event` of the Turn. When the Turn ends in error and that event has `status: rejected` and a `resetsAt` in the future, the system comment that reports the error carries the reset time. A limit without usable `resetsAt` produces the System Comment of today and nothing else.
- **Limit Resume entity:** the structured part of that System Comment, like Questions: reset time, state (`open`, `scheduled`, `declined`, `unneeded`), who decided and when, and the Scheduled Message created. Clients that know it show "Schedule resume" and "No" with the reset time; older clients show the text. The first answer wins (`409` for a later one with the name of who answered); answering an `unneeded` offer is `409`. An offer becomes `unneeded` when a later Turn of the Task finishes without error, when a later limit makes a new offer, or when the reset time plus one minute has passed (found by the tick and on answer).
- **Limit Resume message:** kind `limit_resume`, due at the reset time plus one minute, published as a System Comment whose notice is a fixed text telling the Agent the limit was reset and to continue where it stopped. It is delivered like a Notify agent notice. A Task has at most one pending Limit Resume: creating another cancels the old one with the reason "replaced"; a Turn that ends without error, closing the Task, or unassigning/replacing its Agent cancels it with the matching reason. A Limit Resume can be rescheduled or cancelled by Users like any scheduled message, but its text cannot be changed.
- **Automatic resume setting:** a boolean on Project (default off) and on Task (default off, set from the Project when the Task is created, including Tasks created by Agents and by Schedules). Both are edited through the existing update endpoints and appear in their payloads. When a limit with a reset time ends a Turn on a Task with the setting on, the Limit Resume is created in the same transaction as the System Comment, which then shows state `scheduled` with no author.
- **Web:** a schedule control (date and time picker, in the browser's time zone) next to Send in the composer; a "Scheduled" strip above the composer listing pending messages with edit, cancel and send now, and a collapsed history; the limit System Comment shows the actions; the Task's menu gets an "Automatic resume at limit" switch; the Project settings get the same switch. Wiki Chats get the same composer behaviour.
- **Mobile:** the same capabilities in the conversation screen, the Task menu and the Project settings, kept live by the existing real-time connection. Schedule composing needs the network, so a scheduled message is not queued offline.
- **Time zones:** due times travel as ISO instants; clients render and pick them in the device time zone.

## Testing Decisions

- **Backend public API seam** (HTTP and WebSocket against real Postgres with the fake runner), in a new test file for scheduled messages and in the existing stream-fixture tests for limits. It covers: creating, listing, editing, cancelling and sending now; validation of times; publishing by the tick with an injected clock and Delivery outcomes (running Agent, queued, closed Task, no Agent); files moving to the Comment; Internal Notes never delivered; concurrency of send now and tick; catch-up after downtime; the limit System Comment with its offer from a recorded `rate_limit_event` plus failed result fixture; answering and the `409` cases; `unneeded` transitions; automatic mode; replacement and cancellation of the pending Limit Resume; the setting on Project and Task and its copy at creation.
- **Projection unit tests** (table-driven over recorded fixtures) for the limit detection: rejected with `resetsAt`, rejected without, allowed, stale event from a previous Turn.
- **Frontend:** a small Playwright test of scheduling a Comment and of answering the limit offer, in the existing e2e suite.
- **Mobile:** widget tests for the schedule control and the limit card, in the existing Flutter test directory.
- Prior art: the Schedules tests (injected clock and tick), the Question answering tests, the stream fixtures such as the spend limit one.

## Acceptance Criteria

- [ ] A User can create a scheduled message (text, files, Internal Note, Native Command) with a future time, and sees it in the Task's list.
- [ ] Any User can edit the time or text, cancel it, or send it now while it is pending.
- [ ] A due message is published once as a Comment by its author, with the normal Delivery, and is shown as sent.
- [ ] A message due on a closed Task, or without an Agent, is published with the matching "not delivered" reason.
- [ ] A message that came due while the backend was down is published on the next tick.
- [ ] A Turn that stops at a rejected limit with `resetsAt` yields a System Comment offering "Schedule resume" and "No"; without `resetsAt` it does not.
- [ ] Choosing "Schedule resume" creates a Limit Resume due one minute after the reset; the first answer decides and a later one gets `409`.
- [ ] With automatic resume on for the Task, the Limit Resume is created without asking.
- [ ] A new limit replaces the pending Limit Resume; a successful Turn, closing the Task or unassigning the Agent cancels it; the offer becomes `unneeded` accordingly.
- [ ] The Limit Resume reaches the Agent as a Message and the Agent continues.
- [ ] Project and Task have the automatic resume switch (Task menu, Project settings); a new Task copies the Project's value.
- [ ] Web and mobile clients support scheduling, the list, the offer and the switches, live.
- [ ] Specs and glossary describe the behaviour; `pnpm typecheck` and `pnpm test` pass.

## Out of Scope

- A Task Tool for Agents to schedule messages.
- Recurring scheduled messages (Schedules cover recurring work).
- Queueing scheduled messages offline in the mobile app.
- Coordination between Tasks that share a Credential when a limit hits.
- Notifications for sent or failed scheduled messages beyond the Comment's usual ones.

## Further Notes

- The glossary terms Scheduled Message, Limit Resume and Automatic Resume are already in `docs/CONTEXT.md`.
- Limits that carry a reset time but are really spend caps (the recorded spend-limit stream) are offered a resume as well; the Agent simply hits the limit again and a new offer follows.
