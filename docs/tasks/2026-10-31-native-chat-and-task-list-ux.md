---
status: in-progress
---

# Native app: chat polish and Task list actions

## Specs

- [Clients](../specs/clients.md)
- [Board](../specs/board.md)
- [Conversation](../specs/conversation.md)

## Problem Statement

The native chat header, composer and Task list had rough edges: Stop looked like a Session state, the schedule button took composer space, Enter could not start a new line on phones, older entries needed a manual button, Voice Rooms were always on, and the Task list had no way to act on Tasks (close, delete, move, reorder, several at once).

## Solution

Chat: spinner while the Timeline loads, automatic loading of older entries, Stop as a red circled icon beside the title, Close Task in the header, Mute in the menu, the `/schedule` system command in place of the schedule button, Enter as new line on phones, and Voice Rooms behind the `VOICE_ROOMS` build flag (off by default). Task list: long-press/right-click menu, multi-selection with bulk Move, Close and Delete, and drag and drop to change Status and reorder.

## Implementation Decisions

- Bulk actions get one backend endpoint (`POST /projects/:id/tasks/bulk`) that handles each Task on its own and reports failures per Task, so the client never loops over requests.
- A long press and a drag share one gesture on touch screens: letting go without moving opens the menu, moving starts the drag. Mouse users drag at once and right click for the menu.
- Reordering is disabled while the list is filtered, since neighbours are then ambiguous.

## Acceptance Criteria

- [x] Spinner while the first Timeline page loads and while older entries load.
- [x] Stop is an icon-only red circled button beside the title while the Agent runs.
- [x] Voice Rooms appear only in builds with `--dart-define=VOICE_ROOMS=true`.
- [x] Enter inserts a new line on phone keyboards.
- [x] Close Task is in the chat header; Mute is in the actions menu.
- [x] `/schedule` appears in the hints as System and opens the picker, also when sent alone; the schedule button is gone.
- [x] Task rows have a long-press / right-click menu (Select, Close, Delete).
- [x] Drag and drop changes Status and order.
- [x] Multi-selection with Move, Close and Delete through the bulk endpoint.
