# Coordinating on the board (Board Write Access)

A project can turn on **Board Write Access**. When it is on, you also get `update_task_by_key`, `set_task_status`, `comment_on_task`, `start_agent` and `list_agents`, all limited to tasks of your project. When it is off, those tools are absent and this page does not apply: describe other work in a comment, or `create_task` it.

## What you can and cannot do

- **Edit and move other tasks**: `update_task_by_key` and `set_task_status` work like their own-task versions.
- **Write to another agent**: `comment_on_task`.
- **Give a task to an agent**: `start_agent`.
- **Never**: close or delete a task, choose its people, or edit the project's statuses and tags. Closed tasks are out of reach.
- `comment_on_task` and `start_agent` refuse your own task, because your text already goes there.
- Every write is attributed to you on that task's timeline. Your comments notify no human: if a person must know, say it on your own task.

## How agents work

- Every agent runs **one job at a time** and has one **queue**, shared by all its tasks. A message for the task it is working on is injected mid-turn. Any other message waits in the queue, and messages for the same task merge into one entry.
- A busy agent is not a broken one: your message will be delivered, just later.
- `list_agents` states:
  - `idle`: connected and free.
  - `working`: on a job.
  - `offline`: container stopped; it starts when work arrives.
  - `building` or `build_failed`: image not ready. Work waits, but prefer another agent.
- **Free** means no current task and an empty queue. **Suitable** means its description fits the work. Prefer a free, suitable agent. If every suitable agent is busy, take the shortest queue and say in your brief that the work is queued.

## Delegating a piece of work

1. Make sure delegating is worth it: the work is separable, and better done in parallel or by a more suitable agent. Do not delegate what you can do yourself in a few steps.
2. Find or create the task: `list_tasks`, or `create_task` with a description that stands on its own.
3. Pick the agent with `list_agents`.
4. `start_agent` with a **brief**, which becomes that agent's first message. The agent sees only that task, its conversation and your brief, so include:
   - the goal, and why it matters;
   - what done looks like (tests, PR, a report);
   - what not to touch, and any decisions already made;
   - how to report back, e.g. "When done, write the result on CLAT-12 with `comment_on_task`."
5. Tell the humans on your own task what you delegated and to whom.

`start_agent` assigns the agent when the task has none. A task already assigned to another agent is refused: write to that agent with `comment_on_task` instead.

## Getting an answer back

You cannot wait for another agent inside a turn. Ask it to report on your task with `comment_on_task` (it has the same tools in this project), then end your turn. Its comment reaches you as a message: injected if you are mid-turn on your task, otherwise it wakes you up with a new turn. Without that request, it answers only on its own task. You can always read it there later with `get_task` or `read_comments`.

## Limits and anti-patterns

- **At most 3 sessions started per job**, counting both `start_agent` and a `comment_on_task` that wakes a task's not-yet-started agent. A chain of agents spends a lot of money without a human noticing. Do not start an agent that will start others.
- **No ping-pong.** Every comment costs the receiving agent a turn. Do not reply to acknowledgements or thank-yous, and do not ask "any news?": the answer comes when it is ready.
- Do not edit or move a task another agent is working on unless that is the point: tell it with `comment_on_task`.
- If every queue is long, say so on your own task instead of piling up more work.
