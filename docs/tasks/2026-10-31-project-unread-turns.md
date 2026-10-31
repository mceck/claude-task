---
status: done
---

# Project badge counts unread Turns

## Specs

- [Conversation](../specs/conversation.md) (Read position and unread, Project aggregation)
- [Clients](../specs/clients.md) (Navigation, Projects list)
- [Board](../specs/board.md) (Projects: Listing)

The manual page [Organize work in Projects and Boards](../manual/projects-and-boards.md) describes the sidebar badge.

## Problem

The Projects list and the sidebar badge count a Task as unread for any Timeline entry newer than the read position. Routine Comments, Revisions and Thinking items light the badge even when no Agent Turn has finished, so the count does not answer "where did an Agent finish something I have not read".

## Solution

`ProjectSummary.activity.unreadTasks` counts open Tasks with at least one Turn Summary after the User's read position. A Turn Summary closes every Turn, successful, failed or interrupted, so failed Turns count. Muted Tasks and Tasks in a `closed` Status stay out. The Task's own unread state, `unreadComments`, the Board cards, the Chat Dock and Wiki Chat indicators keep the existing rule over every Timeline entry.

The web sidebar and Projects page badges, and the native Projects list badge, show this count. Tooltips name it as Tasks with unread Turns.

## Decisions

- The Project badge follows Turn Summaries, not Comments or Revisions: it reports finished Agent work rather than every conversation change.
- Failed Turns count: a failure is the outcome most worth noticing.
- Only the Project activity changes. Task-level unread state keeps every entry, so opening a Task still works as before.

## Acceptance criteria

- [x] A Task with a finished Turn after the read position raises its Project's `unreadTasks`.
- [x] A failed Turn raises it too.
- [x] Comments and Revisions alone leave the Project badge unchanged while the Task itself stays unread.
- [x] Reading the Turn Summary, muting the Task or moving it to a `closed` Status clears the Project badge; unmuting or reopening restores it.
- [x] Backend and Playwright tests cover the rule.
- [x] Specs and the manual describe the new rule.
