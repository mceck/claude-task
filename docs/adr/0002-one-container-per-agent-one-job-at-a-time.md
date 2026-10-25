---
status: accepted
---

# One long-lived container per agent, one job at a time

Each Agent is a global worker (assignable to tasks in any project) that runs as one long-lived Docker container with its own named volume. The volume holds the bare clones, one git worktree per task, and the Claude config dir with session transcripts. The agent runs at most one job at a time, and everything else waits in its queue. We picked this to keep an agent's behavior easy to reason about ("one worker, one thing at a time"), and because the agent's Dockerfile, not the project's, defines the toolchains. If you need more throughput, add more agents (e.g. duplicate one), not more concurrency inside one agent.

## Considered Options

- **One container per task** (best isolation, sleep when idle, resume on demand). Rejected: more images and volumes to manage, and it doesn't match the "an agent is a teammate" model.
- **One container per project, shared by its agents.** Rejected: agents are global and bring their own environment.
- **N parallel sessions per agent.** Rejected: tasks in the same container would share ports, local databases and background processes.

## Consequences

- Feedback on a task the agent isn't currently running can wait behind a long job. Members can reorder the queue by hand.
- Sessions survive container rebuilds only because they live on the volume. Deleting an agent deletes its transcripts. The raw event stream in Postgres stays as the durable record.
- `--resume` must run in the same cwd, so worktree paths are deterministic per (project, task).
