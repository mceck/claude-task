/** Provider-independent Git Integration shapes (docs/specs/git-integration.md). */
export type GitProviderKind = 'github' | 'gitlab';

export interface RepositoryRef {
  /** The Git Connection the Repository is reached through. */
  connectionId: string;
  provider: GitProviderKind;
  providerRepoId: string;
  /** GitHub owner, or GitLab namespace full path (nested groups allowed). */
  owner: string;
  name: string;
}
export interface Repository extends RepositoryRef {
  defaultBranch: string;
  private: boolean;
  /** The provider's HTTPS clone URL, used only by the Git Proxy upstream. */
  cloneUrl: string;
  webUrl: string;
}
export interface GitAccess {
  /** A GitHub App Installation's account, or the GitLab user a token belongs to. */
  label: string;
  url: string;
}
/** Informational only: the Git Proxy's Push Policy is what keeps Agents off the Base Branch. */
export interface BranchProtection {
  protected: boolean | null;
  details: string;
  settingsUrl: string;
  checkedAt: string;
}
export interface ProjectRepository extends Repository {
  baseBranch: string;
  protection: BranchProtection;
}
export interface RepositorySettings {
  repository: ProjectRepository | null;
  /** Includes paused sessions: the repository must not change under a resumable session. */
  hasOpenSessions: boolean;
}
export interface PullRequest {
  /** GitLab calls it a merge request (`!N`); GitHub a pull request (`#N`). */
  provider: GitProviderKind;
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  checkedAt: string;
}

/** How one uncommitted file of a Worktree changed, from `git status`. */
export const WORKTREE_FILE_STATUSES = ['modified', 'added', 'deleted', 'renamed', 'copied', 'type-changed', 'untracked', 'conflicted'] as const;
export type WorktreeFileStatus = (typeof WORKTREE_FILE_STATUSES)[number];

/** One file of a Worktree with uncommitted changes. */
export interface WorktreeFile {
  /** Relative to the Worktree. */
  path: string;
  status: WorktreeFileStatus;
}

/** A Worktree's uncommitted changes, as read in the Worker Volume. */
export interface WorktreeStatus {
  /** When the backend stored the read. */
  capturedAt: string;
  /** At most the cap; `total` counts the rest too. */
  files: WorktreeFile[];
  total: number;
  /** More changes than `files` holds. */
  truncated: boolean;
}

/** Why a live Worktree read didn't happen. */
export type WorktreeStatusReason = 'no-session' | 'no-repository' | 'no-worktree' | 'no-runner' | 'error';

/** The Task view's Changes dialog: a live read, or the last one kept on the Session. */
export interface TaskWorktreeStatus {
  /** Null when no Runner has read it yet. */
  status: WorktreeStatus | null;
  /** Whether a Runner answered just now. */
  live: boolean;
  /** Why there is no live answer; null when `live`. */
  reason: WorktreeStatusReason | null;
}

/** A Runner's failure reading a Worktree. */
export type WorktreeStatusError = 'not-found' | 'not-a-worktree' | 'failed';

export type GitConnectionHealth =
  | { state: 'ok' }
  | { state: 'error'; message: string }
  /** The token expires soon and won't be rotated automatically (environment, or rotation failed). */
  | { state: 'expiring'; expiresAt: string; message: string };

export interface GitConnectionSummary {
  id: string;
  provider: GitProviderKind;
  name: string;
  /** e.g. `github.com`, `gitlab.example.com`. */
  host: string;
}
export interface GitConnection extends GitConnectionSummary {
  /** Environment connections are read-only and never rotated. */
  source: 'database' | 'environment';
  /** GitHub App ID; null for GitLab. */
  appId: string | null;
  /** GitLab base URL; null for GitHub. */
  baseUrl: string | null;
  /** Last 4 characters of a GitLab token; null for GitHub private keys. */
  secretLast4: string | null;
  /** GitLab token expiry, when known. */
  expiresAt: string | null;
  access: GitAccess[];
  health: GitConnectionHealth;
  linkedProjects: number;
}
export interface RepositoryGroup {
  connection: GitConnectionSummary;
  repositories: Repository[];
  /** Set when the connection couldn't list repositories; the other groups still show. */
  error: string | null;
}

export const pullRequestNoun = (provider: GitProviderKind) => (provider === 'gitlab' ? 'merge request' : 'pull request');
export const pullRequestRef = (pr: Pick<PullRequest, 'provider' | 'number'>) => `${pr.provider === 'gitlab' ? '!' : '#'}${pr.number}`;
