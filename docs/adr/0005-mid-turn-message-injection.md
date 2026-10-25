---
status: proposed
---

# Deliver comments to a running job by writing to stdin mid-turn

A comment on a task whose job is running gets written to the `claude` process's stdin right away as a stream-json user message, without waiting for the turn to end. The docs describe streaming input as supporting queued messages added to the running agent loop, so the agent should see the message at its next model call. **Not verified yet:** the first attempt hit an account spend limit. Before building the runner, the spike in Spec 02 has to confirm this behavior, the interrupt mechanism, what closing stdin after a `result` does, and `--session-id`/`--resume`, and record real stream fixtures for the tests. Then update this ADR to `accepted` with the findings.

## Consequences

- If mid-turn injection doesn't work, the fallback is to hold comments until the turn's `result` and then write them to stdin straight away, so they start the next turn in the same process. Nothing else in the design changes.

## Verification attempt — 2026-10-25

Retried locally with Claude Code 2.1.310, a fresh `--session-id`, stream-json
input/output, `--verbose --include-partial-messages`, and a minimal reply request.
The organization still refuses model calls because its monthly spend limit was
reached. The CLI emitted a synthetic assistant refusal and a `result` with subtype
`success`, `is_error: true`, cost $0, then exited with code 1 after stdin closed.

No successful model turn ran, so this does not verify mid-turn input, interrupt,
successful stdin-close draining, session resume or thinking. This ADR remains
**proposed**. The Go runner's black-box tests cover those protocol paths against a
fake CLI; the production Docker smoke test confirms the real Base Image builds and
the real non-root runner connects. Neither substitutes for the real conversation
acceptance. See the remaining checks in [running and verification](../agents-runtime.md).
