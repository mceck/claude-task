---
status: done
---

# Project summary in the sidebar

## Specs

- [Clients](../specs/clients.md) (Navigation, Projects list)
- [Board](../specs/board.md) (Projects: Listing)
- [Conversation](../specs/conversation.md) (unread, aggregated per Project)

The manual page [Organize work in Projects and Boards](../manual/projects-and-boards.md) gains a section on reading Project activity from the sidebar.

## Problem

The sidebar's Boards list only shows each Project's logo and name. To know how much work is left, whether an Agent is running or whether there are unread conversations, a User has to open the Projects page or enter every Board.

## Solution

Each entry of the sidebar's Boards list carries the Project's state, staying compact:

- a thin stacked bar under the name with the Project cards' open, review and done split;
- the open Tasks over that total on the right of the bar (`7/23`), with the per-state counts in its tooltip;
- a green dot while an Agent Session of the Project is running;
- an orange message icon with the count of Tasks that have unread entries for the User, styled like the unread Comment indicator of the Task cards.

Projects without Tasks keep a single line. The Projects page cards are unchanged.

## Decisions

- The bar groups Categories exactly as the Project cards and the native Projects list do: backlog and active count as open, closed Tasks are left out. Three segments stay legible at 3 px; showing every Category would not.
- The number is open over total, so the row answers both "how much is left" and "how big is the Project" without a second number.
- The indicators reuse `ProjectSummary.activity` (`runningAgents`, `unreadTasks`) and `taskCounts`; no API or backend change.
- The progress colors and grouping move from `ProjectsPage` to `lib/progress.ts`, shared with the sidebar entry.
- The sidebar is not on a live topic, so the indicators follow the existing 15-second refetch of the Projects list.

## Acceptance criteria

- [x] A Project with Tasks shows a stacked open/review/done bar and an open/total count in the sidebar.
- [x] A Project with a running Session shows the green dot; a Project with unread Tasks shows the orange icon and count.
- [x] A Project without Tasks stays on one compact line; indicators are hidden when empty.
- [x] The Projects page cards keep their current bar, percentage and indicators.
- [x] Specs and the manual describe the new sidebar summary.
- [x] A Playwright test covers the bar and count in the Boards list.
