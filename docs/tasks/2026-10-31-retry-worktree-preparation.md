---
status: done
---

# Retry a failed Worktree preparation

## Specs

- [Runner](../specs/runner.md) (Preparing the Worktree)
- [Git integration](../specs/git-integration.md) (Git Proxy, Authentication)
- [Agent sessions](../specs/agent-sessions.md) (Failures, Retry)

## Problem

Every now and then a Job failed before starting, always the same way:

```
The agent couldn't start: preparing the worktree failed.

> git fetch --prune origin: exit status 128
remote: no active task for this repository
fatal: unable to access '…/git/<project>.git/': The requested URL returned error: 403
```

Pressing **Retry** almost always fixed it, which pointed at a race and not at a broken Repository. The Runner sends `job.accepted` and starts preparing the Worktree without waiting for the backend to process that message; the Git Proxy only admitted Jobs that were `running` or `finishing`. When the fetch reached the backend before the acceptance had been committed, the Job still read as `dispatched` and the proxy refused the fetch with `403`.

The fair retry that followed also hid a second problem: preparation was attempted once. Any other one-off failure of the same steps — a provider blip, the backend restarting — failed the Job the same way and left it waiting for a human to press Retry.

## Solution

- The Git Proxy admits the Job token of any active Job — `dispatched`, `running` or `finishing`. The token of a dispatched Job exists only in the `job.start` sent to its Runner, so admitting it exposes nothing new, and the first fetch of a Job now always finds its Job active.
- The Runner retries a failed Worktree preparation up to 3 times, waiting 1, 2 and 4 seconds with up to 50% of jitter. Every attempt repeats the whole preparation, which is idempotent. Each retry is announced in the setup output, so the System Comment of a failure that survives the retries shows what was tried.

## Decisions

- Fix the proxy instead of making the Runner wait for an acknowledgement: a Job whose Runner is already preparing its Worktree is active, and ordering two protocols to save a state check would be fragile in the other direction too.
- Retry in the Runner and not in the backend: the backend would dispatch a whole new Job, with a new token and a new acceptance round trip, for something the Runner can repeat locally. A retried attempt keeps the same Job, the same Chat and the same setup output.
- The retries cover the whole preparation, not just `git fetch`: clone, worktree creation and configuration fail the same way for the same reasons.
- The delays are bounded (about 7 to 10 seconds in the worst case) because a genuine mistake — a bad Repository, a broken Git Connection — must still surface quickly, and the Job's Comments wait in a held Queue Entry meanwhile.
- A cancel stops the wait at once: closing a Task must not keep its Runner busy for a retry it will never need.

## Acceptance criteria

- [x] The Git Proxy serves the Job token of a Job in `dispatched`, `running` and `finishing`, and refuses it once the Job is over or its output is being discarded.
- [x] A Worktree preparation that fails once succeeds on a retry, with the retry announced in the Job's setup output.
- [x] After 3 failed retries the Job fails at stage `worktree` as before, with the error and the setup output.
- [x] A cancel during the wait ends the Job as cancelled without waiting for the delay.
- [x] Backend and Runner tests cover the admitted state and the retry.
