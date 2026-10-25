---
status: proposed
---

# Deliver comments to a running job by writing to stdin mid-turn

A comment on a task whose job is running gets written to the `claude` process's stdin right away as a stream-json user message, without waiting for the turn to end. The docs describe streaming input as supporting queued messages added to the running agent loop, so the agent should see the message at its next model call. **Not verified yet:** the first attempt hit an account spend limit. Before building the runner, the spike in Spec 02 has to confirm this behavior, the interrupt mechanism, what closing stdin after a `result` does, and `--session-id`/`--resume`, and record real stream fixtures for the tests. Then update this ADR to `accepted` with the findings.

## Consequences

- If mid-turn injection doesn't work, the fallback is to hold comments until the turn's `result` and then write them to stdin straight away, so they start the next turn in the same process. Nothing else in the design changes.
