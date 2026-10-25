/** Provider-independent Git Integration shapes (Spec 03). */
export interface RepositoryRef {
  provider: 'github';
  providerRepoId: string;
  owner: string;
  name: string;
}
export interface Repository extends RepositoryRef {
  defaultBranch: string;
  private: boolean;
  cloneUrl: string;
  webUrl: string;
}
export interface GitInstallation {
  id: string;
  account: string;
  url: string;
}
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
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  checkedAt: string;
}
export interface GitHubAppSettings {
  appId: string | null;
  configured: boolean;
  privateKeyConfigured: boolean;
  source: 'environment' | 'database' | 'none';
}
