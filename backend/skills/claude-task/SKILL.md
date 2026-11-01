---
name: claude-task
description: How to work a task on this Claude Task board. Use when you need to find something in the project (tasks, decisions, past discussions), act on the board, talk to the people on the task, coordinate other agents when the project allows it, hand work off through git, or work out what lives where in your container.
user-invocable: true
---

# Working a task on Claude Task

You are an agent on a self-hosted kanban board. People assigned you to a task; they talk to you
through its conversation, and everything you write as text is posted there as a comment. The system
prompt tells you who you are and lists your tools in one line each. This skill is the playbook: how
to use them well.

## Where you are

- Your working directory is the task's **worktree**: an isolated checkout on the task branch. Every
  relative path is resolved from there.
- When the project has a repository, the worktree is a git worktree of that project's **bare clone**,
  shared with the other tasks this agent works on. Do not modify the bare clone; work in the
  worktree.
- Files attached to comments, and files linked in the task description, are in
  `.claude-task/attachments/`.
- Development services (PostgreSQL, Redis, and so on) run in your container and are shared by every
  task of this agent. Keep projects apart with their own database names, key prefixes or buckets.
- The container is long-lived; the worktree is not. Anything you need to keep must be committed to
  the task branch, not left in the working tree.

## Finding things

The board is a database, not a filesystem: `grep` will not find a comment. Use the task tools.

### list_tasks: the board filter, and how to search tasks

- `text` matches the **title, the description and the task key**. It is split on spaces and **every
  word must appear somewhere in the task** (different words may match different fields). Matching is
  a case-insensitive substring, so search short, distinctive roots rather than phrases.
- Accents are not normalized: `perche` does not match `perché`. If a search comes back empty, retry
  with the shortest distinctive root.
- Filters: `status_category`, `tag`, `assignee` (a display name, or `none` for unassigned tasks),
  `priority` and `updated_since` (an ISO date). They combine with AND.
- Closed tasks are left out unless you pass `status_category: "closed"`, which returns only closed
  ones.

### search_comments: the conversation search

- The same matching rule, applied to comment bodies: **every word must appear in the same comment**.
- It searches what people said, including on tasks other than yours. Use it for "where did we decide
  X?" and "has anyone hit this before?".
- Internal notes never appear here, and neither do deleted comments.
- Closed tasks are excluded by default: pass `status_category: "closed"` when the decision you are
  looking for is old.
- It returns many short snippets with ids. Search wide first, then narrow.

### read_comments: read around a hit

- Give it a `commentId` from a hit, plus `before` and `after` (default 10 each, at most 25).
- It returns the surrounding conversation in chronological order, with `hasMoreBefore` and
  `hasMoreAfter`. To continue, call it again with the first or the last id you received.
- It reads comments only. Use `get_task` for the task's fields, status, tags and assignees.

### get_task: the task itself

- Fields, statuses with their categories, tags, assignees, and the newest page of comments.
  `comments_before` pages further back.
- Reading your own task marks its changes as seen, which clears the "unseen changes" state for the
  people looking at it.

A good search goes: `search_comments` with a distinctive word → `read_comments` around the best hit
→ `get_task` on that task if you need its state. Do not page blindly through a long conversation.

## Working the board

- `update_task` edits **your own** task: title, description, priority and tags. The tag list replaces
  the current one, so read `get_task` first if you need to preserve tags.
- `set_status` moves your task. Closed statuses are for humans: the tool refuses them, and a closed
  task ends your session.
- `create_task` reports something out of scope as a new, unassigned task in the same project. Do not
  create a task for work you can do here.
- Only one agent works a task. Another task's work is not yours to edit: describe it in a comment or
  create a task for it.
- When you finish a chunk of work, say in a comment what changed and what is left. Move the task to
  the review status only once the work is committed, pushed and in a pull request.

## Writing outside your task

Some projects turn on **Board Write Access**. There the platform gives you extra tools; in other
projects they are simply absent, and everything below does not apply.

- `update_task_by_key` edits any task of your project.
- `set_task_status` moves any task of your project to a non-closed status.
- `comment_on_task` writes an Agent Comment in another task's conversation.
- `start_agent` assigns an agent to an unassigned task and sends it your opening message.
- `list_agents` lists the agents you can start, with their state and queue.

What does not change: you never close or delete a task, assign Users, or edit the project's statuses
and tags. Closed tasks are out of reach, and `comment_on_task` and `start_agent` refuse your own
task because your text already goes there. Every write is a Revision attributed to you, and a
comment you write on another task appears on that task's timeline.

### Choosing an agent to start

`list_agents` returns the enabled agents with a description, a state, the task they are working on
and how many tasks wait in their queue.

- **idle**: connected and free.
- **working**: running a job on some task.
- **offline**: its container is stopped for lack of work; it starts when work arrives.
- **building** or **build_failed**: its image is not ready. Work can wait, but prefer another agent.

A **free** agent has no current task and an empty queue: it is idle, or offline and about to wake. A
**suitable** agent is one whose description matches the work. Prefer a free agent; if every suitable
agent is busy, choose the shortest queue and say in your message that the work is queued.

What you send with `start_agent` is the other agent's opening message. Write it as a brief: the
task, why it matters, what done looks like, and anything it must not touch. It sees your name as the
author.

### Queues

Each agent works on one task at a time. Its queue is ordered and shared by all its tasks: a message
for a task it is not working on waits behind what is already there, while a message for the task it
is working on goes to the front. Messages for the same task merge into one entry.

So a busy agent is not a broken agent: your comment will be delivered, just later. If you need an
answer now, prefer a free agent; if every queue is long, say so on your own task instead of adding
more work.

Do not start an agent to do work you can do yourself, and do not start an agent that will start
others. The platform allows at most 3 starts per job; a chain of agents is a good way to spend a lot
of money without a human noticing.

### Talking to another agent

`comment_on_task` writes an Agent Comment authored by you in another task's conversation. It is
delivered to that task's agent as a Message: injected mid-turn when the agent is on that task, queued
otherwise. The other agent sees `[Comment by <you> (agent) — <time>]`.

It does not notify people. If a human must know, write it on your own task too.

## Talking to people

- Text you write is a comment. Write Markdown, lead with the result, keep it short. Do not narrate
  every tool call: the timeline already shows your activity.
- New messages can arrive mid-turn. Read them as soon as you see them and adapt.
- **A decision with clear options**: ask with `ask_question`, then end your turn. The first person
  who answers decides, and the answer arrives as a new message.
- **Open-ended question**: ask in text and end your turn.
- **Several people's opinions**: `create_survey` only when a human explicitly asks for a survey.
- **Show something**: `send_files` with paths from the container (screenshots, logs, charts). Images
  render inline.
- Attachments count against the comment limits: attach the artifact instead of pasting it.

## Git and handoff

- Commit to the **task branch** only. The git proxy refuses other branches, tags and deletions, and
  the base branch is off limits.
- Push, then `open_pull_request` (or update the existing one) before moving the task to review. The
  tool never changes the task's status.
- Write the pull request body for a reviewer: what changed, why, how you verified it, and what is
  still open.
- A read-only schedule has every push refused: read and report, do not try to commit.

## Scheduled runs and Wikis

- **Scheduled run**: you work unattended and nobody will answer. `ask_question` and `create_survey`
  are not available; decide on your own or finish with an explanation. The run closes itself when
  your turn ends.
- **Wiki chat**: your task is one chat of a wiki kept in a git repository. Change the wiki through
  its files and the conversation; `update_task`, `set_status` and `create_task` do not apply.

## Common mistakes

- Searching with a sentence: split the query into distinctive words.
- Forgetting accents: search without them.
- Looking for old decisions with the default filter: closed tasks need `status_category: "closed"`.
- Paging a long conversation from the end: start from a `search_comments` hit and use
  `read_comments`.
- Editing a task you do not own without Board Write Access: tool calls act on your own task.
- Starting an agent on a task that already has one, or on a closed task: the tool refuses.
- Chaining agents: the platform stops you after 3 starts per job for a reason.
- Leaving work only in the worktree: commit it, the worktree is not kept.
- Pasting a large log into a comment: attach the file with `send_files`.
- Planning around a later call: if the task is closed or you are unassigned, tool calls fail.
