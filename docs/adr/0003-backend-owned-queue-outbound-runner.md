---
status: accepted
---

# Backend owns the queue; the runner connects outbound and holds no state

All scheduling state (queue entries, sessions, jobs, comment delivery) lives in Postgres and is decided by the backend. The Go runner inside each agent container is stateless: it dials out to the backend over an authenticated WebSocket, executes the job it receives, and streams events back with seq/ack so they can be resent after a disconnect. Because of that, a container restart or a dropped connection never loses work: the backend sees a job without a result and enqueues a resume. And the same design works on a local Docker host today and on remote hosts or Kubernetes later, without exposing ports on agent containers.

## Considered Options

- **Backend calls into the container (HTTP/exec).** Rejected: it needs reachable ports or `docker exec` plumbing and ties the backend to Docker networking.
- **Queue inside the runner.** Rejected: state would be lost on container recreation and invisible to the UI.

## Consequences

- The runner protocol is a contract versioned together with the base image.
- Claude credentials and project env are sent per job, not baked into container env, so rotating them takes effect on the next job and project secrets reach only that project's tasks.
