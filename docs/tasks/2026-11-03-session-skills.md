---
status: done
---

# Session Skills in the Task view

## Specs

- [Agents](../specs/agents.md) (Extensions, Skills)
- [Clients](../specs/clients.md) (Web app, Native app)
- [Conversation](../specs/conversation.md) (slash commands)
- [Agent sessions](../specs/agent-sessions.md) (Timeline projection)

## Problem

A Session offers the Agent's Skills and the Worktree's Project Skills, and either the User (`/name` in a Comment) or the Agent (Claude Code's `Skill` tool) can activate them. Nothing showed which ones had actually been used, so a User couldn't tell whether a Skill the Agent was given had any effect, or whether the Agent reached for the right one.

## Solution

- **Backend**: `GET /tasks/:id/skills` returns the Session's Skills, each with the ways it was activated (`user`, `agent` or both). The catalog is the Session's slash-command menu (Agent Skills and Project Skills, kind `skill`). Agent activation comes from the Session's stored raw events: assistant `tool_use` blocks named `Skill`, with the `skill` (or `command`) input, subagent Runs included. User activation comes from non-internal User Comments that start with a slash command. A Skill the Agent activated but the catalog doesn't list (a bundled or Plugin Skill) is included too. Used Skills come first, then alphabetical.
- **Web**: a **Skills** item in the Task actions menu opens a dialog with a two-column grid of cards, each with an empty dot (not used) or a filled one (used), the Skill's name and description, and a footer with "n of m used".
- **Native app**: the same item in the Task's actions menu opens a sheet with the same grid.

## Decisions

- **Derive usage from what is already stored, with no new write path.** The raw events hold every `Skill` tool call and the Comments hold every slash command, so the answer can't drift from the conversation. The dialog is opened on demand, so the scan is paid only then.
- **Activated Skills first.** The point of the window is reviewing what was used; unused Skills stay visible below as the remaining catalog, and a used Skill the catalog doesn't know is never hidden.
- **A dot, not a score.** The request was a binary used/not used; the card's tooltip distinguishes a manual activation from the Agent's, and both at once.
- **Same list for both clients.** The ordering and the payload are decided by the backend, so the web grid and the native sheet can't disagree.

## Acceptance criteria

- [x] `GET /tasks/:id/skills` lists the Session's Skills with `usedBy` for manual and Agent activation.
- [x] Agent activation is read from stored `Skill` tool calls, subagent Runs included; manual activation from User slash commands, deleted and internal Comments excluded.
- [x] A used Skill outside the catalog appears; used Skills come first and the rest are alphabetical.
- [x] Web and native show the grid with empty and filled dots, descriptions, count and the no-Skills state.
- [x] Backend and native tests cover the list, the ordering, the unlisted Skill and the empty state.
