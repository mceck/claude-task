---
status: accepted
---

# Agent git traffic goes through a backend git proxy; providers are reached through Git Connections

To support GitLab (gitlab.com and self-managed) next to GitHub, we stop handing provider tokens to Agent Containers. Each container's `origin` points at a git proxy in the backend (git smart HTTP). The container authenticates with its Job's token. The backend checks that the Job is active and that the Repository belongs to its Project, and it accepts pushes only to the Task Branch. It then streams the request to the provider using the credential of the Project's **Git Connection**. A Git Connection is a configured access to one provider instance: a GitHub App (App ID + private key), or a GitLab URL with a personal access token. There can be several Git Connections, of any provider, and each Project's Repository belongs to exactly one of them.

GitLab has nothing like GitHub's installation tokens. The closest thing, a per-Job project access token, lasts until midnight UTC of the next day at best, creates a bot user per token and needs Premium on gitlab.com. Every other provider would need its own way to mint scoped tokens, and some have none. With the proxy, the only secret inside a container is the Job's token, which is invalid as soon as the Job ends. Adding a provider then only needs its API adapter (repositories, pull requests, branch protection) and the credential the backend uses upstream.

## Considered Options

- **Provider-minted tokens in the container** (GitHub installation tokens as in Spec 03, GitLab project access tokens per Job, revoked at Job end). Rejected: GitLab tokens are valid for up to a day and not just for the Job, they need Premium on gitlab.com, every new provider would need its own scheme, and the Base Branch would still be protected only on the provider side.
- **A long-lived token of a bot user in the container.** Rejected: it works for every repository the bot can reach and outlives the Job.
- **SSH instead of HTTPS.** Rejected: we would need a key per Agent registered with every provider, and the backend could no longer inspect pushes.

## Consequences

- Provider credentials (GitHub installation tokens, GitLab personal access tokens) never leave the backend. The "short-lived, single-repository, active Job only" rule for Git tokens is now met by the Job token itself.
- **The proxy guards the Base Branch.** It rejects any push that doesn't create or update `refs/heads/<Task Branch>`, including deletions and tags. Force pushes to the Task Branch are allowed. This supersedes the consequence in [ADR 0004](0004-agent-output-from-stream-not-hooks.md) that protecting the base branch is GitHub's job. The provider-side protection check stays, but only for information, with no warnings.
- All Agent git traffic, including the first clone of large repositories, flows through the backend. The proxy streams and never buffers whole packs. Git LFS isn't proxied.
- The Runner no longer requests Git tokens from the backend (`git.token_request` is removed from the Runner Protocol). The credential helper returns the current Job's token, and only for that Job's proxy URL.
- A GitLab Git Connection needs a personal access token (a service account's is recommended) with the `api` and `write_repository` scopes and at least Developer on the projects to link. Group and project access tokens are accepted too, because the proxy needs no token minting. Tokens saved from the UI are rotated automatically before they expire. Tokens set through the environment can only be warned about.
- The proxy URL is the backend's internal address (`AGENT_BACKEND_URL`). On a plain-HTTP internal network the Job token travels unencrypted there, exactly as the MCP token already does.
