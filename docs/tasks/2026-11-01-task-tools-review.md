---
status: done
---

# Task Tools review

## Specs

- [Agent Sessions](../specs/agent-sessions.md) (System prompt composition, Task Tools, Writing to the board, Decisions)
- [Schedules](../specs/schedules.md) (Global Schedules and the global Task Tools, Runs without a person)
- [Agents](../specs/agents.md) (Platform Skill)
- [Wikis](../specs/wikis.md)

## Problem

The way an Agent learns to use the board grew in three places that repeated each other. Each tool had its MCP description, the system prompt listed the tools again in one line each, and the `claude-task` Platform Skill explained them a third time in about 180 lines, including sections that do not apply to most Tasks. The copies had started to drift, and the system prompt's list cost context on every Turn.

The implementation had grown too. The Task Tools server was one file of about 1,000 lines with three copies of "edit or move a Task by key". The global Schedule tools and the Board Write Access tools had diverged:
- the global edits reached closed Tasks;
- `start_task` posted a User Comment as `System`, which the spec had already rejected for `start_agent`.

Some tools were offered where they always fail: the own-Task tools in Wiki Chats and Scheduled Runs, and `open_pull_request` without a Repository or in a read-only Schedule.

Agent Comments queued for another Agent (`start_agent` to a busy or not yet started Agent) never received a Delivery state, so their badge stayed empty.

## Solution

- **One place for each kind of information.**
  - The system prompt keeps identity, place and the rules of the board, and only mentions the extra powers of Board Write Access and global Schedules. It points to the skill only when the Agent has it.
  - Each tool's description states what it does, what it answers and its limits, and its inputs carry descriptions.
  - The skill is an index (`SKILL.md`) with reference files: `references/search.md`, `references/coordination.md` and `references/contexts.md`.
- **Tools only where they work.** The server builds the tool list per Job:
  - own-Task writes only in ordinary Projects;
  - questions only outside Scheduled Runs;
  - `open_pull_request` only with a Repository and outside read-only Schedules.
- **One contract for cross-Task writes.**
  - `update_task_by_key` and `set_task_status` are shared by Board Write Access and global Schedules, and refuse closed Tasks.
  - `assign_task_to_me` refuses closed Tasks too.
  - `start_task` posts an Agent Comment by the Agent, delivered like `start_agent`'s.
  - A `comment_on_task` that wakes a pending Session counts as a start, so it cannot bypass the limit of three. A second message to a Session whose first Message is already queued is not counted again.
- **Delivery for queued Agent Comments.** The Queue recognises an Agent Comment written through the Task Tools by its Job, which belongs to another Task. Such a Comment becomes queued, then delivered, then handled, like a User Comment.
- **Server split into modules.** `scope.ts` (Job token, active Job), `tool.ts` (results, shared inputs), `tasks.ts`, `conversation.ts`, `agents.ts`, `global.ts`, and `server.ts` for the composition and the routes. Answers are compact JSON, and unexpected errors are logged.

## Decisions

- **The tool list is the contract.** It is better not to offer a tool than to refuse it at call time. See the decision in Agent Sessions.
- **System prompt, tool descriptions and skill each say one thing.** See the decision in Agent Sessions.
- **References loaded on demand.** Board Write Access, Scheduled Runs and Wikis concern few Tasks, so their guidance does not load with every skill read.

## Acceptance criteria

- [x] The system prompt lists no tools, mentions Board Write Access and global powers only when they apply, and points to the skill only when the Agent has it.
- [x] Every tool and every non-obvious input has a description.
- [x] Wiki Chats and Scheduled Runs are not offered `update_task`, `set_status` and `create_task`. Projects without a Repository and read-only Schedules are not offered `open_pull_request`.
- [x] Global `update_task_by_key`, `set_task_status` and `assign_task_to_me` refuse closed Tasks. `start_task` posts an Agent Comment by the Agent.
- [x] A `start_agent` message for a busy Agent goes from queued to delivered to handled.
- [x] A `comment_on_task` that wakes a pending Session counts towards the three starts.
- [x] The Platform Skill ships `SKILL.md` and its three references.
