---
status: done
---

# Project Skills in the composer

## Specs

- [Runner](../specs/runner.md)
- [Agent sessions](../specs/agent-sessions.md)
- [Clients](../specs/clients.md)

## Problem Statement

Typing `/` in the composer suggests the Agent's catalog Skills and some Claude commands, but not the skills and commands the repository carries in `.claude/skills` and `.claude/commands`, although `claude` loads them in the Worktree and the Agent can use them. The `slash_commands` list in `system/init` names them, but without descriptions and mixed with bundled skills, so the composer filters them out.

## Solution

- Right before starting `claude`, the Runner reads the Worktree's `.claude/skills/<name>/SKILL.md` and `.claude/commands/<name>.md` (symlinks followed only inside the Worktree) and sends their names and first 8 KiB in a new `job.project_skills` message.
- The backend parses them like catalog skills (frontmatter `description`, else first paragraph, `user-invocable: false` excluded), stores them on the Job and republishes the Session.
- The Session's commands add these Project Skills as Skills: the Agent's Skill wins on a shared name, and once `system/init` has reported, only Project Skills it lists are offered.

## User Stories

1. As a User, I want the composer to suggest the repository's own skills, so that I can invoke everything the Agent can see.
2. As a User, I want each suggestion to show the skill's description, so that I can tell them apart.
3. As a User, I want skills that are hidden from the `/` menu (`user-invocable: false`) or not loaded by the session left out, so that every suggestion works.

## Implementation Decisions

- Read in the Runner, at Job start, after the Setup Script: that's the set `claude` loads; reading the Base Branch through the Git Provider would miss Worktree changes.
- Raw file beginnings travel over the protocol and the backend parses them, reusing its YAML parser; the protocol version stays 3 because unknown messages are ignored on both sides.
- The Project Skills of the Session's latest Job that reported them are used, filtered by the latest reported `slash_commands`.

## Testing Decisions

- Runner black box: a Setup Script creates skills, a symlinked skill inside the Worktree, a symlink escaping it, an oversized file and commands; `job.project_skills` reports the expected names and heads before `claude` starts.
- Backend API: a fake runner reports Project Skills; the Session's commands include them with descriptions, exclude non-invocable, invalid and unavailable ones, and respect `slash_commands` once reported.
- Unit: `chatCommands` lets the Agent's Skill win over a Project Skill of the same name.

## Acceptance Criteria

- [x] The Runner reports the Worktree's skills and commands before starting `claude`.
- [x] The composer suggests them with their descriptions, as Skills.
- [x] Non-invocable, unloaded and conflicting Project Skills are handled as described.
- [x] Specs, glossary and manual are updated.
