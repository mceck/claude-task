---
status: done
---

# Spec 05 — GitLab support, Git Connections and the backend git proxy

Implemented across backend, runner/helper, Base Image and frontend; see
[configuration and verification](../git-integration.md). Verified on 2026-10-26 with:
- the workspace typecheck;
- the backend suite: the Git Proxy driven by the real `git` CLI against a `git http-backend` upstream, plus the GitHub/GitLab adapter and token-rotation tests;
- the Runner black-box tests;
- the Playwright Git flows;
- a Base Image build.

The live GitHub/GitLab contract tests and the real Docker/Claude push smoke are opt-in and were not run (no dedicated credentials).

## ADRs

- [ADR 0006](../adr/0006-backend-git-proxy-and-git-connections.md) — Agent git traffic goes through a backend git proxy; providers are reached through Git Connections
- [ADR 0002](../adr/0002-one-container-per-agent-one-job-at-a-time.md) — One container per Agent, one Job at a time (deterministic Worktree paths, unchanged)
- [ADR 0003](../adr/0003-backend-owned-queue-outbound-runner.md) — Backend-owned Queue, outbound stateless Runner
- [ADR 0004](../adr/0004-agent-output-from-stream-not-hooks.md) — No platform hooks (its base-branch consequence is superseded by ADR 0006)

Depends on: [Spec 03 — Git Integration](03-git-integration.md). This spec replaces Spec 03's credential helper and token issuance, its base-branch protection warnings and its single GitHub App configuration. Everything else in Spec 03 (Task Branch naming, Worktree layout and preparation, `open_pull_request`, Pull Request polling, Worktree removal) still applies, for every provider.

## Problem Statement

Our team also keeps code on GitLab, both on gitlab.com and on self-managed instances, but Projects can only link GitHub repositories through a single GitHub App. Spec 03 gives containers GitHub installation tokens, and GitLab has nothing equivalent: its closest option is valid for a day, creates bot users and needs Premium on gitlab.com. Also, nothing technical stops an Agent from pushing to the Base Branch. Only provider-side branch protection does, and the app can only warn when it's missing.

## Solution

Admins configure any number of **Git Connections**: GitHub Apps and GitLab instances (URL + personal access token). When members link a Project's Repository, they pick it from all connections, so one Project can use a GitHub repository and another a GitLab one. Agents keep using git normally, but their `origin` is the backend's **Git Proxy**. The proxy lets an Agent fetch only its active Job's Repository and push only to its Task Branch, and it forwards traffic to the provider with the connection's credential. No provider token ever enters an Agent Container. `open_pull_request`, branch and Pull Request links and state polling work the same on GitLab, where the UI calls them merge requests. Whether the provider also protects the Base Branch is shown for information only.

## User Stories

### Git Connections (admins)

1. As an admin, I want to see all Git Connections in one place, with provider, name, host and health, so that I know which code hosts the platform can reach.
2. As an admin, I want to add a GitHub connection by entering a GitHub App ID and private key, so that I can link repositories of that App's installations.
3. As an admin, I want to add more than one GitHub App connection, so that separate organizations or Apps can be used side by side.
4. As an admin, I want to add a GitLab connection by entering the instance URL (default `https://gitlab.com`) and a personal access token, so that I can link repositories hosted on gitlab.com or on our self-managed GitLab.
5. As an admin, I want to add several GitLab connections, e.g. gitlab.com and a self-managed instance, so that all our code hosts are available.
6. As an admin, I want to give every connection a display name, so that I can tell connections to the same provider apart.
7. As an admin, I want the GitLab token checked when I save it (validity, `api` and `write_repository` scopes, expiry, owning user), so that a wrong token fails right away instead of during an Agent's Job.
8. As an admin, I want a clear error when the GitLab URL isn't reachable or isn't a GitLab instance, so that I can fix typos.
9. As an admin, I want secrets (private keys, tokens) to be write-only, showing only their last 4 characters, so that nobody can read them back through the UI or API.
10. As an admin, I want to replace a connection's secret without re-linking any Project, so that I can rotate credentials safely.
11. As an admin, I want to see a GitLab token's expiry date, so that I know when it needs attention.
12. As an admin, I want GitLab tokens saved from the UI rotated automatically before they expire, so that Agents don't stop working on the day a token expires.
13. As an admin, I want a warning when a token is about to expire and can't be rotated automatically (set through the environment, or rotation failed), so that I can renew it in time.
14. As an admin, I want to see which GitHub installations or GitLab user each connection works as, and which repositories it can access, so that I know what can be linked.
15. As an admin, I want connections defined through environment variables to show up read-only, so that infrastructure-managed configuration isn't edited from the UI.
16. As an admin, I want deleting a connection refused while any Project links one of its repositories, so that linked Projects never lose their code host.
17. As an admin, I want a connection's provider and GitLab URL to be fixed once created, so that linked repository identities stay valid. To move hosts, I create a new connection.

### Linking repositories (members)

18. As a member, I want the repository picker to list repositories from every connection, grouped and labeled by connection, so that I can choose a GitHub or GitLab repository the same way.
19. As a member, I want to search repositories by owner, namespace and name, including nested GitLab groups, so that I can find them quickly.
20. As a member, I want the base branch to default to the repository's default branch and be validated on the provider, as today, so that agents branch from the right place.
21. As a member, I want changing a Project's repository, even to another connection or provider, to stay blocked while any Session in the Project is non-closed, so that running work isn't pointed at the wrong code.
22. As a member, I want the Repository settings to show whether the provider also protects the Base Branch (protected, not protected, unknown), with a link to the provider's settings and a re-check button, so that I can add a second line of defense if I want to.
23. As a member, I don't want board warnings about base-branch protection anymore, because the platform blocks pushes to the Base Branch itself.

### Agents and git

24. As an agent, I want `git fetch`, `pull` and `push` to keep working without handling credentials, whatever the provider, so that I can use git normally.
25. As an agent, I want my Worktree to keep its deterministic path and existing state when the platform switches to the proxy, so that my Session resumes in the same cwd with my uncommitted work.
26. As an agent, I want to be able to force-push my Task Branch, so that I can rebase my work.
27. As an agent, I want a clear git error when I try to push anything other than my Task Branch, so that I understand why it was refused.
28. As an agent, I want my git requests refused outside an active Job or for another Project's repository, so that a mistake can't affect other code.
29. As an agent working on GitLab, I want `open_pull_request` to open or update a merge request from my Task Branch to the Base Branch, including drafts, so that I can hand off my work the same way as on GitHub.

### Visibility

30. As a member, I want Task branch links and Pull Request links to point to the right provider pages, so that I can jump to the code.
31. As a member, I want GitLab merge requests labeled "merge request" with `!N` numbers, and GitHub ones "pull request" with `#N`, so that the UI speaks each provider's language.
32. As a member, I want merge request state (open, draft, merged, closed) on cards to update within 5 minutes, as for GitHub, so that I can see what got merged.
33. As an admin, I want proxy activity logged (Agent, Project, operation, result, bytes) without any token or credential, so that I can debug git problems safely.

## Implementation Decisions

### Domain vocabulary

New glossary terms (CONTEXT.md): **Git Connection**, **Git Proxy**. **Pull Request** covers GitLab merge requests. In UI copy, GitLab ones are called "merge request" with `!N`. **Base Branch Protection** now means the provider-side rules, which are informational. The guard that matters is the Git Proxy's **Push Policy**.

### Git Connections

- New table of connections: id, provider (`github` | `gitlab`), display name, provider config, encrypted secret, secret last4, created/updated timestamps. Provider config is the App ID for GitHub, and for GitLab the base URL plus the cached identity of the token (user id, username, scopes, expiry).
- Provider and GitLab base URL are immutable after creation. Name and secret are editable.
- GitLab base URL is normalized (https only, unless `GITLAB_ALLOW_HTTP` is set for test or dev; no trailing slash; may include a path prefix for instances served under a subpath).
- Environment connections: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` define a connection with the fixed id `env-github`. `GITLAB_URL` (default `https://gitlab.com`) + `GITLAB_TOKEN` define `env-gitlab`. They are listed read-only, aren't stored in the table and are never rotated. At most one env connection per provider.
- Deleting a connection is refused (409) while any Project's Repository references it.
- Secrets follow the existing rules: encrypted with `SECRETS_MASTER_KEY`, write-only (last4 only), never logged, never sent to browsers or containers.
- Migration: the existing single GitHub App settings row becomes a connection. Existing Project repositories get the `connectionId` of that migrated connection. If no such row exists, they get `env-github`. The old settings table is dropped after the copy.

### Provider registry and the GitProvider interface

- The app context exposes a registry instead of a single provider: list connections, and resolve a `GitProvider` for a connection id. Each provider instance is bound to one connection and keeps its own caches. Caches are invalidated when the connection's secret changes, as GitHub already does with its key fingerprint.
- `RepositoryRef` gains `connectionId` and `provider: 'github' | 'gitlab'`. `owner` is the GitHub owner or the GitLab namespace full path (nested groups allowed), and `name` is the repository path. `providerRepoId` is the provider's numeric id as a string, so renames and moves keep working.
- Interface changes:
  - `issueRepositoryToken(ref)` is replaced by `gitUpstream(ref)` → `{ url, username, password, expiresAt? }`, used only by the Git Proxy inside the backend.
  - `listInstallations()` becomes `describeAccess()` → a list of `{ label, url }`: GitHub installations, or the GitLab user the token belongs to.
  - New `validate()` → connection identity and problems, used on save and shown as connection health.
  - `branchWebUrl`, `checkBaseBranchProtection`, `upsertPullRequest`, `getPullRequest`, `branchExists`, `getRepository`, `listAccessibleRepositories` keep their meaning.
- `listAccessibleRepositories` across connections is the union of each connection's list. A connection that fails is skipped in the picker and reported with an error label, so one broken connection doesn't hide the others.
- Every place that resolved `ctx.git` (linking, protection checks, dispatch branch lookups, `open_pull_request`, PR sync) now resolves the provider from the Project's `repository.connectionId`.

### GitHub provider

- Unchanged App authentication. `gitUpstream` returns the repository's HTTPS clone URL, username `x-access-token` and an installation token with `contents: write` limited to that repository. It's cached until 5 minutes before expiry and never leaves the backend.
- Required App permissions: Contents read/write, Pull requests read/write, Metadata read. Administration read becomes optional. Without it, the informational protection status is "unknown".

### GitLab provider

- REST API v4 under the connection's base URL, authenticated with the `PRIVATE-TOKEN` header. Same error hygiene as GitHub: provider bodies and auth never appear in errors or logs, redirects are refused and requests time out after 15 s.
- `validate`: `GET /personal_access_tokens/self` (active, not revoked, scopes include `api` and `write_repository`, expiry) and `GET /user` (id, username). Personal, group and project access tokens all work: the platform needs no token minting.
- `listAccessibleRepositories`: projects where the token's user has at least Developer access (`membership=true&min_access_level=30`), paginated, archived projects excluded. Mapping: id → `providerRepoId`, `namespace.full_path` → `owner`, `path` → `name`, `default_branch`, `visibility != public` → `private`, `http_url_to_repo` → `cloneUrl`, `web_url` → `webUrl`.
- `getRepository`: `GET /projects/:id`, with the same identity check as GitHub (id must match).
- `branchExists`: `GET /projects/:id/repository/branches/:branch` (404 → false).
- `branchWebUrl`: `<web_url>/-/tree/<branch>`.
- `gitUpstream`: the clone URL with username `oauth2` and the connection's token as password.
- `upsertPullRequest`: find an open merge request with `source_branch` = head and `target_branch` = base. If found, update its title and description and keep its current draft state. Otherwise create one. Draft is expressed with the `Draft: ` title prefix. Mapping: `iid` → `number`, `web_url` → `url`, state `opened` → `open`, `merged` → `merged`, `closed`/`locked` → `closed`, `draft` → `draft`.
- `getPullRequest`: `GET /projects/:id/merge_requests/:iid`, same mapping.
- `checkBaseBranchProtection` (informational): list the project's protected branches and find the rules matching the base branch (exact name or wildcard). The branch is protected when at least one matching rule allows force pushes for nobody and lets neither the connection's user nor its role push. Push access levels of `0` (no one) or `60` (admin), or entries for other users, block it. Entries for groups can't be evaluated, so they give unknown. Missing permission (403) also gives unknown. Settings link: `<web_url>/-/settings/repository#js-protected-branches-settings`.
- **Token rotation** (connections stored in the database only): a background check, at startup and then daily, rotates GitLab tokens that expire within 14 days. It calls `POST /personal_access_tokens/self/rotate` with an expiry 90 days ahead, and if the instance rejects that expiry, it retries without one (GitLab's default). The new token is stored encrypted. Rotation runs under a Postgres advisory lock per connection, and the stored token is re-read after taking the lock. This matters because rotating an already-revoked token makes GitLab revoke the whole token family. A failed rotation is kept as connection health and shown to admins. Environment tokens are never rotated. They show the same expiry warning from 14 days out.

### Git Proxy

- Routes outside the API prefix, on the backend's main listener:
  - `GET /git/<projectId>.git/info/refs?service=git-upload-pack|git-receive-pack`
  - `POST /git/<projectId>.git/git-upload-pack`
  - `POST /git/<projectId>.git/git-receive-pack`

  Nothing else is served (no dumb HTTP, no LFS).
- **Authentication**: HTTP Basic, any username, password = the Job's existing bearer token. Missing or invalid credentials get `401` with `WWW-Authenticate: Basic realm="claude-task"`, so git calls the credential helper. The request is authorized only if the token belongs to a Job in `running` or `finishing` whose Task belongs to `<projectId>` and that Project has a Repository. Otherwise `403`, with the message "no active task for this repository" in the body. The check runs once at request start. An in-flight request finishes even if the Job ends meanwhile.
- **Upstream**: the Project's Repository → its connection's provider → `gitUpstream`. The proxy forwards to `<upstream url>/info/refs` etc. with upstream Basic auth. It passes through only the git-relevant request headers (`Content-Type`, `Accept`, `Content-Encoding`, `Git-Protocol`, `Content-Length` or chunked) and response headers (`Content-Type`, `Cache-Control`, `Content-Encoding`). Upstream redirects are refused. Protocol v2 for upload-pack works through `Git-Protocol` passthrough.
- **Streaming**: request and response bodies are streamed in both directions. The routes bypass body parsing and body limits. There is no overall timeout, only an idle timeout of 5 minutes without bytes in either direction. A client disconnect aborts the upstream request.
- **Push Policy** (`git-receive-pack`): the proxy reads the command list at the start of the body (pkt-lines up to the flush; gzip-decoded if `Content-Encoding: gzip`), with a size cap of 64 KiB on that header part. Every command must target exactly `refs/heads/<Task Branch>` of the Job's Task, and the new value must be non-zero, so no deletions. Force updates are allowed. Any other ref, tag or deletion rejects the whole push. In that case the proxy doesn't contact upstream for the POST. It answers with a valid `report-status` (side-band wrapped if the client requested `side-band-64k`): `unpack ok` and `ng <ref> <reason>` for every command, reason "claude-task: only <Task Branch> can be pushed", so git prints a readable rejection. When the policy passes, the already-read bytes are replayed to upstream, followed by the rest of the stream. Push options are passed through unchanged.
- A Task without a Task Branch yet (it can't have a Job without one when a Repository exists) gets every push rejected.
- Upstream errors: `401`/`403`/`404` from the provider become `502` with "the Git Connection could not access this repository; check its configuration" and a log entry. Other failures become `502`.
- **Logging**: Agent id, Job id, Project id, service, refs pushed, upstream status, bytes in and out, duration. Never headers, credentials or URLs with credentials.
- **Rate**: the Job-one-at-a-time rule bounds concurrency to the number of Agents. No extra limits.

### Runner, credential helper and Base Image

- `job.start.git.cloneUrl` becomes the proxy URL: `<AGENT_BACKEND_URL>/git/<projectId>.git`, with `git.token` (the Job token, the proxy password) and `git.repositoryId` (`<connectionId>/<providerRepoId>`). The proxy URL is the same whatever Repository the Project links, so the Runner records `repositoryId` in the bare clone (`claude-task.repository`) and discards the clone only when a different identity is recorded. A clone without a recorded identity (made before this change) is adopted: its origin is rewritten to the proxy URL and its Worktrees are kept. Paths and Worktree state are unchanged. The Runner Protocol version becomes 2.
- The credential helper protocol (Unix socket, mode 0600) is unchanged for the helper itself. The Runner answers locally: for a `get` whose protocol, host, port and path match the current Job's `cloneUrl`, it returns username `claude-task` and the Job's token as password. Anything else, or no current Job, is denied. There is no backend round trip, token cache or expiry handling anymore.
- `git.token_request` and `git.token` are removed from the Runner Protocol (shared types and both sides). The `https` + `github.com` checks are removed. `http` is accepted only when the Job's `cloneUrl` is itself `http`.
- Base Image git config: the helper is configured globally (`credential.helper`, `credential.useHttpPath=true`) instead of only for github.com, because the backend host is runtime configuration. The helper's denial makes git fall back to its normal behavior for other hosts. Public repositories needing no auth are unaffected.
- The Base Image and Runner version change triggers the existing rebuild-when-idle rule for Agent images.

### Branch protection becomes informational

- The protection check still runs on link, on base-branch change, on demand and daily, and keeps its stored result shape.
- UI: no banner and no board header icon. The Repository settings show a status line (Protected / Not protected / Unknown) with the provider's explanation, a link to the provider's settings and a "Re-check" button. Copy: "Pushes to the base branch are always blocked by claude-task. Provider protection is an optional second line of defense."

### API contracts (shared types are the source of truth)

- `GET /api/git/connections` (admin) → connections: id, provider, name, source (`database` | `environment`), host, secret last4, identity (`describeAccess`), health (ok / error message / expiring with date / rotation failed), linked project count.
- `POST /api/git/connections` (admin): GitHub `{ provider, name, appId, privateKey }`, GitLab `{ provider, name, baseUrl, token }`. The connection is validated before it's stored.
- `PATCH /api/git/connections/:id` (admin): `{ name?, appId?, privateKey?, token? }`. Omitted secrets keep the current value. Environment connections give 409.
- `DELETE /api/git/connections/:id` (admin): 409 when linked.
- `GET /api/git/repositories` (members) → repositories grouped by connection `{ connection: { id, provider, name, host }, repositories, error? }`.
- `PUT /api/projects/:id/repository` body gains `connectionId` (required), next to `providerRepoId` and optional `baseBranch`.
- `ProjectRepository` and `RepositoryRef` gain `connectionId`. `provider` widens to `'github' | 'gitlab'`.
- The previous `/api/git/github` and `/api/git/installations` endpoints are removed. The frontend is updated in the same change.

### `open_pull_request` and PR sync

- Same tool name, arguments and behavior. The tool description mentions merge requests on GitLab. The System Comment uses the provider's vocabulary: "Merge request [!N](url) opened/updated." or "Pull request [#N](url) opened/updated.".
- Polling as in Spec 03, resolving the provider per Project. A failing connection is logged and skipped. The task keeps its last known state.

### UI

- Sidebar entry "GitHub" becomes "Git" (admin). The page lists connections with health and expiry, an "Add connection" dialog with a provider choice (GitHub App or GitLab) and per-provider fields, and edit, delete and read-only states for environment connections.
- Project settings → Repository: a searchable picker grouped by connection, with provider icon, connection name and host, and an error row for unreachable connections. Base branch field and informational protection status as above.
- Task view and card: branch link and Pull Request link/badge as today, with provider-aware labels (`#N` or `!N`, "pull request" or "merge request").

### Docs and invariants to update on implementation

- `CLAUDE.md` invariants: Git tokens are replaced by "Agents reach git only through the Git Proxy with their Job's token; provider credentials never leave the backend". Base-branch protection becomes "enforced by the Git Proxy's Push Policy; provider protection is informational".
- `docs/git-integration.md`: configuration for both providers, proxy behavior, rotation.

## Testing Decisions

- **What a good test is**: external behavior at the existing seams. Assert on git outcomes (refs in the upstream repository, git exit codes and messages), API responses and stored or broadcast state. Never assert on internal call sequences or the proxy's internal parsing.
- **Seam 1 — backend public API (HTTP + WebSocket + MCP + Git Proxy)** against real Postgres, with the fake Runner, fake `AgentRuntime` and fake GitProvider registry. The fake provider's `gitUpstream` points at a local upstream served by `git http-backend` (the CGI that ships with git), wrapped in a tiny HTTP server inside the test helper, over bare repositories on disk, with Basic auth so upstream credentials are verified. Tests drive the real `git` CLI against the backend's proxy URL. Covers:
  - connection CRUD, write-only secrets, env connections read-only, delete blocked when linked, validation errors, migration of the old GitHub settings;
  - picker grouping and a failing connection;
  - linking with `connectionId`, and switching connection or provider blocked with open Sessions;
  - clone, fetch and push of the Task Branch (including force push) through the proxy with an active Job;
  - refusal without credentials (401), with a finished Job's token, for another Project, with a Task Branch but a push to the Base Branch, to another branch, of a tag or a deletion (readable `ng` message, upstream unchanged);
  - gzip and protocol v2 fetches;
  - upstream credential failure → 502;
  - `open_pull_request` and PR polling per connection, with GitLab vocabulary in System Comments;
  - informational protection results with no board warning.
- **Seam 2 — Runner as a black box**: the Go binary against a fake backend. Covers: the credential helper returns the Job token only for the current Job's exact clone URL (protocol, host, port, path), denies other hosts and paths and denies when idle or after job end; there is no `git.token_request` on the wire; existing bare clones get their origin rewritten to the proxy URL with Worktrees and uncommitted changes intact. The existing local bare git origin tests keep running, now with a file or HTTP origin URL in `job.start`.
- **GitLab adapter tests** against a local fake HTTP server, like the existing GitHub adapter tests. Cover token validation, scopes and expiry, pagination, nested namespaces, MR create, update, draft and state mapping, branch lookups, protection interpretation (exact and wildcard rules, no-one or admin levels, user and group entries, 403 → unknown), and rotation including the fallback without expiry, the advisory-lock serialization (two concurrent rotations make one rotate call) and failure health. Error hygiene: no token in errors.
- **Contract tests (opt-in)**: real GitLab (`GITLAB_CONTRACT_URL`, `GITLAB_CONTRACT_TOKEN`, `GITLAB_CONTRACT_PROJECT`), read-only like the GitHub one. Plus the existing GitHub contract.
- **Seam 3 e2e smoke** (opt-in): real Docker and `claude` pushing through the proxy to a throwaway GitHub repository and a throwaway GitLab project, and opening a PR or MR.
- **Frontend Playwright**: the Git connections page (add GitHub and GitLab, write-only secrets, env read-only), picker grouped by connection, informational protection status, `!N` merge request badge.
- **Prior art**: `backend/test/git.test.ts` (fake provider, runner-driven flows), the GitHub adapter test with a local HTTP server, the runner black-box harness with local bare remotes.

## Acceptance Criteria

1. Admins can create, edit (name and secret) and delete GitHub App and GitLab connections, several per provider. Secrets are write-only with last4. Environment connections show read-only. Deleting a linked connection is refused.
2. Saving a GitLab connection with an invalid token, a missing `api` or `write_repository` scope, an expired token or an unreachable URL fails with a specific message.
3. Upgrading an installation with an existing GitHub App configuration keeps every linked Project working, now through a migrated connection, without re-linking.
4. The repository picker lists repositories of all connections, grouped and labeled. A broken connection shows an error row and doesn't hide the others.
5. A Project can link a GitLab repository, including one in a nested group, with base branch defaulting to and validated against GitLab.
6. Inside an Agent Container, `git fetch`, `pull`, `push` and force push of the Task Branch work for both providers. No provider token exists in the container (remotes, env, helper responses, files).
7. Pushes to any other ref, tag pushes and deletions are refused with a readable message, and the upstream is unchanged.
8. Proxy requests without an active Job for that Project are refused.
9. Existing Worktrees keep their path, Session cwd and uncommitted changes after the switch to the proxy.
10. `open_pull_request` opens or updates GitLab merge requests (including draft) with the task link footer. Cards show `!N` badges whose state updates within 5 minutes.
11. GitLab tokens stored in the database are rotated before expiring and keep working. Concurrent rotations never revoke the token family. Environment tokens show an expiry warning from 14 days out.
12. Base-branch protection is shown only in Repository settings as an informational status with re-check. There are no board or banner warnings.
13. No token or credential appears in logs, API responses, raw session events or error messages.

## Out of Scope

- Providers other than GitHub and GitLab (Bitbucket, Gitea/Forgejo, Azure DevOps). The connection model and proxy leave room for them.
- Git LFS through the proxy, SSH remotes, submodules pointing to other repositories.
- Webhooks (polling stays), CI or pipeline status, MR or PR comments, approvals.
- GitLab OAuth applications and per-user provider authorization.
- Moving an existing connection to another host (create a new connection and re-link).
- Restricting fetches to particular refs (Agents can fetch the whole Repository).
- Signed commits, push rules beyond the Task Branch Push Policy.

## Further Notes

- Recommended GitLab setup: a service account (no license seat, available on every tier) with Developer access to the groups or projects to link, and a personal access token with `api` and `write_repository`. With Developer, GitLab's default branch protection ("Maintainers can push") also blocks the platform's credential from the Base Branch, so the informational status usually shows "Protected" with no extra configuration.
- On gitlab.com, group and project access tokens need Premium. They also work as connection tokens on tiers that have them.
- The Job token already lives in the Agent Container for the MCP server, so using it for git adds no new secret. It's invalid as soon as the Job leaves `running`/`finishing`.
- All git traffic passing through the backend makes large first clones slower and puts the bytes on the backend host. Later fetches are incremental. This is the accepted cost of ADR 0006.
