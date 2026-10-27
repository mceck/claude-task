---
status: done
---

# Git integration: Git Connections, Task Branches, Worktrees, Git Proxy and Pull Requests

## Specs

- [Git integration](../specs/git-integration.md)

## Problem Statement

Every Project corresponds to a code Repository, and the team keeps code on github.com, gitlab.com and self-managed GitLab instances. When an Agent works on a Task it needs its own isolated checkout on a dedicated branch, a way to fetch and push that works only for that Repository and only while it is working, and a way to hand the work back to humans for review. Agents run with full permissions and no platform hooks, so a long-lived provider token inside the container could reach every repository the token can see, and nothing technical would keep an Agent off the Base Branch. GitLab also has nothing equivalent to GitHub's short-lived, single-repository installation tokens. Finally, people want to see from the Board which branch and Pull Request belong to each Task and whether it was merged, without opening the provider.

## Solution

Admins configure any number of Git Connections: GitHub Apps and GitLab instances (URL and access token), each checked against the provider when saved, with write-only secrets. Members link each Project's Repository by picking it from every connection, grouped by connection, and choose the Base Branch. Each Task worked by an Agent gets a stable Task Branch named after its Task Key and title, and a Worktree at a deterministic path in the Agent Volume. Agents use plain git, but their `origin` is the backend's Git Proxy: it admits only the active Job's Repository, authenticates with the Job token, accepts pushes to the Task Branch alone (force pushes included) and forwards traffic to the provider with the connection's credential, which never leaves the backend. When ready, the Agent calls `open_pull_request`, which opens or updates a pull request on GitHub or a merge request on GitLab with a link back to the Task. Branch and Pull Request links and states show on the Task and its card, kept fresh by polling. Provider-side Base Branch Protection is shown in Repository settings for information only. Stored GitLab tokens rotate themselves before expiring.

## User Stories

### Git Connections (Admins)

1. As an Admin, I want to see all Git Connections in one place, with provider, name, host and health, so that I know which code hosts the platform can reach.
2. As an Admin, I want to add a GitHub connection by entering a GitHub App ID and private key, so that I can link repositories of that App's installations.
3. As an Admin, I want to add more than one GitHub App connection, so that separate organizations or Apps can be used side by side.
4. As an Admin, I want to add a GitLab connection by entering the instance URL (default `https://gitlab.com`) and a token, so that I can link repositories hosted on gitlab.com or on a self-managed GitLab.
5. As an Admin, I want to add several GitLab connections, such as gitlab.com and a self-managed instance, so that all our code hosts are available.
6. As an Admin, I want to give every connection a display name, so that I can tell connections to the same provider apart.
7. As an Admin, I want the GitLab token checked when I save it (validity, `api` and `write_repository` scopes, expiry, owning user), so that a wrong token fails right away instead of during an Agent's Job.
8. As an Admin, I want a clear error when the GitLab URL isn't reachable or isn't a GitLab instance, so that I can fix typos.
9. As an Admin, I want a GitHub private key checked as a valid RSA key and the App checked against GitHub when I save it, so that a broken App configuration fails immediately.
10. As an Admin, I want secrets (private keys, tokens) to be write-only, with GitLab tokens showing only their last 4 characters, so that nobody can read them back through the UI or API.
11. As an Admin, I want to replace a connection's secret without re-linking any Project, so that I can rotate credentials safely.
12. As an Admin, I want to see a GitLab token's expiry date, so that I know when it needs attention.
13. As an Admin, I want GitLab tokens saved from the UI rotated automatically before they expire, so that Agents don't stop working on the day a token expires.
14. As an Admin, I want a warning when a token is about to expire and won't be rotated automatically (set through the environment, or rotation failed), so that I can renew it in time.
15. As an Admin, I want to see which GitHub installations or which GitLab user each connection works as, so that I know what can be linked.
16. As an Admin, I want connections defined through environment variables to show up read-only, so that infrastructure-managed configuration stays the source of truth.
17. As an Admin, I want deleting a connection refused while any Project or Wiki links one of its Repositories, so that linked Projects never lose their code host.
18. As an Admin, I want a connection's provider and GitLab URL fixed once created, so that linked Repository identities stay valid; to move hosts I create a new connection.
19. As an Admin, I want the GitHub App's required permissions shown in the add dialog, so that I configure the App correctly the first time.

### Linking Repositories (Members)

20. As a Member, I want the repository picker to list Repositories from every connection, grouped and labelled by connection, so that I can choose a GitHub or GitLab Repository the same way.
21. As a Member, I want to search Repositories by owner, group and name, including nested GitLab groups, so that I can find them quickly.
22. As a Member, I want a connection that can't be reached to show an error row without hiding the others, so that one broken connection doesn't block linking.
23. As a Member, I want the Base Branch to default to the Repository's default branch and be validated on the provider, so that Agents branch from the right place.
24. As a Member, I want changing a Project's Repository, even to another connection or provider, blocked while any Session in the Project is non-closed (paused ones included), so that running work isn't pointed at the wrong code.
25. As a Member, I want old Pull Request links cleared when the Repository changes, so that Tasks never point at another Repository's Pull Requests.
26. As a Member, I want Repository settings to show whether the provider also protects the Base Branch (Protected, Not protected, Unknown), with an explanation, a link to the provider's settings and a re-check button, so that I can add a second line of defense if I want to.
27. As a Member, I want no Board warnings about Base Branch Protection, because the platform blocks pushes to the Base Branch itself.

### Task Branches and Worktrees

28. As a Member, I want each Task worked by an Agent to get a stable, readable branch name derived from its Task Key and title, so that I can find it on the provider.
29. As a Member, I want the Task Branch name to stay fixed after it's chosen even if the Task's title changes or it's reassigned, so that links don't break.
30. As an Agent, I want my Task's Worktree ready on the Task Branch when my Job starts, so that I can start working immediately.
31. As an Agent, I want my Worktree to continue from the remote Task Branch when it already exists (reopened Task, reassignment), so that previous work is preserved.
32. As an Agent, I want an existing Worktree left untouched between Jobs, so that my uncommitted changes survive.
33. As an Agent, I want my Worktree to keep its deterministic path, so that my Session resumes in the same working directory.
34. As a Member, I want a System Comment when a reopened Task's remote branch was deleted and its Worktree was recreated from the Base Branch, so that I know previous work wasn't found.
35. As a Member, I want commits made by an Agent to carry the Agent's name, so that history shows who did what.
36. As an Admin, I want Worktrees removed when Tasks close, while repositories and branches stay, so that Agent Volumes don't grow forever.
37. As a Member, I want a provider outage during dispatch to hold only that Task with a Retry, so that the rest of the Agent's Queue keeps moving.

### Agents and git

38. As an Agent, I want `git fetch`, `pull` and `push` to just work without handling credentials, whatever the provider, so that I can use git normally.
39. As an Agent, I want to be able to force-push my Task Branch, so that I can rebase my work.
40. As an Agent, I want a clear git error when I try to push anything other than my Task Branch, including tags and deletions, so that I understand why it was refused.
41. As an Agent, I want my git requests refused outside an active Job or for another Project's Repository, so that a mistake can't affect other code.
42. As an operator, I want no provider token to ever exist inside an Agent Container, so that a compromised container can't reach other repositories.
43. As an Admin, I want proxy activity logged (Agent, Job, Project, operation, refs, status, bytes) without any credential, so that I can debug git problems safely.

### Pull Requests

44. As an Agent, I want a tool that opens a pull request from my Task Branch to the Base Branch, or updates the open one, so that I can hand off my work for review.
45. As an Agent working on GitLab, I want the same tool to open or update a merge request, including drafts, so that I hand off work the same way on both providers.
46. As an Agent, I want a clear error from `open_pull_request` when my branch hasn't been pushed yet, so that I know to push first.
47. As a Member, I want Pull Requests opened by Agents to include a link back to the Task and the Agent's name, so that reviewers have context.
48. As a Member, I want a new Pull Request created when the previous one was closed or merged, so that further work can be reviewed.
49. As a Member, I want a System Comment and a Revision when an Agent opens or updates a Pull Request, so that the Timeline shows the hand-off.
50. As a Member, I want the branch link and the Pull Request link with a state badge (open, draft, merged, closed) on the Task view and the card, so that I can jump to the code and see its status.
51. As a Member, I want GitLab merge requests labelled "merge request" with `!N`, and GitHub ones "pull request" with `#N`, so that the UI speaks each provider's language.
52. As a Member, I want Pull Request state on the Board to update within 5 minutes of changes on the provider, and when I open a Task, so that I see what got merged without opening the provider.
53. As a Member, I want Pull Request state changes to leave Task Status and Sessions alone, so that humans decide when a Task is done.

## Implementation Decisions

- **Git Connections**: a table of connections with id, provider (`github` or `gitlab`), name, provider configuration (GitHub App ID; GitLab base URL, token user name and expiry), encrypted secret, secret last 4 (GitLab only), rotation error and timestamps. Provider and GitLab URL are immutable; name and secret are editable. Environment variables define read-only `env-github` (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, escaped `\n` supported) and `env-gitlab` (`GITLAB_URL`, `GITLAB_TOKEN`) connections that are never stored or rotated. `GITLAB_ALLOW_HTTP` admits `http` GitLab URLs for development.
- **Provider registry**: the app context exposes a registry that lists connections and resolves a provider adapter per connection id. Adapter instances are cached per connection and rebuilt when the connection changes. Every caller (linking, dispatch, proxy, `open_pull_request`, polling, protection) resolves the provider from the Project's Repository's connection.
- **Provider interface**: validate the credential (identity and expiry), list accessible Repositories, read a Repository with an identity check, check branch existence, build branch web links, check Base Branch Protection (informational), give the Git Proxy its upstream (URL, username, password; backend only), upsert a Pull Request and read its state. GitLab adds token rotation.
- **GitHub adapter**: App JWT, installation lookup per Repository, installation tokens limited to one Repository and per-operation permissions, cached until 5 minutes before expiry and dropped when the App credentials change. The proxy upstream uses `x-access-token` with a Contents-write token on that Repository only. Required App permissions: Contents read/write, Pull requests read/write, Metadata read; Administration read is optional (protection status).
- **GitLab adapter**: REST API v4 under the connection URL with `PRIVATE-TOKEN`. Validation through the token-self and user endpoints. Listing: non-archived projects with at least Developer access, paginated. Upstream: `oauth2` with the token, on a URL built from the connection's URL and the project path rather than GitLab's reported clone URL. Merge requests use the `Draft: ` prefix and keep an existing draft state on update.
- **Shared rules for adapters**: 15-second request timeout, redirects refused, errors reduced to short messages with the HTTP status, never provider bodies or credentials.
- **Token rotation**: stored GitLab tokens expiring within 14 days rotate to a 90-day expiry (falling back to the instance default when the expiry is refused), under a per-connection advisory lock with the token re-read under it. Failures are stored as health and retried after one hour. Admin edits take the same lock.
- **Linking**: the Project stores the Repository (connection id, provider, provider repository id, owner, name, default branch, private, clone and web URLs), the Base Branch and the last protection result. Changing Repository requires every Session in the Project to be closed and clears every Task's Pull Request and branch link. Linking and connection deletion are serialized by the connection lock.
- **Task Branch**: `task/<lowercase key>-<ASCII slug of at most 40 characters>`, computed at the first dispatch with a Repository, stored with the branch web link, fixed afterwards. A provider failure during the branch lookup holds the Queue Entry with a System Comment and Retry.
- **Job start git section**: Git Proxy URL of the Project, Job token, Repository identity `<connection id>/<provider repository id>`, Base Branch, Task Branch, remote existence hint, bare clone path, commit name `<Agent name> (claude-task)` and email `<agent slug>@<AGENT_COMMIT_EMAIL_DOMAIN>` (default `agents.claude-task.local`). The Runner Protocol is at version 2, without any token request message.
- **Runner Worktree preparation**: bare clone per Project, Worktree per Task at `worktrees/<project id>/<Task Key>`; origin set to the proxy URL; Repository identity recorded in the bare clone, with clones of another identity discarded and clones without one adopted; existing Worktrees untouched; new ones from the remote Task Branch or the Base Branch with upstream preset; `.claude-task/` excluded; report of creation and missing remote branch.
- **Credential helper**: configured system-wide in the Base Image with path-aware requests. It asks the Runner over a mode-0600 Unix socket, and the Runner returns the Job token only for the current Job's exact proxy URL. No backend round trip, no cache.
- **Git Proxy**: smart HTTP routes outside the API prefix on the main listener, Basic auth with the Job token, Job `running` or `finishing` for the same Project, streaming in both directions with a 5-minute idle timeout, git-relevant headers only, Push Policy on the command section (64 KiB decoded, 1 MiB raw) with a git push report for rejections, upstream failures as `502` with sanitized messages, logging without credentials.
- **`open_pull_request`**: title (1 to 500 characters), body (up to 100,000), optional draft. Checks the active Job and the remote branch, appends the Task link and Agent footer, upserts on the provider, stores the Pull Request, records a Revision attributed to the Agent when it changed, and posts a System Comment in the provider's vocabulary.
- **Sync**: a background loop at start and every 5 minutes rotates tokens, refreshes open Pull Requests, and re-checks protection older than 24 hours. Opening a Task refreshes its Pull Request when the last check is older than 1 minute. Stale responses are discarded.
- **API**: Admin-only list, create, update and delete of Git Connections with live health; repository groups for every User; read and set a Project's Repository; re-check protection. The previous single-App endpoints are gone.
- **UI**: a "Git" sidebar page for Admins with connection cards, an add and edit dialog per provider, environment connections read-only and delete disabled when linked; the Repository tab with the grouped picker, the Base Branch field and the informational protection section; branch link and Pull Request badge on the Task view, card and Wiki page.

## Testing Decisions

- **Backend public API** against real Postgres with the fake Runner, fake runtime and a fake provider registry. The fake provider's upstream is a local `git http-backend` behind Basic auth over bare repositories, and the tests drive the real `git` CLI against the Git Proxy. Covered: connection management as Admins only, write-only secrets, read-only environment connections, grouped picker with a failing connection, linking GitLab Repositories in nested groups, linking against a connection deleted meanwhile, Base Branch validation and protection re-check, Repository changes blocked by non-closed Sessions, stable ASCII Task Branches across renames and reassignment, Worktree and commit configuration in the Job start, `open_pull_request` (unpushed branch, create, update, new after closure, footer, Revision, GitLab vocabulary), Pull Request refresh on Task open and polling of open Pull Requests and protection, Worktree removal on close and the missing remote branch notice, a provider outage holding only that Task. Proxy: proxy URL and Job token in the Job start, clone, fetch, push and force push of the Task Branch, refused deletion, gzip-encoded commands, endless gzip bodies, wrong content types, shallow-clone pushes, protocol v2 with gzip, `401` challenge, `403` for other Projects and finished Jobs, upstream credential failure as `502` without leaks.
- **Provider adapters** against local fake HTTP servers: GitHub JWT signing, installation tokens limited to one Repository and permission set with caching and refresh, protection interpretation (rulesets, bypass lists, classic protection, missing Administration read), Pull Request upsert and merged mapping, sanitized errors. GitLab token validation and scopes, non-GitLab URLs, pagination and nested namespaces, Repository and branch lookups, draft merge requests and kept draft state, unknown protection, no token in errors.
- **GitLab token rotation**: one rotation under concurrency with the new token working, Admin saves during a rotation, distant expiries untouched, fallback when the instance caps lifetimes, failure shown as expiry health, environment tokens warned and never rotated.
- **Runner as a black box** with local bare git remotes: new Task Branch Worktree, Worktree from an existing remote branch, later Jobs fetch and keep the Worktree, removal keeps branches, deleted remote branch recreated from the latest Base Branch, Repository change discards old branch commits, origin moved to the proxy keeps clones and Worktrees, another Repository behind the same proxy URL. Credential helper serves only the active Job's proxy URL and denies Jobs without a token.
- **Playwright**: linking a Repository with Base Branch validation, informational protection and locking with open Sessions; adding write-only GitHub and GitLab connections and linking a GitLab Repository from the grouped picker.
- **Opt-in live contracts**: read-only GitHub and GitLab contract tests against dedicated resources, gated by environment credentials.

## Acceptance Criteria

- [x] Admins can create, edit (name and secret) and delete GitHub App and GitLab connections, several per provider. Secrets are write-only, GitLab tokens show their last 4 characters, environment connections show read-only, and deleting a linked connection is refused.
- [x] Saving a GitLab connection with an invalid token, a missing `api` or `write_repository` scope, an expired token or an unreachable or non-GitLab URL fails with a specific message.
- [x] The repository picker lists Repositories of all connections, grouped and labelled; a broken connection shows an error row and doesn't hide the others.
- [x] A Project can link a GitHub or GitLab Repository, including one in a nested group, with the Base Branch defaulting to the default branch and validated on the provider.
- [x] Changing a Project's Repository is refused while any of its Sessions is non-closed, and clears Pull Request links when it happens.
- [x] The first Job of a Task creates the bare clone if needed and a Worktree at the deterministic path on `task/<key>-<slug>` from the latest Base Branch, with commit identity set and `.claude-task/` excluded.
- [x] The Task Branch name is stored on first dispatch and stays the same when the title changes or the Task is reassigned.
- [x] Inside an Agent Container, `git fetch`, `pull`, `push` and force push of the Task Branch work through the Git Proxy, and no provider token exists in the container.
- [x] Pushes to any other ref, tag pushes and deletions are refused with a readable message, and the upstream is unchanged.
- [x] Proxy requests without credentials get a Basic challenge; requests without an active Job for that Project are refused.
- [x] Existing Worktrees keep their path, Session working directory and uncommitted changes, including when origin moves to the Git Proxy.
- [x] `open_pull_request` fails with a clear message when the branch isn't pushed, and otherwise creates or updates the Pull Request (merge request on GitLab, drafts included) with the Task link footer, a Revision and a System Comment in the provider's vocabulary.
- [x] Pull Request state shows on cards with `#N` or `!N` badges, updates within 5 minutes for open Pull Requests and on opening a Task, and never changes Task Status or Sessions.
- [x] Closing a Task removes its Worktree but keeps local and remote branches; reopening recreates the Worktree at the same path from the remote Task Branch.
- [x] Stored GitLab tokens are rotated before expiring and keep working; concurrent rotations make a single rotate call; environment tokens show an expiry warning from 14 days out.
- [x] Base Branch Protection is shown only in Repository settings as an informational status with re-check, with no Board or banner warnings.
- [x] No token or credential appears in logs, API responses or error messages.
- [ ] The live GitHub and GitLab contract tests pass against dedicated test resources.
- [ ] An opt-in end-to-end smoke with real Docker and `claude` pushes through the Git Proxy to a throwaway GitHub repository and a throwaway GitLab project and opens a Pull Request on each.

## Out of Scope

- Providers other than GitHub and GitLab (Bitbucket, Gitea or Forgejo, Azure DevOps), and GitHub Enterprise Server. The connection model and the proxy leave room for them.
- Git LFS through the proxy, SSH remotes, submodules pointing to other repositories.
- Webhooks, CI or pipeline status, Pull Request comments and approvals, reading review comments back into the Task.
- Automatic Pull Request creation, or Task Status changes driven by Pull Request events.
- GitLab OAuth applications and per-user provider authorization.
- Moving an existing connection to another host.
- Restricting fetches to particular refs.
- Signed commits, and push rules beyond the Task Branch Push Policy.
- Special handling for monorepos with several Projects on one Repository.

## Further Notes

- Builds on the core board, the agents runtime and the Runner Protocol; its decisions are recorded in the Decisions section of [Git integration](../specs/git-integration.md).
- Existing single-App GitHub settings were migrated into a stored connection, and linked Repositories kept working without re-linking.
- All Agent git traffic passes through the backend, so large first clones are slower and use the backend host's bandwidth; later fetches are incremental.
- The Job token travels over the internal `AGENT_BACKEND_URL`, unencrypted on a plain-HTTP internal network, exactly as the Task Tools token does.
- The live contract tests need `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_CONTRACT_REPOSITORY`, or `GITLAB_CONTRACT_URL`, `GITLAB_CONTRACT_TOKEN` and `GITLAB_CONTRACT_PROJECT`; they were not run without dedicated credentials. No real Docker push smoke exists yet.
