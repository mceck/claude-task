// Contract at the GitLab HTTP boundary: token checks, REST shapes, merge requests, protection.
import { afterEach, describe, expect, it } from 'vitest';
import { GitLabProvider } from '../src/git/gitlab';
import { gitlabProject, startFakeGitLab } from './helpers/fake-gitlab';
import type { GitLabOverride } from './helpers/fake-gitlab';

const ref = { connectionId: 'c1', provider: 'gitlab' as const, providerRepoId: '42', owner: 'acme/platform', name: 'service' };
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});
async function harness(override?: GitLabOverride, token = 'glpat-valid') {
  const gitlab = await startFakeGitLab(override);
  stop = gitlab.close;
  return { ...gitlab, provider: new GitLabProvider('c1', gitlab.url, token) };
}
const mr = (extra: Record<string, unknown> = {}) => ({ iid: 3, web_url: 'https://gitlab.example.com/acme/platform/service/-/merge_requests/3', state: 'opened', draft: false, title: 'Fix', ...extra });

describe('GitLab provider HTTP contract', () => {
  it('validates scopes and expiry with the PRIVATE-TOKEN header', async () => {
    const { provider, requests } = await harness();
    expect(await provider.validate()).toEqual({
      access: [{ label: 'claude-task-bot', url: 'https://gitlab.example.com/claude-task-bot' }],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(requests.every((r) => r.token === 'glpat-valid')).toBe(true);
  });
  it.each([
    { name: 'an unknown token', token: 'glpat-nope', message: 'invalid, expired or revoked' },
    { name: 'missing scopes', token: 'glpat-read', message: 'needs the write_repository scope' },
  ])('refuses $name with a specific message', async ({ token, message }) => {
    const { provider, state } = await harness(undefined, token);
    state.tokens.set('glpat-read', { scopes: ['api', 'read_repository'], expires_at: null, revoked: false });
    await expect(provider.validate()).rejects.toThrow(message);
  });
  it('recognizes URLs that are not GitLab', async () => {
    const { provider } = await harness(() => ({ body: '<html>' }));
    await expect(provider.validate()).rejects.toThrow('does not answer like a GitLab instance');
  });

  it('lists projects with at least Developer access across pages, keeping nested namespaces', async () => {
    const { provider, requests } = await harness((r) => {
      if (r.path.startsWith('/projects?') && r.path.endsWith('&page=1'))
        return { body: [gitlabProject(42, 'acme/platform', 'service'), gitlabProject(9, 'acme', 'old', { archived: true })], headers: { 'x-next-page': '2' } };
      if (r.path.startsWith('/projects?') && r.path.endsWith('&page=2')) return { body: [gitlabProject(43, 'acme', 'tools', { visibility: 'public' })], headers: { 'x-next-page': '' } };
    });
    expect(await provider.listAccessibleRepositories()).toEqual([
      {
        connectionId: 'c1',
        provider: 'gitlab',
        providerRepoId: '42',
        owner: 'acme/platform',
        name: 'service',
        defaultBranch: 'main',
        private: true,
        cloneUrl: 'https://gitlab.example.com/acme/platform/service.git',
        webUrl: 'https://gitlab.example.com/acme/platform/service',
      },
      expect.objectContaining({ providerRepoId: '43', owner: 'acme', private: false }),
    ]);
    expect(requests[0]!.path).toContain('membership=true&min_access_level=30');
  });
  it('looks up repositories by id, branches and branch links', async () => {
    const { provider } = await harness((r) => {
      if (r.path === '/projects/42') return { body: gitlabProject(42, 'acme/platform', 'service') };
      if (r.path === '/projects/42/repository/branches/task%2Fapi-1-x') return { body: { name: 'task/api-1-x' } };
    });
    expect((await provider.getRepository(ref)).owner).toBe('acme/platform');
    expect(await provider.branchExists(ref, 'task/api-1-x')).toBe(true);
    expect(await provider.branchExists(ref, 'missing')).toBe(false);
    expect(provider.branchWebUrl(ref, 'task/api-1-x')).toMatch(/\/acme\/platform\/service\/-\/tree\/task\/api-1-x$/);
    // The token only ever goes to the Connection's own scheme and host, whatever GitLab reports as clone URL.
    expect(await provider.gitUpstream({ ...ref, defaultBranch: 'main', private: true, cloneUrl: 'http://elsewhere.example/a.git', webUrl: '' })).toEqual({
      url: `${provider.baseUrl}/acme/platform/service.git`,
      username: 'oauth2',
      password: 'glpat-valid',
    });
  });

  it('creates draft merge requests with the Draft prefix', async () => {
    const { provider, requests } = await harness((r) => {
      if (r.path.startsWith('/projects/42/merge_requests?')) return { body: [] };
      if (r.path === '/projects/42/merge_requests' && r.method === 'POST') return { body: mr({ draft: true, title: r.body.title }) };
    });
    const created = await provider.upsertPullRequest(ref, { head: 'task/api-1-x', base: 'main', title: 'Fix login', body: 'Details', draft: true });
    expect(created).toEqual({ provider: 'gitlab', number: 3, url: mr().web_url, state: 'open', draft: true });
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ source_branch: 'task/api-1-x', target_branch: 'main', title: 'Draft: Fix login', description: 'Details' });
    expect(requests.find((r) => r.path.startsWith('/projects/42/merge_requests?'))!.path).toContain('state=opened&source_branch=task%2Fapi-1-x&target_branch=main');
  });
  it('updates the open merge request and keeps its draft state', async () => {
    const { provider, requests } = await harness((r) => {
      if (r.path.startsWith('/projects/42/merge_requests?')) return { body: [mr({ draft: true })] };
      if (r.path === '/projects/42/merge_requests/3' && r.method === 'PUT') return { body: mr({ draft: true }) };
    });
    await provider.upsertPullRequest(ref, { head: 'task/api-1-x', base: 'main', title: 'Draft: Better title', body: 'New', draft: false });
    expect(requests.find((r) => r.method === 'PUT')!.body).toEqual({ title: 'Draft: Better title', description: 'New' });
  });
  it.each([
    { state: 'merged', expected: 'merged' },
    { state: 'closed', expected: 'closed' },
    { state: 'locked', expected: 'closed' },
    { state: 'opened', expected: 'open' },
  ])('maps merge request state $state', async ({ state, expected }) => {
    const { provider } = await harness((r) => (r.path === '/projects/42/merge_requests/3' ? { body: mr({ state }) } : undefined));
    expect((await provider.getPullRequest(ref, 3)).state).toBe(expected);
  });

  const rule = (name: string, push: Record<string, unknown>[]) => ({ name, push_access_levels: push, allow_force_push: false });
  it.each([
    { name: 'Maintainers-only push with a Developer token', rules: [rule('main', [{ access_level: 40 }])], role: 30, expected: true },
    { name: 'Maintainers push with a Maintainer token', rules: [rule('main', [{ access_level: 40 }])], role: 40, expected: false },
    { name: 'no one can push', rules: [rule('main', [{ access_level: 0 }])], role: 40, expected: true },
    { name: 'a wildcard rule', rules: [rule('ma*', [{ access_level: 0 }])], role: 40, expected: true },
    { name: 'the token user allowed explicitly', rules: [rule('main', [{ access_level: 40, user_id: 7 }])], role: 30, expected: false },
    { name: 'another user allowed', rules: [rule('main', [{ access_level: 40, user_id: 8 }])], role: 30, expected: true },
    { name: 'a group allowed', rules: [rule('main', [{ access_level: 30, group_id: 5 }])], role: 30, expected: null },
    { name: 'a second, more permissive rule', rules: [rule('main', [{ access_level: 0 }]), rule('*', [{ access_level: 30 }])], role: 30, expected: false },
    { name: 'no matching rule', rules: [rule('release/*', [{ access_level: 0 }])], role: 30, expected: false },
  ])('interprets protection with $name', async ({ rules, role, expected }) => {
    const { provider } = await harness((r) => {
      if (r.path.startsWith('/projects/42/protected_branches')) return { body: rules };
      if (r.path === '/projects/42')
        return { body: gitlabProject(42, 'acme/platform', 'service', { permissions: { project_access: { access_level: role }, group_access: null } }) };
    });
    const protection = await provider.checkBaseBranchProtection(ref, 'main');
    expect(protection.protected).toBe(expected);
    expect(protection.settingsUrl).toContain('/acme/platform/service/-/settings/repository');
  });
  it('reports unknown protection when the token may not read protected branches', async () => {
    const { provider } = await harness((r) => (r.path.startsWith('/projects/42/protected_branches') ? { status: 403, body: { message: '403 Forbidden' } } : undefined));
    expect((await provider.checkBaseBranchProtection(ref, 'main')).protected).toBeNull();
  });
  it('keeps provider messages and the token out of errors', async () => {
    const { provider } = await harness((r) => (r.path.startsWith('/projects/42/merge_requests') ? { status: 422, body: { message: `echo glpat-valid` } } : undefined));
    const error = await provider.upsertPullRequest(ref, { head: 'a', base: 'main', title: 't', body: 'b', draft: false }).catch((err) => err);
    expect(String(error)).toContain('HTTP 422');
    expect(String(error)).not.toContain('glpat-valid');
  });
});
