import type { BranchProtection, GitProviderKind, Repository, RepositoryRef } from '@claude-task/shared';
import type { ProviderFactory } from './connections';
import { GitProviderError } from './provider';
import type { GitIdentity, GitProvider, GitUpstream, PullRequestInput } from './provider';

/** In-memory provider for tests and the e2e server; one per provider kind, shared by its connections. */
export class FakeGitProvider implements GitProvider {
  readonly repositories = new Map<string, Repository>();
  readonly branches = new Map<string, Set<string>>();
  readonly protection = new Map<string, boolean | null>();
  readonly pullRequests = new Map<string, { number: number; url: string; state: 'open' | 'closed' | 'merged'; draft: boolean; input: PullRequestInput }[]>();
  /** Set to make `validate` (and so connection saves) fail. */
  invalid: string | null = null;
  /** Set to make repository listing fail. */
  unreachable: string | null = null;
  /** A real git smart HTTP server (`<baseUrl>/<owner>/<name>.git`) for Git Proxy tests. */
  upstream: { baseUrl: string; username: string; password: string } | null = null;
  constructor(
    readonly kind: GitProviderKind = 'github',
    readonly connectionId = 'env-github',
  ) {
    if (kind === 'github') {
      this.addRepository('1', 'acme', 'example');
      this.addRepository('2', 'acme', 'other');
    } else {
      this.addRepository('101', 'acme/platform', 'service');
      this.addRepository('102', 'acme', 'tools');
    }
  }
  private get web() {
    return this.kind === 'github' ? 'https://github.com' : 'https://gitlab.example.com';
  }
  addRepository(id: string, owner: string, name: string, defaultBranch = 'main') {
    this.repositories.set(id, {
      connectionId: this.connectionId,
      provider: this.kind,
      providerRepoId: id,
      owner,
      name,
      defaultBranch,
      private: true,
      cloneUrl: `${this.web}/${owner}/${name}.git`,
      webUrl: `${this.web}/${owner}/${name}`,
    });
    this.branches.set(id, new Set([defaultBranch]));
    this.protection.set(id, true);
  }
  /** The same fake behind every connection of its kind, stamped with that connection's id. */
  static factory(fakes: () => { github: FakeGitProvider; gitlab: FakeGitProvider }): ProviderFactory {
    return (record) => fakes()[record.provider].bind(record.id);
  }
  private bind(connectionId: string): GitProvider {
    const stamp = <T extends { connectionId: string }>(r: T): T => ({ ...r, connectionId });
    return Object.assign(Object.create(this) as FakeGitProvider, {
      listAccessibleRepositories: async () => (await this.listAccessibleRepositories()).map(stamp),
      getRepository: async (ref: RepositoryRef) => stamp(await this.getRepository(ref)),
    });
  }
  async validate(): Promise<GitIdentity> {
    if (this.invalid) throw new GitProviderError(this.invalid, 400);
    return {
      access: [{ label: this.kind === 'github' ? 'acme' : 'claude-task-bot', url: `${this.web}/acme` }],
      expiresAt: this.kind === 'gitlab' ? new Date(Date.now() + 90 * 24 * 3600000).toISOString() : null,
    };
  }
  async listAccessibleRepositories() {
    if (this.unreachable) throw new GitProviderError(this.unreachable);
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
  async gitUpstream(repository: Repository): Promise<GitUpstream> {
    if (!this.upstream) return { url: repository.cloneUrl, username: 'fake', password: 'fake-upstream-secret' };
    return { url: `${this.upstream.baseUrl}/${repository.owner}/${repository.name}.git`, username: this.upstream.username, password: this.upstream.password };
  }
  branchWebUrl(ref: RepositoryRef, branch: string) {
    const tree = this.kind === 'github' ? 'tree' : '-/tree';
    return `${this.web}/${ref.owner}/${ref.name}/${tree}/${branch.split('/').map(encodeURIComponent).join('/')}`;
  }
  async upsertPullRequest(ref: RepositoryRef, input: PullRequestInput) {
    const prs = this.pullRequests.get(ref.providerRepoId) ?? [];
    let pr = prs.find((p) => p.state === 'open' && p.input.head === input.head);
    if (pr) pr.input = { ...input, draft: pr.draft };
    else {
      const path = this.kind === 'github' ? 'pull' : '-/merge_requests';
      pr = { number: prs.length + 1, url: `${(await this.getRepository(ref)).webUrl}/${path}/${prs.length + 1}`, state: 'open', draft: input.draft, input };
      prs.push(pr);
    }
    this.pullRequests.set(ref.providerRepoId, prs);
    return { provider: this.kind, number: pr.number, url: pr.url, state: pr.state, draft: pr.draft };
  }
  /** Set to make merges fail, like a provider refusing a conflicting or unapproved merge. */
  mergeRefusal: string | null = null;
  async mergePullRequest(ref: RepositoryRef, number: number) {
    const pr = this.pullRequests.get(ref.providerRepoId)?.find((p) => p.number === number);
    if (!pr) throw new GitProviderError('Pull request not found', 404);
    if (this.mergeRefusal) throw new GitProviderError(this.mergeRefusal, 405);
    pr.state = 'merged';
    return { provider: this.kind, number: pr.number, url: pr.url, state: pr.state, draft: pr.draft };
  }
  async getPullRequest(ref: RepositoryRef, number: number) {
    const pr = this.pullRequests.get(ref.providerRepoId)?.find((p) => p.number === number);
    if (!pr) throw new GitProviderError('Pull request not found', 404);
    return { provider: this.kind, number: pr.number, url: pr.url, state: pr.state, draft: pr.draft };
  }
}
