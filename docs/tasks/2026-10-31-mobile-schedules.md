---
status: done
---

# Schedules in the native app

## Specs

- [Schedules](../specs/schedules.md)
- [Clients](../specs/clients.md)
- [Conversation](../specs/conversation.md)

## Problem Statement

Schedules let Agents work on their own, but they exist only in the web app. The native app's Projects, Tasks, conversations, Wikis and settings cover everything else people do on a phone, so an Admin cannot create, pause or start a Schedule away from a desk, and a run's Task only reached the app through its push alert, without the Schedule around it.

## Solution

The native app gets a **Schedules** section, open to every User: a list of Schedules with the same information as the web app's, a page with the configuration and the run history, and, for Admins, the creation and edit form, Run now, Pause or Resume and Delete. A run's Task opens in the normal conversation view, inside its Schedule, read-only once the run is closed. The section follows the `schedule.changed` event and caches the list and each opened history for offline reading.

## Implementation Decisions

- The Schedules state lives in the app's one `TaskController`, as Projects and Wikis do: the list, the open Schedule, its runs and a `scheduleSection` flag. The controller subscribes to the `schedules` topic only while the section is open and refetches the list and the open Schedule on `schedule.changed`.
- The cron parser and its readable reading (`describeCron`) are ported from `shared/src/cron.ts`, so both clients show the same words. The backend keeps validating and scheduling.
- The time zone picker is a searchable list of IANA names embedded in the app (the platform does not expose the device's zone name), starting at `UTC`. The backend rejects an invalid value as before.
- Wide layouts show the rail, the list and the open Schedule or run; phones use successive screens (list, Schedule, run) with Back one level at a time, like Wikis.
- A run's Task reuses the conversation: the composer is kept while the run is Running, the conversation is read-only once it is closed, and the Task details, edit and delete actions are hidden because the scheduler owns it. Notifications about a run open it within its Schedule, matched by the Schedule Project id.
- The list and each opened run history are cached in the profile, like the other global lists, so the section reads offline; everything that changes data needs a connection.
- No backend changes: the existing `/schedules` API and the `schedule.changed` event were enough.

## Testing Decisions

- Controller tests against the fake API (Seam 1 of the project): the list loads and is cached; opening a Schedule loads its configuration and history; offline reopen reads the cache; Run now, pause, edit, create and delete; `schedule.changed` refetches; a skipped run opens nothing while a started one opens its Task; a closed run is read-only; a notification opens the run within its Schedule.
- Table-driven unit tests for the ported cron parser and `describeCron`, with the same cases the shared module handles.
- Widget tests for the list, the detail, the Member's read-only view and the Admin's actions, including the form's cron preview.

## Acceptance Criteria

- [x] The Schedules section is reachable from the drawer on phones and the rail on wide windows, for every User.
- [x] The list shows name, Agent, cadence in words, scope, read-only, next run, last outcome and, for Admins, the enabled switch.
- [x] Admins can create, edit, pause, resume, run now and delete a Schedule; other Users can only read.
- [x] The form validates the cron expression locally and shows its reading in words; an invalid value cannot be saved.
- [x] The detail shows the configuration, the prompt and the run history, with the run's Task Key on started runs.
- [x] A run's Task opens in the conversation view; it accepts Comments while running and is read-only once closed, with no Task edit or delete actions.
- [x] A skipped run has no link and shows its reason.
- [x] `schedule.changed` refreshes the list and the open Schedule; the list and opened histories read offline.
- [x] A push alert about a run opens it within its Schedule.
- [x] `flutter analyze` has no new issues and the new tests pass; the existing golden failures are the environment's, present before this change.

## Out of Scope

- A native preview of the last run's output.
- Managing a Schedule Project's Statuses or Tags from the native app.
- Editing the Schedule's Repository from the native app's Git administration; the form uses the same Repository list as a Wiki's.
