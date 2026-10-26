# Git Integration — configuration and verification

Implementation of [Spec 03](spec/03-git-integration.md) and
[Spec 05](spec/05-gitlab-and-git-proxy.md) ([ADR 0006](adr/0006-backend-git-proxy-and-git-connections.md)).

## Git Connections

Repositories are reached through **Git Connections**, configured by admins under
**Git** in the sidebar. There can be any number of them, GitHub and GitLab, and each
Project's Repository belongs to exactly one. Secrets (App private keys, GitLab
tokens) are encrypted with `SECRETS_MASTER_KEY`, write-only (GitLab tokens show
their last 4 characters) and never reach browsers or Agent Containers. Saving a
connection checks its credential first. A connection can't be deleted while a
Project links one of its repositories. Its provider and GitLab URL can't change:
create a new connection to move hosts.

### GitHub App

Create a GitHub App with repository permissions:

- Contents: read/write
- Pull requests: read/write
- Metadata: read
- Administration: read (optional, only for the informational protection status)

Install it on the organization or account and grant access to the repositories to
link. Webhooks are not needed. Add it as a GitHub connection with its App ID and RSA
PEM private key.

### GitLab (gitlab.com or self-managed)

Use a token with the `api` and `write_repository` scopes. A service account's
personal access token is recommended: it uses no license seat and exists on every
tier. Give it at least Developer on the groups or projects to link; those are what
the repository picker shows. Group and project access tokens work too, where your
tier has them. With Developer, GitLab's default branch protection ("Maintainers
can push") also keeps the platform's credential off the Base Branch.

Add it as a GitLab connection with the instance URL (default `https://gitlab.com`;
https only, a subpath is allowed) and the token. Tokens saved from the UI are
rotated automatically when they expire within 14 days, for 90 more days (or the
instance's default lifetime if it caps them). Rotations are serialized per
connection, because GitLab revokes the whole token family if a revoked token is
rotated. A failed rotation shows on the connection and is retried hourly.

### Environment connections

`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` define the `env-github` connection, and
`GITLAB_URL` + `GITLAB_TOKEN` the `env-gitlab` one. They show read-only in the Git
page and are never rotated: an expiring `GITLAB_TOKEN` shows a warning from 14 days
out. Escaped `\n` in a quoted private key value is supported. `GITLAB_ALLOW_HTTP`
accepts `http://` GitLab URLs for local development only.

Set `APP_URL` to the public web address, e.g. `https://tasks.example.com`. This is
used in pull request footers and differs from `AGENT_BACKEND_URL`, the internal
address used by agent containers. `AGENT_COMMIT_EMAIL_DOMAIN` defaults to
`agents.claude-task.local`; agent commits use `<agent name> (claude-task)`.

## Link a project and work on tasks

Open **Project settings → Repository** and pick a repository; the list is grouped
by connection, and a connection that can't be reached shows an error row without
hiding the others. The base branch defaults to the repository's default branch and
is validated on the provider. Repository changes (including to another connection)
are blocked while any session in the project is non-closed, including paused
sessions. Unassigning an agent pauses its session; close the task before changing
repository. Old pull request links are cleared when the repository changes.

On first dispatch, the task gets `task/<lowercase key>-<ASCII title slug>`. Slugs
are transliterated, at most 40 characters, and omitted if empty. Renaming or
reassigning the task keeps its branch name. The runner fetches the project bare
clone and prepares the deterministic worktree, configures commit identity, and
excludes `.claude-task/`. Existing valid worktrees and uncommitted changes are
left intact. A removed worktree is recreated from the remote task branch; if
that branch is missing, it starts from the latest base branch and a resumed
session receives a system notice. Worktree removal never deletes branches.
A recreated worktree treats the remote as authoritative, so agents must push
committed work before closing a task.

## The Git Proxy

Agent Containers never get a provider token. Each bare clone's `origin` is the
backend's Git Proxy, `<AGENT_BACKEND_URL>/git/<projectId>.git` (git smart HTTP,
outside the API prefix). `git fetch`, `pull` and plain `push` authenticate through
the Base Image's credential helper (`git-credential-claude-task`, configured for
every host with `useHttpPath`), which asks the Runner over a private mode-0600 Unix
socket. The Runner answers only for its current Job's exact proxy URL, with the
Job token as password; there is no backend round trip and nothing is cached.
The bare clone records the Repository identity (`claude-task.repository`), so the
switch from provider URLs to the proxy keeps existing clones and Worktrees, while
linking another Repository behind the same proxy URL starts a fresh clone.

The proxy admits the Job token only while that Job is `running` or `finishing`, and
only for its own Project. It streams requests to the provider with the connection's
credential (a GitHub installation token limited to that repository and Contents:
write, or the GitLab token), never buffering packs, with a 5-minute idle timeout.
Its **Push Policy** accepts only creating or updating the Task Branch (force pushes
included): other branches, tags and deletions reject the whole push with a
readable `claude-task: only <branch> can be pushed`, and upstream is never
contacted. Git LFS isn't proxied. Proxy requests are logged with Agent, Job,
Project, refs, status and bytes, never credentials.

Base-branch protection on the provider is informational: Repository settings show
Protected / Not protected / Unknown with a re-check button and a link to the
provider's settings. Checks also run on link, on base-branch change and daily.

## Pull requests and merge requests

Agents commit and push, then call `open_pull_request(title, body, draft?)` through
the existing task MCP server. On GitLab it opens a merge request (draft through
the `Draft:` title prefix). An unpushed branch produces a clear tool error. An open
pull request for the head/base is updated, keeping its draft state; a closed or
merged one leads to a new one. The body includes a task link and agent
attribution. Changes create a Revision attributed to the Agent and a System
Comment ("Pull request #N" or "Merge request !N"). Task views show branch and
pull request links; board cards show open, draft, closed or merged badges.

Open/draft pull requests are polled every five minutes. Opening a task also
refreshes its pull request when the last check is older than one minute. Their
state never changes Task Status or Session lifecycle.

## Checks

- `pnpm typecheck`
- `pnpm test`: real PostgreSQL with fake providers and Runner. The Git Proxy is
  exercised with the real `git` CLI against a local `git http-backend` upstream.
  GitHub and GitLab adapter tests use local HTTP servers (JWT signatures, token
  scopes and caches, REST shapes, merge requests, protection interpretation,
  token rotation with concurrent rotations).
- `cd runner && go test ./...`: real runner/helper subprocesses, a fake backend,
  local bare git remotes, the Job-token credential helper and clone migration.
- `pnpm test:e2e`: browser flow for Git Connections, repository linking, protection
  status, pull request links and state updates, and session locking.
- `docker build -t claude-task .`: production app image, including Base Image
  recipe and runner/helper sources. Runner/Base Image changes automatically
  rebuild agent images using the existing wait-for-idle rule.

Live read-only contract checks are opt-in, using dedicated test resources:

```sh
GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY='...' \
GITHUB_CONTRACT_REPOSITORY=test-org/test-repository \
pnpm --filter @claude-task/backend exec vitest run test/github.contract.test.ts

GITLAB_CONTRACT_URL=https://gitlab.com GITLAB_CONTRACT_TOKEN=... \
GITLAB_CONTRACT_PROJECT=test-group/test-project \
pnpm --filter @claude-task/backend exec vitest run test/gitlab.contract.test.ts
```

Normal tests never contact GitHub or GitLab.

API contracts used: GitHub [installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app),
[branch rules and rulesets](https://docs.github.com/en/rest/repos/rules),
[classic branch protection](https://docs.github.com/en/rest/branches/branch-protection);
GitLab [projects](https://docs.gitlab.com/api/projects/),
[merge requests](https://docs.gitlab.com/api/merge_requests/),
[protected branches](https://docs.gitlab.com/api/protected_branches/),
[personal access token rotation](https://docs.gitlab.com/api/personal_access_tokens/).
