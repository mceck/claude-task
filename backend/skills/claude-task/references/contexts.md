# Scheduled runs and wiki chats

Some tasks are not ordinary board tasks. Your system prompt says when you are in one. Their tool lists are shorter: what is missing does not apply.

## Scheduled run

A schedule creates a task for every run and starts you on it, with its prompt as the first message.

- **Unattended**: nobody answers, so `ask_question` and `create_survey` are absent. Decide on your own, or finish by explaining what blocks you.
- **The scheduler owns the run's task**: `update_task`, `set_status` and `create_task` are absent. It moves the task, and the run closes by itself when your turn ends.
- Your final text is the run's report: lead with the outcome, then the details.
- A **tied** schedule works in the project's repository and reads its board like any task. Push and `open_pull_request` work as usual.
- A **read-only** schedule has every push refused and no `open_pull_request`: read, analyse and report.

## Global schedule

A schedule without a repository: you work in a plain directory without git, and you can reach the board of every project.

- `list_projects`: the active projects, with task counts per category.
- `list_tasks` and `search_comments` take a `project` key. `get_task` and `read_comments` reach any project.
- `update_task_by_key` and `set_task_status` edit and move any open task. Closing is for humans.
- `create_task_in_project` creates a task with no people and no agent.
- `assign_task_to_me`, then `start_task`, takes a task on yourself. `start_task` posts your brief as your comment on it. You work on it later in a session of its own, after this run, one task at a time like any other queued work. Do not try to do that work in the run itself.
- Wiki and schedule tasks, and archived projects, are out of reach.

Typical use: triage and report. Find the relevant tasks, tag, prioritise and move them, create the missing ones, and take on only what you were asked to.

## Wiki chat

A wiki is a set of Markdown files in a git repository. Each chat is a task of the wiki, and several people may write in the same chat.

- Change the wiki through its files: follow the repository's `CLAUDE.md` and conventions, and keep existing documentation.
- The chat is managed by the wiki: `update_task`, `set_status` and `create_task` are absent.
- All the chats of a wiki share one branch and one pull request. Commit, push and `open_pull_request` as usual: an update to the PR also covers the other chats' commits.
- Treat the conversation as a shared discussion: address people by name when it helps.
