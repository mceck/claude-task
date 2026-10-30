import { createHash, createSign } from 'node:crypto';
import type { BranchProtection, GitAccess, Repository, RepositoryRef } from '@claude-task/shared';
import type { GitHubCredentials } from './connections';
import { GitProviderError } from './provider';
import type { GitIdentity, GitProvider, GitUpstream, PullRequestInput } from './provider';

type Repo = { id: number; name: string; owner: { login: string }; default_branch: string; private: boolean; clone_url: string; html_url: string };
type Installation = { id: number; account: { login: string; html_url: string }; suspended_at?: string | null };
type PR = { number: number; html_url: string; state: 'open' | 'closed'; merged_at: string | null; merged?: boolean; draft: boolean };
type Rule = { type: string; ruleset_id: number };
type Ruleset = { bypass_actors?: { actor_id: number; actor_type: string; bypass_mode: string }[] };
const repoPath = (ref: RepositoryRef) => `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
type RepositoryToken = { token: string; expiresAt: string };
const serializeRepo = (connectionId: string, r: Repo): Repository => ({
  connectionId,
  provider: 'github',
  providerRepoId: String(r.id),
  owner: r.owner.login,
  name: r.name,
  defaultBranch: r.default_branch,
  private: r.private,
  cloneUrl: r.clone_url,
  webUrl: r.html_url,
});
const serializePR = (p: PR) => ({ provider: 'github' as const, number: p.number, url: p.html_url, state: p.merged || p.merged_at ? ('merged' as const) : p.state, draft: p.draft });

/** GitHub App authentication, scoped token caches, REST API and protection interpretation. */
export class GitHubProvider implements GitProvider {
  readonly kind = 'github' as const;
  private fingerprint = '';
  private readonly tokens = new Map<string, RepositoryToken>();
  constructor(
    private readonly connectionId: string,
    private readonly readConfig: () => Promise<GitHubCredentials | null>,
    private readonly apiUrl = 'https://api.github.com',
  ) {}

  private async config(): Promise<GitHubCredentials> {
    const value = await this.readConfig();
    if (!value) throw new GitProviderError('This GitHub connection has no App credentials', 409);
    const fingerprint = createHash('sha256').update(value.appId).update(value.privateKey).digest('hex');
    if (fingerprint !== this.fingerprint) {
      this.tokens.clear();
      this.fingerprint = fingerprint;
    }
    return value;
  }
  private async jwt(): Promise<string> {
    const c = await this.config();
    const now = Math.floor(Date.now() / 1000);
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const content = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: c.appId })}`;
    try {
      return `${content}.${createSign('RSA-SHA256').update(content).sign(c.privateKey, 'base64url')}`;
    } catch {
      throw new GitProviderError('The configured GitHub App private key is invalid', 409);
    }
  }
  private async request<T>(path: string, auth: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${auth}`,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'user-agent': 'claude-task',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
        // GitHub redirects API paths of renamed or moved repositories to
        // `/repositories/<id>`; following them keeps the numeric identity useful.
        redirect: 'follow',
      });
      if (new URL(response.url).origin !== new URL(this.apiUrl).origin)
        throw new GitProviderError('GitHub answered from another origin', 502);
    } catch (err) {
      if (err instanceof GitProviderError) throw err;
      throw new GitProviderError('GitHub could not be reached. Try again later.');
    }
    if (!response.ok) {
      // Provider messages may echo request bodies. Never include them (or auth) in errors/logs.
      throw new GitProviderError(`GitHub request failed (HTTP ${response.status}). Check the App installation and repository permissions.`, response.status);
    }
    return (await response.json()) as T;
  }
  private async pages<T>(path: string, auth: string, field?: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const data = await this.request<T[] | Record<string, T[]>>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, auth);
      const items = field ? (data as Record<string, T[]>)[field]! : (data as T[]);
      all.push(...items);
      if (items.length < 100) return all;
    }
  }
  private async installation(ref: RepositoryRef): Promise<number> {
    return (await this.request<{ id: number }>(`${repoPath(ref)}/installation`, await this.jwt())).id;
  }
  private async token(installation: number, permissions: Record<string, string>, repositoryId?: string): Promise<RepositoryToken> {
    await this.config();
    const key = `${installation}:${repositoryId ?? '*'}:${JSON.stringify(permissions)}`;
    const cached = this.tokens.get(key);
    if (cached && Date.parse(cached.expiresAt) > Date.now() + 5 * 60000) return cached;
    const data = await this.request<{ token: string; expires_at: string }>(`/app/installations/${installation}/access_tokens`, await this.jwt(), 'POST', {
      permissions,
      ...(repositoryId ? { repository_ids: [Number(repositoryId)] } : {}),
    });
    const result = { token: data.token, expiresAt: data.expires_at };
    this.tokens.set(key, result);
    return result;
  }
  private async auth(ref: RepositoryRef, permissions: Record<string, string>) {
    return (await this.token(await this.installation(ref), permissions, ref.providerRepoId)).token;
  }
  private async installations() {
    return (await this.pages<Installation>('/app/installations', await this.jwt())).filter((i) => !i.suspended_at);
  }
  async validate(): Promise<GitIdentity> {
    const access: GitAccess[] = (await this.installations()).map((i) => ({ label: i.account.login, url: i.account.html_url }));
    return { access, expiresAt: null };
  }
  async listAccessibleRepositories(): Promise<Repository[]> {
    const repos: Repository[] = [];
    for (const i of await this.installations()) {
      const auth = (await this.token(i.id, { metadata: 'read' })).token;
      repos.push(...(await this.pages<Repo>('/installation/repositories', auth, 'repositories')).map((r) => serializeRepo(this.connectionId, r)));
    }
    return repos.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
  }
  async getRepository(ref: RepositoryRef): Promise<Repository> {
    const r = serializeRepo(this.connectionId, await this.request<Repo>(repoPath(ref), await this.auth(ref, { contents: 'read' })));
    if (r.providerRepoId !== ref.providerRepoId) throw new GitProviderError('The repository identity changed. Select it again.', 409);
    return r;
  }
  async branchExists(ref: RepositoryRef, branch: string): Promise<boolean> {
    try {
      await this.request(`${repoPath(ref)}/branches/${encodeURIComponent(branch)}`, await this.auth(ref, { contents: 'read' }));
      return true;
    } catch (err) {
      if (err instanceof GitProviderError && err.status === 404) return false;
      throw err;
    }
  }
  /** Contents: write on exactly this repository, for the Git Proxy only. */
  async gitUpstream(repository: Repository): Promise<GitUpstream> {
    const { token } = await this.token(await this.installation(repository), { contents: 'write' }, repository.providerRepoId);
    return { url: repository.cloneUrl, username: 'x-access-token', password: token };
  }
  branchWebUrl(ref: RepositoryRef, branch: string) {
    return `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  }
  async checkBaseBranchProtection(ref: RepositoryRef, branch: string): Promise<BranchProtection> {
    const result: BranchProtection = {
      protected: null,
      details: 'Protection could not be verified. Grant the App Administration: read to see it.',
      settingsUrl: `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/settings/rules`,
      checkedAt: new Date().toISOString(),
    };
    try {
      const auth = await this.auth(ref, { contents: 'read', administration: 'read' });
      const appId = Number((await this.config()).appId);
      const rules = await this.request<Rule[]>(`${repoPath(ref)}/rules/branches/${encodeURIComponent(branch)}`, auth);
      for (const id of new Set(rules.filter((r) => r.type === 'pull_request').map((r) => r.ruleset_id))) {
        const ruleset = await this.request<Ruleset>(`${repoPath(ref)}/rulesets/${id}`, auth);
        if (!Array.isArray(ruleset.bypass_actors)) throw new GitProviderError('Ruleset bypass could not be verified');
        const bypass = ruleset.bypass_actors.some((a) => a.actor_type === 'Integration' && a.actor_id === appId && a.bypass_mode !== 'pull_request');
        if (!bypass)
          return {
            ...result,
            protected: true,
            details: 'An active ruleset requires pull requests and does not allow this App to bypass them with a direct push.',
          };
      }
      try {
        const classic = await this.request<{ required_pull_request_reviews?: { bypass_pull_request_allowances?: { apps?: { id: number }[] } } }>(
          `${repoPath(ref)}/branches/${encodeURIComponent(branch)}/protection`,
          auth,
        );
        const review = classic.required_pull_request_reviews;
        if (review && !review.bypass_pull_request_allowances?.apps?.some((a) => a.id === appId))
          return { ...result, protected: true, details: 'Classic branch protection requires pull requests and this App has no bypass.' };
      } catch (err) {
        if (!(err instanceof GitProviderError && err.status === 404)) throw err;
      }
      return { ...result, protected: false, details: 'GitHub would let this App push directly to the base branch. Require pull requests without App bypass for a second line of defense.' };
    } catch {
      return result;
    }
  }
  async upsertPullRequest(ref: RepositoryRef, input: PullRequestInput) {
    const auth = await this.auth(ref, { contents: 'read', pull_requests: 'write' });
    const open = await this.request<PR[]>(
      `${repoPath(ref)}/pulls?state=open&head=${encodeURIComponent(`${ref.owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}&per_page=100`,
      auth,
    );
    if (open[0])
      return serializePR(await this.request<PR>(`${repoPath(ref)}/pulls/${open[0].number}`, auth, 'PATCH', { title: input.title, body: input.body }));
    return serializePR(await this.request<PR>(`${repoPath(ref)}/pulls`, auth, 'POST', input));
  }
  async mergePullRequest(ref: RepositoryRef, number: number) {
    const auth = await this.auth(ref, { contents: 'write', pull_requests: 'write' });
    const merged = await this.request<{ merged?: boolean; message?: string }>(`${repoPath(ref)}/pulls/${number}/merge`, auth, 'PUT', {});
    if (merged?.merged === false) throw new GitProviderError(merged.message ?? 'GitHub refused to merge the pull request', 409);
    try {
      return serializePR(await this.request<PR>(`${repoPath(ref)}/pulls/${number}`, auth));
    } catch {
      // The merge succeeded; a failed read must not turn it into a reported failure.
      return {
        provider: 'github' as const,
        number,
        url: `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/pull/${number}`,
        state: 'merged' as const,
        draft: false,
      };
    }
  }
  async getPullRequest(ref: RepositoryRef, number: number) {
    return serializePR(await this.request<PR>(`${repoPath(ref)}/pulls/${number}`, await this.auth(ref, { pull_requests: 'read' })));
  }
}
