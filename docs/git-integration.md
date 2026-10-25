# Git Integration — configuration and verification

Implementation of [Spec 03](spec/03-git-integration.md).

## Configure the GitHub App

Create a GitHub App with repository permissions:

- Contents: read/write
- Pull requests: read/write
- Metadata: read
- Administration: read (to inspect branch protection and ruleset bypass lists)

Install it on the organization or account and grant access to the repositories to
link. Webhooks are not needed. As an admin, open **GitHub** in the sidebar and save
the App ID and RSA PEM private key. The key is encrypted with `SECRETS_MASTER_KEY`,
write-only, and cannot be read back through the API or UI. Saving an empty key keeps
the current one. The page also lists installations and accessible repositories.

Alternatively, set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in the backend
configuration. Both must be present; environment configuration takes precedence
and the admin form becomes read-only. Escaped `\n` in a quoted private key value
is supported. Keep keys out of agent Dockerfiles and containers.

Set `APP_URL` to the public web address, e.g. `https://tasks.example.com`. This is
used in PR footers and differs from `AGENT_BACKEND_URL`, the internal address used
by agent containers. `AGENT_COMMIT_EMAIL_DOMAIN` defaults to
`agents.claude-task.local`; agent commits use `<agent name> (claude-task)`.

## Link a project and work on tasks

Open **Project settings → Repository**, search accessible repositories, select
one and save. The base branch defaults to the repository's default branch and is
validated on GitHub. Repository changes are blocked while any session in the
project is non-closed, including paused sessions. Unassigning an agent pauses its
session; close the task before changing repository. The base branch can be changed
without changing repository. Old PR links are cleared when the repository changes.

Require pull requests on the base branch, and do not grant the App a direct-push
bypass. Missing or unverifiable protection shows a warning in project settings and
on the board; it does not prevent work. Re-check after editing GitHub settings.
Checks also run daily. An Administration permission failure reports **Unknown**.

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

The Base Image installs `git-credential-claude-task` and Git's `useHttpPath` setting
for github.com. `git fetch`, `pull` and plain `push` work through a private mode-0600
Unix socket under the agent's home. The runner requests credentials only for its
current job's repository. The backend additionally requires an accepted job in
`running` or `finishing` and the exact project repository. Tokens are restricted
to one repository and Contents: write; PR-writing tokens stay in the backend.
Both caches refresh five minutes before expiry, and the runner clears its cache
at job end. Git tokens never appear in remotes, job environment, raw session
events or browser API responses. `store`/`erase` in the helper are no-ops.

Agents commit and push, then call `open_pull_request(title, body, draft?)` through
the existing task MCP server. An unpushed branch produces a clear tool error.
An open PR for the head/base is updated; a closed or merged PR leads to a new PR.
The body includes a task link and agent attribution. PR changes create a Revision
attributed to the Agent and a system comment. Task views show branch/PR links;
board cards show open, draft, closed or merged badges.

Open/draft PRs are polled every five minutes. Opening a task also refreshes its PR
when the last check is older than one minute. PR state never changes Task Status
or Session lifecycle.

## Checks

- `pnpm typecheck`
- `pnpm test`: real PostgreSQL with fake GitProvider and Runner; GitHub adapter
  tests use a local HTTP server and verify real JWT signatures, token scopes,
  refresh behavior, PR requests, ruleset bypass and classic branch protection.
- `cd runner && go test ./...`: real runner/helper subprocesses, a fake backend,
  local bare git remotes, token denial/cache/refresh and job-end invalidation.
- `pnpm test:e2e`: browser flow for repository linking, protection checks, PR links
  and state updates, session locking, and write-only GitHub App settings.
- `docker build -t claude-task .`: production app image, including Base Image
  recipe and runner/helper sources. Runner/Base Image changes automatically
  rebuild agent images using the existing wait-for-idle rule.

A live read-only contract check is opt-in, using a dedicated test installation:

```sh
GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY='...' \
GITHUB_CONTRACT_REPOSITORY=test-org/test-repository \
pnpm --filter @claude-task/backend exec vitest run test/github.contract.test.ts
```

Normal tests never contact GitHub. The live contract and a real Docker/Claude
push-and-PR smoke require operator-provided GitHub App credentials and repository
access. They are not implied by the local fake-provider results. The real-Claude
spike remains separately tracked by ADR 0005 in Spec 02.

GitHub API contracts used here: [installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app),
[branch rules and rulesets](https://docs.github.com/en/rest/repos/rules), and
[classic branch protection](https://docs.github.com/en/rest/branches/branch-protection).

## Verification on 2026-10-25

233 backend tests and 16 Playwright tests passed, along with the workspace typecheck
and Go runner/helper tests. Race-instrumented runner/helper checks passed for the
credential and worktree scenarios. Both production app and Base Image builds passed;
the Base Image runs as uid 1000, uses the installed helper with `useHttpPath=true`,
and refuses credentials without the Runner. A production-container smoke passed
startup, fresh-database migrations, login, Git settings and project/task APIs.
The live GitHub contract was skipped because test App/repository credentials were
not configured. No PRs were created on a real GitHub repository during these checks.
