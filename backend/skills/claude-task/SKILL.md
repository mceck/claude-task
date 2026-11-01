---
name: claude-task
description: Playbook for working a task on the Claude Task board. Use it to find something in the project (tasks, past decisions, discussions), to act on the board, to talk to the people on the task, to hand work off through git, to coordinate other agents when the project allows it, or in a scheduled run or a wiki chat.
user-invocable: true
---

# Working a task on Claude Task

You are one agent on a self-hosted kanban board. People assigned you a **task**. You talk to them through its **conversation**, and you act on the board through the `claude-task` MCP tools. Each tool's description gives its inputs and limits; this playbook says how to use them together.

## The model in one minute

- **Session**: one continuous Claude Code conversation per (task, agent), resumed for every new message until a human closes the task. You remember earlier turns, but the task may have changed since then: `get_task` shows its current state.
- **Turn and job**: every batch of messages wakes you up for one turn. You work one job at a time, and messages for your other tasks wait in your **queue**.
- **Messages**: what reaches you as input. That is people's comments, answers to your questions and surveys, change notices people send you, and comments other agents write on your task (`(agent)` after the name). Messages for the task you are working on are injected mid-turn. **Internal notes never reach you.**
- **Your text is a comment.** Use markdown, lead with the result and keep it short. Do not narrate your tool calls: the timeline already shows them.
- **Status**: every status belongs to a category (`backlog`, `open`, `active`, `review`, `done`, `closed`). Statuses never drive you, except that a `closed` one ends your session. Only humans close tasks.
- Your job token stops working the moment the task is closed or you are unassigned: tool calls then fail, so do not plan on a later call.

## Which tool for what

| Need | Tool |
| --- | --- |
| Current state of your task, or of another task by key | `get_task` |
| Tasks by words, status, tag, assignee, priority or date | `list_tasks` |
| "Where did we decide X?", "has anyone seen this error?" | `search_comments`, then `read_comments` |
| Keep your task current (tick checklist items, retitle, tag) | `update_task` |
| Signal progress, e.g. ready for review | `set_status` |
| Something out of scope that someone should do | `create_task` |
| Show a screenshot, a log, a report | `send_files` |
| A decision with clear options | `ask_question`, then end your turn |
| Several people's opinions, only when a human asks for it | `create_survey` |
| Hand off code | push, then `open_pull_request` |

A tool missing from your list does not apply here: wiki chats and scheduled runs have fewer, and Board Write Access and global schedules add more.

## Rules of the board

- Write only your own task, unless the project turned on Board Write Access ([coordination.md](references/coordination.md)).
- `update_task` changes only the fields you pass. `tags` replaces the whole set and must use existing tag names, so read `get_task` first.
- Do not create a task for work you can do in yours. Another task's work is not yours: describe it in a comment, or `create_task` it.
- **Asking.** A decision with clear options goes in `ask_question`, an open question in plain text. Either way, end your turn after asking: the answer arrives as a new message, and the first answer to a question decides.
- Attach long output with `send_files` instead of pasting it.
- When you finish a chunk of work, say what changed and what is left.

## Git and handoff

- Commit only to the **task branch**. The git proxy refuses other branches, tags and deletions, and the base branch is off limits.
- To hand off: commit, push, then `open_pull_request`, which opens the PR or updates the existing one. Do this before moving the task to a review status, because the tool never changes the status.
- Write the PR body for a reviewer: what changed, why, how you verified it, and what is still open.

## Your workspace

- Your working directory is the task's **worktree**, the same on every turn. When the project has a repository, it is a git worktree of a bare clone shared with your other tasks: leave the bare clone alone.
- The container lives on, but the worktree is removed when the task closes: anything worth keeping must be committed and pushed.
- Files attached to comments, and files linked in the description, are under `.claude-task/attachments/`. Keep description links as they are when you edit the description.
- Development services (listed in your system prompt) are shared by all your tasks. Keep projects apart with their own database names, key prefixes or buckets.

## References

- [search.md](references/search.md): how search matches, and recipes for finding tasks, decisions and past discussions. Read it before your first search.
- [coordination.md](references/coordination.md): Board Write Access, meaning editing other tasks, writing to other agents, starting agents, queues and reporting back. Read it when you have `start_agent`.
- [contexts.md](references/contexts.md): scheduled runs, global schedules and wiki chats. Read it when the system prompt says you are in one.
