---
status: accepted
---

# Run agents as headless `claude -p` with stream-json I/O

Agents need a Claude Code session per task that runs for days, takes human messages while it's working, and reports everything it does back to the task. We run the `claude` CLI in headless mode (`-p --input-format stream-json --output-format stream-json`), one process per job, driven by our own runner over stdin and stdout, and resume sessions with `--resume <session-id>`. It's the real Claude Code binary, so CLAUDE.md, project settings, skills and `.mcp.json` load as usual. Input and output are structured. And it's the documented headless path that also works with a subscription token from `claude setup-token`.

## Considered Options

- **Interactive TUI in a PTY/tmux, with input sent as keystrokes and output read from hooks.** Rejected: simulated typing breaks on permission prompts, dialogs and multiline text, it's hard to tell whether the agent is busy, and hooks don't carry the assistant's text.
- **Claude Agent SDK (TypeScript/Python) as the runner.** Rejected for the MVP. Under the hood it's the same binary and the same stream-json protocol, so it adds a language runtime to every agent image without adding capability we need. It's still a valid swap later if we want in-process hooks or custom tools.

## Consequences

- The runner depends on the stream-json event format, so the `claude` version is pinned centrally and upgraded on purpose (see the base image in Spec 02).
- Anthropic forbids offering claude.ai subscription login in third-party products without approval. This setup is meant for internal team use with each person's or the organization's own credentials.
