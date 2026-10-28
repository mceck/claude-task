import type { BranchProtection, PullRequest, Repository, RepositoryRef } from '@claude-task/shared';
import { GitProviderError } from './provider';
import type { GitIdentity, GitProvider, GitUpstream, PullRequestInput } from './provider';

type Project = {
  id: number;
  path: string;
  namespace: { full_path: string };
  default_branch: string | null;
  visibility: 'private' | 'internal' | 'public';
  http_url_to_repo: string;
  web_url: string;
  archived?: boolean;
  permissions?: { project_access: { access_level: number } | null; group_access: { access_level: number } | null };
};
type MR = { iid: number; web_url: string; state: 'opened' | 'closed' | 'merged' | 'locked'; draft?: boolean; work_in_progress?: boolean; title: string };
type AccessEntry = { access_level: number; user_id?: number | null; group_id?: number | null; deploy_key_id?: number | null };
type ProtectedBranch = { name: string; push_access_levels: AccessEntry[]; allow_force_push: boolean };
type TokenSelf = { active: boolean; revoked: boolean; scopes: string[]; expires_at: string | null };
type User = { id: number; username: string; web_url: string; is_admin?: boolean };

const REQUEST_TIMEOUT_MS = 30_000;
const RETRIES = 2;
const RETRY_DELAY_MS = 500;
const PAGE_CONCURRENCY = 4;
export const GITLAB_SCOPES = ['api', 'write_repository'];
const DRAFT = /^\s*(\[draft\]|\(draft\)|draft:|draft\s)\s*/i;
const projectPath = (ref: RepositoryRef) => `/projects/${encodeURIComponent(ref.providerRepoId)}`;
/** GitLab token expiry is a date; it stops working at its start (UTC). */
const expiry = (date: string | null) => (date ? new Date(`${date}T00:00:00Z`).toISOString() : null);
const serializeMR = (m: MR): Omit<PullRequest, 'checkedAt'> => ({
  provider: 'gitlab',
  number: m.iid,
  url: m.web_url,
  state: m.state === 'opened' ? 'open' : m.state === 'merged' ? 'merged' : 'closed',
  draft: !!(m.draft ?? m.work_in_progress),
});
const matches = (pattern: string, branch: string) =>
  new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(branch);

/** GitLab REST API v4 with a personal (or group/project) access token. */
export class GitLabProvider implements GitProvider {
  readonly kind = 'gitlab' as const;
  private user: Promise<User> | null = null;
  constructor(
    private readonly connectionId: string,
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async send<T>(path: string, method = 'GET', body?: unknown): Promise<{ data: T; headers: Headers }> {
    // Only reads are retried: a transient failure on a write may have been applied.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendOnce<T>(path, method, body);
      } catch (err) {
        const transient = err instanceof GitProviderError && (err.status === 429 || err.status >= 500);
        if (method !== 'GET' || !transient || attempt >= RETRIES) throw err;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }
  private async sendOnce<T>(path: string, method: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.baseUrl}/api/v4${path}`, {
        method,
        headers: { 'PRIVATE-TOKEN': this.token, accept: 'application/json', 'user-agent': 'claude-task', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
      // The timeout also covers the body, so a slow download must not look like a non-GitLab answer.
      text = await response.text();
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new GitProviderError('GitLab took too long to answer. Try again in a moment.');
      throw new GitProviderError('GitLab could not be reached. Check the URL and try again later.');
    }
    // Provider messages may echo request bodies. Never include them (or the token) in errors/logs.
    if (!response.ok) throw new GitProviderError(`GitLab request failed (HTTP ${response.status}). Check the token and its project access.`, response.status);
    try {
      return { data: JSON.parse(text) as T, headers: response.headers };
    } catch {
      throw new GitProviderError('This URL does not answer like a GitLab instance', 400);
    }
  }
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return (await this.send<T>(path, method, body)).data;
  }
  /** Every page of a list. When GitLab reports the page count, the pages after the first are fetched concurrently. */
  private async pages<T>(path: string): Promise<T[]> {
    const url = (page: number | string) => `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
    const first = await this.send<T[]>(url(1));
    const totalPages = Number(first.headers.get('x-total-pages'));
    if (!Number.isInteger(totalPages) || totalPages < 1) {
      // No total (very large result sets): follow the next-page header one page at a time.
      const all = [...first.data];
      for (let page = first.headers.get('x-next-page') ?? ''; page; ) {
        const next = await this.send<T[]>(url(page));
        all.push(...next.data);
        page = next.headers.get('x-next-page') ?? '';
      }
      return all;
    }
    const rest = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const results: T[][] = [];
    const worker = async () => {
      for (let page = rest.shift(); page !== undefined; page = rest.shift()) results[page] = (await this.send<T[]>(url(page))).data;
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, rest.length) }, worker));
    return [...first.data, ...results.flat()];
  }
  private me(): Promise<User> {
    this.user ??= this.request<User>('/user').catch((err) => {
      this.user = null;
      throw err;
    });
    return this.user;
  }
  private serializeRepo(p: Project): Repository {
    return {
      connectionId: this.connectionId,
      provider: 'gitlab',
      providerRepoId: String(p.id),
      owner: p.namespace.full_path,
      name: p.path,
      defaultBranch: p.default_branch ?? 'main',
      private: p.visibility !== 'public',
      cloneUrl: p.http_url_to_repo,
      webUrl: p.web_url,
    };
  }
  private webUrl(ref: RepositoryRef) {
    return `${this.baseUrl}/${ref.owner.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(ref.name)}`;
  }

  async validate(): Promise<GitIdentity> {
    let self: TokenSelf;
    try {
      self = await this.request<TokenSelf>('/personal_access_tokens/self');
    } catch (err) {
      if (err instanceof GitProviderError && err.status === 401) throw new GitProviderError('The GitLab token is invalid, expired or revoked', 400);
      if (err instanceof GitProviderError && err.status === 404) throw new GitProviderError('This URL does not answer like a GitLab instance', 400);
      throw err;
    }
    if (typeof self !== 'object' || self === null || !Array.isArray(self.scopes)) throw new GitProviderError('This URL does not answer like a GitLab instance', 400);
    if (!self.active || self.revoked) throw new GitProviderError('The GitLab token is expired or revoked', 400);
    const missing = GITLAB_SCOPES.filter((s) => !self.scopes.includes(s));
    if (missing.length) throw new GitProviderError(`The GitLab token needs the ${missing.join(' and ')} scope${missing.length > 1 ? 's' : ''}`, 400);
    const user = await this.me();
    return { access: [{ label: user.username, url: user.web_url }], expiresAt: expiry(self.expires_at) };
  }
  /** Revokes the current token and returns its successor (GitLab revokes the whole family if a revoked token is rotated). */
  async rotateToken(expiresAt?: string): Promise<{ token: string; expiresAt: string | null }> {
    const result = await this.request<{ token: string; expires_at: string | null }>(
      '/personal_access_tokens/self/rotate',
      'POST',
      expiresAt ? { expires_at: expiresAt } : undefined,
    );
    return { token: result.token, expiresAt: expiry(result.expires_at) };
  }
  async listAccessibleRepositories(): Promise<Repository[]> {
    const projects = await this.pages<Project>('/projects?membership=true&min_access_level=30&archived=false&order_by=id&sort=asc');
    return projects
      .filter((p) => !p.archived)
      .map((p) => this.serializeRepo(p))
      .sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
  }
  async getRepository(ref: RepositoryRef): Promise<Repository> {
    const r = this.serializeRepo(await this.request<Project>(projectPath(ref)));
    if (r.providerRepoId !== ref.providerRepoId) throw new GitProviderError('The repository identity changed. Select it again.', 409);
    return r;
  }
  async branchExists(ref: RepositoryRef, branch: string): Promise<boolean> {
    try {
      await this.request(`${projectPath(ref)}/repository/branches/${encodeURIComponent(branch)}`);
      return true;
    } catch (err) {
      if (err instanceof GitProviderError && err.status === 404) return false;
      throw err;
    }
  }
  branchWebUrl(ref: RepositoryRef, branch: string) {
    return `${this.webUrl(ref)}/-/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
  }
  async gitUpstream(repository: Repository): Promise<GitUpstream> {
    // Built from the Connection's URL rather than GitLab's reported clone URL, which can point to
    // plain http (a misconfigured external_url) or another host: the token must not go there.
    return { url: `${this.webUrl(repository)}.git`, username: 'oauth2', password: this.token };
  }
  async checkBaseBranchProtection(ref: RepositoryRef, branch: string): Promise<BranchProtection> {
    const result: BranchProtection = {
      protected: null,
      details: 'Protection could not be verified with this token.',
      settingsUrl: `${this.webUrl(ref)}/-/settings/repository#js-protected-branches-settings`,
      checkedAt: new Date().toISOString(),
    };
    try {
      const [rules, project, user] = await Promise.all([
        this.pages<ProtectedBranch>(`${projectPath(ref)}/protected_branches`),
        this.request<Project>(projectPath(ref)),
        this.me(),
      ]);
      const matching = rules.filter((r) => matches(r.name, branch));
      const role = Math.max(project.permissions?.project_access?.access_level ?? 0, project.permissions?.group_access?.access_level ?? 0);
      // When several rules match, the most permissive one applies: every rule must block us.
      let unknown = false;
      const allows = (e: AccessEntry) => {
        if (e.user_id) return e.user_id === user.id;
        if (e.group_id) return (unknown = true), false;
        if (e.deploy_key_id) return false;
        if (e.access_level === 0) return false;
        if (e.access_level === 60) return !!user.is_admin;
        return role >= e.access_level;
      };
      const open = matching.length === 0 || matching.some((r) => r.push_access_levels.some(allows));
      if (open) return { ...result, protected: false, details: 'GitLab would let this connection push directly to the base branch. Restrict "Allowed to push" for a second line of defense.' };
      if (unknown) return { ...result, details: 'Group-based push rules apply to the base branch and could not be evaluated.' };
      return { ...result, protected: true, details: 'A protected branch rule keeps this connection from pushing directly to the base branch.' };
    } catch {
      return result;
    }
  }
  async upsertPullRequest(ref: RepositoryRef, input: PullRequestInput) {
    const title = input.title.replace(DRAFT, '');
    const open = await this.request<MR[]>(
      `${projectPath(ref)}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.head)}&target_branch=${encodeURIComponent(input.base)}&per_page=100`,
    );
    const existing = open[0];
    if (existing) {
      const draft = !!(existing.draft ?? existing.work_in_progress);
      return serializeMR(
        await this.request<MR>(`${projectPath(ref)}/merge_requests/${existing.iid}`, 'PUT', { title: draft ? `Draft: ${title}` : title, description: input.body }),
      );
    }
    return serializeMR(
      await this.request<MR>(`${projectPath(ref)}/merge_requests`, 'POST', {
        source_branch: input.head,
        target_branch: input.base,
        title: input.draft ? `Draft: ${title}` : title,
        description: input.body,
      }),
    );
  }
  async mergePullRequest(ref: RepositoryRef, number: number) {
    return serializeMR(await this.request<MR>(`${projectPath(ref)}/merge_requests/${number}/merge`, 'PUT', {}));
  }
  async getPullRequest(ref: RepositoryRef, number: number) {
    return serializeMR(await this.request<MR>(`${projectPath(ref)}/merge_requests/${number}`));
  }
}
