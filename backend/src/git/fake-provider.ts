import type { BranchProtection, GitInstallation, Repository, RepositoryRef } from '@claude-task/shared';
import { GitProviderError } from './provider';
import type { GitProvider, PullRequestInput, RepositoryToken } from './provider';

export class FakeGitProvider implements GitProvider {
  configured = true;
  readonly repositories = new Map<string, Repository>();
  readonly branches = new Map<string, Set<string>>();
  readonly protection = new Map<string, boolean | null>();
  readonly pullRequests = new Map<string, { number: number; url: string; state: 'open' | 'closed' | 'merged'; draft: boolean; input: PullRequestInput }[]>();
  issued: { repositoryId: string; token: string }[] = [];
  constructor() {
    this.addRepository('1', 'acme', 'example');
    this.addRepository('2', 'acme', 'other');
  }
  addRepository(id: string, owner: string, name: string, defaultBranch = 'main') {
    this.repositories.set(id, {
      provider: 'github',
      providerRepoId: id,
      owner,
      name,
      defaultBranch,
      private: true,
      cloneUrl: `https://github.com/${owner}/${name}.git`,
      webUrl: `https://github.com/${owner}/${name}`,
    });
    this.branches.set(id, new Set([defaultBranch]));
    this.protection.set(id, true);
  }
  async isConfigured() {
    return this.configured;
  }
  async listInstallations(): Promise<GitInstallation[]> {
    return [{ id: '10', account: 'acme', url: 'https://github.com/acme' }];
  }
  async listAccessibleRepositories() {
    if (!this.configured) throw new GitProviderError('GitHub App is not configured', 409);
    return [...this.repositories.values()];
  }
  async getRepository(ref: RepositoryRef) {
    const r = this.repositories.get(ref.providerRepoId);
    if (!r) throw new GitProviderError('Repository not found', 404);
    return r;
  }
  async branchExists(ref: RepositoryRef, branch: string) {
    return this.branches.get(ref.providerRepoId)?.has(branch) ?? false;
  }
  async checkBaseBranchProtection(ref: RepositoryRef, _branch: string): Promise<BranchProtection> {
    return {
      protected: this.protection.get(ref.providerRepoId) ?? null,
      details: 'Fake protection result',
      settingsUrl: `${(await this.getRepository(ref)).webUrl}/settings/rules`,
      checkedAt: new Date().toISOString(),
    };
  }
  async issueRepositoryToken(ref: RepositoryRef): Promise<RepositoryToken> {
    const token = `fake-git-token-${ref.providerRepoId}-${this.issued.length}`;
    this.issued.push({ repositoryId: ref.providerRepoId, token });
    return { token, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  }
  branchWebUrl(ref: RepositoryRef, branch: string) {
    return `https://github.com/${ref.owner}/${ref.name}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  }
  async upsertPullRequest(ref: RepositoryRef, input: PullRequestInput) {
    const prs = this.pullRequests.get(ref.providerRepoId) ?? [];
    let pr = prs.find((p) => p.state === 'open' && p.input.head === input.head);
    if (pr) pr.input = { ...input, draft: pr.draft };
    else {
      pr = { number: prs.length + 1, url: `${(await this.getRepository(ref)).webUrl}/pull/${prs.length + 1}`, state: 'open', draft: input.draft, input };
      prs.push(pr);
    }
    this.pullRequests.set(ref.providerRepoId, prs);
    return { number: pr.number, url: pr.url, state: pr.state, draft: pr.draft };
  }
  async getPullRequest(ref: RepositoryRef, number: number) {
    const pr = this.pullRequests.get(ref.providerRepoId)?.find((p) => p.number === number);
    if (!pr) throw new GitProviderError('Pull request not found', 404);
    return { number: pr.number, url: pr.url, state: pr.state, draft: pr.draft };
  }
}
