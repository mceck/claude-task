import type { BranchProtection, GitInstallation, PullRequest, Repository, RepositoryRef } from '@claude-task/shared';

export interface RepositoryToken {
  token: string;
  expiresAt: string;
}
export interface PullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}
/** The only boundary where provider-specific behavior belongs. Tokens never reach browsers. */
export interface GitProvider {
  isConfigured(): Promise<boolean>;
  listInstallations(): Promise<GitInstallation[]>;
  listAccessibleRepositories(): Promise<Repository[]>;
  getRepository(ref: RepositoryRef): Promise<Repository>;
  checkBaseBranchProtection(ref: RepositoryRef, branch: string): Promise<BranchProtection>;
  issueRepositoryToken(ref: RepositoryRef): Promise<RepositoryToken>;
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
