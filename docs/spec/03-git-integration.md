---
status: to-do
---

# Spec 03 — Git Integration: repositories, task branches, worktrees, pull requests

## ADRs

- [ADR 0002](../adr/0002-one-container-per-agent-one-job-at-a-time.md) — One long-lived container per agent, one job at a time (worktree layout, deterministic paths)
- [ADR 0004](../adr/0004-agent-output-from-stream-not-hooks.md) — No platform hooks, hence GitHub base-branch protection as the guardrail

Depends on: [Spec 01 — Core Board](01-core-board.md), [Spec 02 — Agents & Runtime](02-agents-runtime.md).

## Problem Statement

Every project corresponds to a code repository. When an agent works on a task, it needs its own isolated checkout on a dedicated branch, credentials to fetch and push that only work for that repository, and a way to hand the work back to humans as a pull request. Long-lived tokens sitting in containers are a security risk, especially when agents run with `bypassPermissions`. We also need to see, from the board, which branch and PR belong to each task and whether the PR is merged.

## Solution

Projects link to a GitHub repository through a **GitHub App** installed on our organization. All provider-specific behavior sits behind a `GitProvider` interface, so GitLab or others can be added later.

Inside an agent's container, each project's repository is cloned once, and each task gets a **worktree** on its own **task branch** (`task/<key>-<slug>`). Git authentication inside the container goes through a **credential helper** that obtains **short-lived installation tokens** on demand from the backend. Each token is scoped to the single repository of the task currently running, with contents read/write only. The agent commits and pushes as it likes. When it's ready, it calls the `open_pull_request` task tool, and the backend opens or updates the PR with the App's own permissions. Branch and PR links (with PR state) show on the task and its card.

Since the agents run without guardrail hooks, protecting the base branch from direct pushes is the job of a **GitHub ruleset/branch protection**. The app checks for it and warns when it's missing.

## User Stories

1. As an admin, I want to configure the GitHub App credentials (App ID, private key) once for the whole installation, so that projects can link repositories.
2. As an admin, I want to see which GitHub organizations/accounts have the App installed and which repositories it can access, so that I know what can be linked.
3. As a member, I want to link a project to one repository chosen from those the App can access, so that agents know what code to work on.
4. As a member, I want the project's base branch to default to the repository's default branch and be changeable, so that agents branch from the right place.
5. As a member, I want to change a project's repository only while no task in it has an open session, so that running work isn't pointed at the wrong code.
6. As a member, I want a warning on the project when its base branch isn't protected against direct pushes, with a link to the GitHub settings, so that an agent can't push straight to main.
7. As a member, I want to re-run the protection check on demand, so that the warning clears after I fix the settings.
8. As a member, I want each task worked by an agent to get a stable, readable branch name derived from its key and title, so that I can find it on GitHub.
9. As a member, I want the branch name to stay fixed after it's chosen even if the task title changes, so that links don't break.
10. As a member, I want the branch and PR links on the task view and a PR state badge (open, draft, merged, closed) on the card, so that I can jump to the code and see its status.
11. As an agent, I want my task's worktree ready on the task branch when my job starts, so that I can start working immediately.
12. As an agent, I want my worktree to continue from the remote task branch when it already exists (reopened task, reassignment), so that previous work is preserved.
13. As an agent, I want `git fetch`, `pull`, and `push` to just work without me handling credentials, so that I can use git normally.
14. As an agent, I want the credentials I get to work only for my task's repository, so that a mistake can't affect other repositories.
15. As an agent, I want a tool that opens a pull request from my task branch to the project's base branch, or updates the existing one, so that I can hand off my work for review.
16. As an agent, I want a clear error from `open_pull_request` when my branch hasn't been pushed yet, so that I know to push first.
17. As a member, I want PRs opened by agents to include a link back to the task, so that reviewers on GitHub have context.
18. As a member, I want commits made by an agent to carry the agent's name, so that history shows who did what.
19. As a member, I want PR state on the board to update within a few minutes of changes on GitHub, so that I can see what got merged without opening GitHub.
20. As an admin, I want worktrees removed when tasks close, while repositories and branches stay, so that agent volumes don't grow forever.

## Implementation Decisions

### GitProvider interface

A deep module, the only place that knows about GitHub. Operations:
- `listAccessibleRepositories()` → [{providerRepoId, owner, name, defaultBranch, private}]
- `getRepository(ref)` → {defaultBranch, cloneUrl, webUrl}
- `checkBaseBranchProtection(ref, branch)` → {protected: boolean, details}. "Protected" means direct pushes by the App (or by anyone without bypass) are blocked: a ruleset or classic branch protection requiring pull requests applies to that branch.
- `issueRepositoryToken(ref)` → {token, expiresAt}: contents read/write, restricted to exactly that repository.
- `branchExists(ref, branch)` → boolean
- `upsertPullRequest(ref, {head, base, title, body, draft})` → {number, url, state, draft}: creates a PR or updates the title/body of the open PR for that head.
- `getPullRequest(ref, number)` → {state ∈ open/closed/merged, draft, url}
- `branchWebUrl(ref, branch)` → url

The MVP implementation is **GitHub App**: JWT signed with the App private key → installation lookup per repository → installation access tokens with `repositories` limited to the one repo and `permissions` limited to `contents: write` (for the container). PR operations use separate installation tokens with `pull_requests: write` that never leave the backend. Tokens are cached in the backend until 5 minutes before expiry.

Configuration: `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` from backend env (or the admin settings page, stored encrypted like other secrets). No webhooks in the MVP, so the backend doesn't need to be publicly reachable.

### Data model additions

- **Project** additions: repository provider ("github"), provider repo id, owner, name, base branch, protection check result + checked_at.
- **Task** additions: branch name (nullable; set on the first job and immutable afterwards), PR number, PR url, PR state, PR draft, PR state checked_at.

### Branch naming

- `task/<lowercase task key>-<slug>`, where slug = the title lowercased, transliterated to ASCII, non-alphanumerics collapsed to `-`, trimmed, truncated to 40 characters (empty → no slug part). Example: `task/api-42-fix-login-redirect`.
- Computed when the first job for the task is dispatched and stored on the task. Never recomputed.

### Repositories and worktrees in the agent volume

- Layout under the agent's home (deterministic, so `--resume` always finds the session in the same cwd):
  - one **bare clone** per project: `repos/<projectId>.git`
  - one **worktree** per task: `worktrees/<projectId>/<taskKey>`
- The `job.start` git section from Spec 02 contains: repository HTTPS clone URL (without credentials), base branch, task branch, whether the task branch is expected to exist remotely (hint only), worktree path, and commit identity (name, email).
- Runner preparation steps (stage `worktree` in Spec 02 failure reporting):
  1. If the bare clone is missing, clone it (bare, all branches). Otherwise fetch `origin` with prune.
  2. If the worktree exists and is valid, leave it alone: it's the agent's working state, possibly with uncommitted changes from a previous turn.
  3. If the worktree doesn't exist: if `origin/<task branch>` exists, add the worktree tracking it. Otherwise add the worktree with a new task branch from `origin/<base branch>`, with upstream configured to `origin/<task branch>` so a plain `git push` works.
  4. Configure the worktree's commit identity: name = `<agent name> (claude-task)`, email = `<agent-slug>@<AGENT_COMMIT_EMAIL_DOMAIN>` (backend config, default `agents.claude-task.local`).
  5. Add `.claude-task/` to the repository's `info/exclude`.
  6. Report whether the worktree was newly created. If so, the setup script runs (Spec 02).
- If a reopened task's remote branch was deleted, step 3 creates it again from the base branch, and the backend posts a system comment noting that the previous branch was not found.
- `worktree.remove` (on task close): `git worktree remove --force`, then `git worktree prune`. The branch, local or remote, is never deleted.

### Credential helper

- A small binary in the base image (part of the runner project) configured globally in the base image's git config as the credential helper for `https://github.com`.
- On `get`, it connects to the runner over a Unix socket in the agent's home (not reachable from outside the container) and asks for credentials for the requested host/path. The runner forwards `git.token_request` {repository} to the backend over the Runner Protocol.
- The backend grants a token only if the agent has a job in `running`/`finishing` and the requested repository is the repository of that job's project. Otherwise it returns an error and git fails with a clear message ("no active task for this repository").
- Tokens are cached in the runner until 5 minutes before `expiresAt`, so long jobs keep refreshing transparently. The cache is cleared at job end.
- Username `x-access-token`, password = token (GitHub's convention for installation tokens).
- Remotes in clones never contain credentials.

### Base-branch protection check

- Runs when a repository is linked, when the base branch changes, on demand from project settings, and daily.
- If unprotected: a warning banner on project settings and a small warning icon on the project's board header, linking to the repository's branch rules page with a short explanation ("agents run without guardrails; require pull requests on `<base>` and don't grant the App bypass"). Never blocking.

### `open_pull_request` task tool (MCP, Spec 02 server)

- Arguments: `title` (required), `body` (required, markdown), `draft` (optional, default false).
- Behavior: requires the task to have a branch name. Checks `branchExists` on the remote; if missing → tool error "Push the branch `<name>` before opening a pull request." Then `upsertPullRequest` with head = task branch, base = project base branch, body = the agent's body + a footer with a link to the task in the web app and the agent's name. Stores PR number/url/state/draft on the task, records a Revision attributed to the agent, and posts a system timeline item "Pull request #N opened/updated". Returns the PR url and number.
- If a PR for the head exists but is closed or merged, a new PR is created.

### PR state sync

- Polling: every 5 minutes for tasks with a PR in state open/draft, and on opening a task view if the last check is older than 1 minute. Updates the task fields and broadcasts a board event when they change.
- PR state changes don't affect task status or sessions (status never drives agents; merging doesn't close tasks). The task card shows the state badge.

### UI

- Admin settings: GitHub App configuration and the list of installations/accessible repositories.
- Project settings, "Repository" tab: repository picker (searchable), base branch field (validated against the repo's branches), protection status with re-check, change-repository action (disabled with explanation when sessions are open).
- Task view: branch link (GitHub tree URL) and PR link with state badge. Card: PR badge.

## Testing Decisions

- **What a good test is**: external behavior at the seams. Never assert on internal git command sequences, only on the resulting repository and worktree state and on API/tool results.
- **Seam 1 — backend public API** with a **fake GitProvider** (in-memory repos, branches, PRs, protection flags, token issuance with expiry). Covers: linking/changing repositories (blocked with open sessions), base branch validation, protection warnings, branch name computation and immutability, `git.token_request` authorization (granted only for the active job's repository; denied when idle or for other repos), `open_pull_request` (unpushed branch error, create, update, closed-PR → new PR, revision + timeline item), PR polling updates and board broadcasts.
- **Seam 2 — runner black box** with a **real local git setup**: a bare repository on the filesystem acts as `origin` (file URL), with a fake backend. Covers: first clone, fetch on subsequent jobs, worktree creation from base, worktree from an existing remote task branch, keeping an existing worktree with uncommitted changes untouched, missing remote branch recreated, commit identity, `.claude-task/` excluded, `worktree.remove` keeping branches. The credential helper is tested over its Unix socket against the runner with a fake backend that issues and refuses tokens (including the cache-until-near-expiry behavior), using an HTTPS-less setup where the helper output is asserted directly.
- **GitHub contract tests (opt-in)**: the real GitHub `GitProvider` implementation run against a dedicated test repository with a test App installation, gated by environment credentials. Same scenarios as the fake's behavior, which keeps the fake honest.
- **Seam 3 e2e smoke** (Spec 02) includes push and PR creation against a throwaway repository.
- **Prior art**: the Spec 01/02 harness. The fake GitProvider is shared with Spec 02 tests.

## Acceptance Criteria

1. With the GitHub App configured, admins see installations and accessible repositories. Members can link one to a project, and the base branch defaults to the repo default.
2. Linking a repository whose base branch isn't protected shows the warning. Fixing it on GitHub and re-checking clears it.
3. The first job of a task creates the bare clone if needed and a worktree at the deterministic path on `task/<key>-<slug>` from the latest `origin/<base>`, with commit identity set.
4. The task branch name is stored on first dispatch and doesn't change when the title changes.
5. Inside the container, `git push` on the task branch succeeds without any credentials in remotes or env. Tokens come from the credential helper and are scoped to that repository only (a push or fetch to another repo of the same installation fails).
6. Outside an active job, the credential helper gets no token.
7. `open_pull_request` fails with a clear message when the branch isn't pushed, and otherwise creates the PR (or updates the existing open one) with the task link footer. The task shows the PR link and badge.
8. PR merges/closures on GitHub show on the card within 5 minutes and don't change task status.
9. Closing a task removes its worktree but keeps the local and remote branches. Reopening recreates the worktree from the remote branch at the same path.
10. Changing a project's repository is refused while any of its tasks has a non-closed session.

## Out of Scope

- GitLab, Bitbucket, Gitea, or generic git remotes (the `GitProvider` interface leaves room for them).
- Webhooks (PR state uses polling).
- Commenting on PRs, reading review comments back into the task, CI status display.
- Automatic PR creation or task status changes driven by PR events.
- Monorepos with multiple projects per repository having different base paths (allowed, but no special handling).
- Git LFS and submodules beyond what plain git does by default.
- Signed commits.

## Further Notes

- The GitHub App needs repository permissions: Contents (read/write), Pull requests (read/write), Metadata (read), and Administration (read) or equivalent access to read rulesets/branch protection for the protection check. If administration read isn't granted, the check reports "unknown" with the same warning style.
- Installation tokens can't be restricted by branch, which is why base-branch protection on GitHub is the actual guardrail. Without hooks, the agent is told in its system prompt to push only its task branch, but nothing technical stops it inside the container.
- Agent commit emails don't match GitHub accounts, so commits show the agent name without a GitHub avatar, which makes them easy to tell apart from human commits.
