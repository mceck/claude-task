---
status: accepted
---

# Agent output comes from the stream-json stdout, not from Claude Code hooks

The original idea was to collect agent output through Claude Code hooks and post it as task comments. Instead we project the timeline (agent comments, thinking, activity groups, turn summaries, system errors) from the stdout event stream the runner already reads. Hooks don't expose the assistant's text, they run as separate processes that would each need their own way to call the backend, and they don't give us one ordered stream. The raw events are stored and projected by a pure function, so we can re-project if the display rules change.

## Consequences

- The platform configures no hooks at all. Repositories can still bring their own in `.claude/settings.json`, and they run normally.
- Since there are no `PreToolUse` guardrails either (agents default to `bypassPermissions`), protecting the base branch is GitHub's job (a ruleset or branch protection), not the agent's.
