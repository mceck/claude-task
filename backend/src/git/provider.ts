import type { BranchProtection, GitAccess, GitProviderKind, PullRequest, Repository, RepositoryRef } from '@claude-task/shared';

export interface PullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}
/** Where the Git Proxy forwards a Repository's git traffic. Never leaves the backend. */
export interface GitUpstream {
  url: string;
  username: string;
  password: string;
}
export interface GitIdentity {
  access: GitAccess[];
  /** Token expiry, when the provider's credential expires (GitLab). */
  expiresAt: string | null;
}
/**
 * One Git Connection's provider: the only boundary where provider-specific behavior belongs.
 * Credentials never reach browsers or Agent Containers.
 */
export interface GitProvider {
  readonly kind: GitProviderKind;
  /** Checks the credential; throws a GitProviderError saying what's wrong. */
  validate(): Promise<GitIdentity>;
  listAccessibleRepositories(): Promise<Repository[]>;
  getRepository(ref: RepositoryRef): Promise<Repository>;
  /** Informational: the Git Proxy's Push Policy is the guard. */
  checkBaseBranchProtection(ref: RepositoryRef, branch: string): Promise<BranchProtection>;
  gitUpstream(repository: Repository): Promise<GitUpstream>;
  branchExists(ref: RepositoryRef, branch: string): Promise<boolean>;
  upsertPullRequest(ref: RepositoryRef, input: PullRequestInput): Promise<Omit<PullRequest, 'checkedAt'>>;
  getPullRequest(ref: RepositoryRef, number: number): Promise<Omit<PullRequest, 'checkedAt'>>;
  branchWebUrl(ref: RepositoryRef, branch: string): string;
}
export class GitProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
