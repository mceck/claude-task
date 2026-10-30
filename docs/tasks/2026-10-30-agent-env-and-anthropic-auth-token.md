---
status: done
---

# Agent environment variables and Anthropic auth-token Credentials

## Specs

- [Agents](../specs/agents.md)
- [Agent sessions](../specs/agent-sessions.md)
- [Runner](../specs/runner.md)

## Problem Statement

Agents can only reach Anthropic's default endpoint with the configured Credential. Teams using an Anthropic-compatible gateway such as OpenRouter need two things the platform doesn't offer: a Credential kind that sends the secret as `ANTHROPIC_AUTH_TOKEN`, and a way to configure routing and model environment variables per Agent (`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, `ENABLE_TOOL_SEARCH`, …) without baking them into a Dockerfile or a Project.

## Solution

- Add the `anthropic_auth_token` Credential kind, sent to each Job as `ANTHROPIC_AUTH_TOKEN` instead of `ANTHROPIC_API_KEY`.
- Add a plain `env` map to each Agent, edited as `NAME=value` lines in the web and native forms. It applies to every Job of that Agent, travels in the Job payload, and wins over the Project's environment variables. Platform-owned names are rejected.
- Keep Credentials, Agent environment and Project environment per Job, so changes apply from the next Job without a rebuild or container recreation.

## User Stories

1. As an Admin, I want to store an Anthropic auth token under a Credential, so that an Agent can use a bearer-token gateway such as OpenRouter.
2. As an Admin, I want to set `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, the `ANTHROPIC_DEFAULT_*_MODEL` overrides, `CLAUDE_CODE_SUBAGENT_MODEL` and `ENABLE_TOOL_SEARCH` on an Agent, so that all its Jobs use the same routing and models.
3. As an Admin, I want Agent environment values to override the Project's on a name clash, so that per-Agent configuration is predictable.
4. As an Admin, I want invalid or platform-owned variable names rejected, so that the platform's auth and resume flags can't be shadowed.
5. As an Admin, I want environment changes to apply from the next Job, so that tuning an Agent needs no rebuild.
6. As a User, I want Agent environment values hidden from no one but clearly non-secret, so that I know to use a Credential or Project secret for sensitive values.

## Implementation Decisions

- The Agent environment is a JSON object (`Record<string, string>`) on `agents`; keys follow the Project env-name rule, values are up to 100,000 characters and there are at most 100 entries. Names the platform sets (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `CLAUDE_TASK_*`, `HOME`, `PATH`, `USER`) are rejected.
- Precedence per Job: Project env, then Agent env, then the Credential's variable, then the resume flag.
- The web form edits the map as `.env`-style lines and keeps the last valid map while a line is incomplete; the native form uses the same syntax. Values are plain text and returned by the API.
- The Credential kind is fixed after creation, like the other kinds; `CREDENTIAL_KIND_LABELS` is shared by the clients.

## Testing Decisions

- Backend API: create an auth-token Credential and assert the Job's `ANTHROPIC_AUTH_TOKEN`; create/update an Agent's environment and assert storage, precedence and rejected names/limits; duplicate an Agent with its environment.
- Mobile: round-trip the Agent env text format and reject platform-owned/invalid names; existing Agent and Project environment tests keep passing.
- Typecheck all packages.

## Acceptance Criteria

- [x] Credentials accept `anthropic_auth_token` and send it as `ANTHROPIC_AUTH_TOKEN`.
- [x] Agents store and expose an environment map, editable in web and native forms.
- [x] Agent environment variables reach every Job, overriding Project variables.
- [x] Platform-owned and invalid names are rejected in Project and Agent environments.
- [x] Project and Agent environment variables remain per Job; no container recreation is needed.
- [x] Specs and manual are updated.
