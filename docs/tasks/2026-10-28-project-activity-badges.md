---
status: done
---

# Project activity badges

## Specs

- [Clients](../specs/clients.md) (Projects list indicators)
- [Conversation](../specs/conversation.md) (unread aggregated per Project)

## Problem

In the Projects list there was no way to tell which Projects have Agents running or unread conversations.

## Solution

`ProjectSummary.activity` carries `runningAgents` (Sessions in `running`) and `unreadTasks` (Tasks unread for the User). The web and native lists show a green dot when `runningAgents > 0` and a count badge when `unreadTasks > 0`.

## Decisions

- Unread is counted in Tasks, not messages.
- Muted Tasks and Tasks in a `closed` Status are excluded.
- Running is only a dot, no count or names.

## Acceptance criteria

- A Project with an unread open Task shows the badge for that User only; reading or muting clears it.
- A Project with a running Session shows the dot.
