// Contract at the GitHub HTTP boundary: real JWT/scoping/cache and actual REST shapes.
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubProvider } from '../src/git/github';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const ref = { connectionId: 'c1', provider: 'github' as const, providerRepoId: '42', owner: 'acme', name: 'example' };
const repo = {
  id: 42,
  owner: { login: 'acme' },
  name: 'example',
  default_branch: 'main',
  private: true,
  clone_url: 'https://github.com/acme/example.git',
  html_url: 'https://github.com/acme/example',
};
type Request = { path: string; method: string; body: any; auth: string };
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await stop?.();
  stop = undefined;
});

async function harness(overrides: (req: Request) => { status?: number; body: unknown } | undefined = () => undefined) {
  const requests: Request[] = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const request = { path: req.url!, method: req.method!, body: text ? JSON.parse(text) : null, auth: req.headers.authorization ?? '' };
    requests.push(request);
    let result = overrides(request);
    if (!result) {
      if (request.path.startsWith('/app/installations?')) result = { body: [{ id: 7, account: { login: 'acme', html_url: 'https://github.com/acme' } }] };
      else if (request.path === '/repos/acme/example/installation') result = { body: { id: 7 } };
      else if (request.path === '/app/installations/7/access_tokens')
        result = { body: { token: `token-${++n}`, expires_at: new Date(Date.now() + 3600000).toISOString() } };
      else if (request.path.startsWith('/installation/repositories?')) result = { body: { repositories: [repo] } };
      else if (request.path === '/repos/acme/example') result = { body: repo };
      else if (request.path.startsWith('/repos/acme/example/branches/') && !request.path.endsWith('/protection')) result = { body: { name: 'main' } };
      else result = { status: 404, body: { message: 'not found' } };
    }
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stop = () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  const port = (server.address() as { port: number }).port;
  const provider = new GitHubProvider('c1', async () => ({ appId: '123', privateKey }), `http://127.0.0.1:${port}`);
  return { provider, requests };
}

describe('GitHub App provider HTTP contract', () => {
  it('validates through the installations list', async () => {
    const { provider } = await harness();
    expect(await provider.validate()).toEqual({ access: [{ label: 'acme', url: 'https://github.com/acme' }], expiresAt: null });
  });
  it('signs App JWTs and lists installations/repositories without requesting write permissions', async () => {
    const { provider, requests } = await harness();
    expect(await provider.listAccessibleRepositories()).toEqual([
      {
        connectionId: 'c1',
        provider: 'github',
        providerRepoId: '42',
        owner: 'acme',
        name: 'example',
        defaultBranch: 'main',
        private: true,
        cloneUrl: repo.clone_url,
        webUrl: repo.html_url,
      },
    ]);
    const jwt = requests[0]!.auth.replace('Bearer ', '');
    const [head, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ iss: '123' });
    expect(verify('RSA-SHA256', Buffer.from(`${head}.${payload}`), keys.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(requests.find((r) => r.path.endsWith('/access_tokens'))!.body).toEqual({ permissions: { metadata: 'read' } });
  });
  it('gives the Git Proxy tokens limited to one repository and contents:write, cached and refreshed before expiry', async () => {
    const { provider, requests } = await harness();
    const repository = { ...ref, defaultBranch: 'main', private: true, cloneUrl: repo.clone_url, webUrl: repo.html_url };
    const first = await provider.gitUpstream(repository);
    expect(first).toMatchObject({ url: repo.clone_url, username: 'x-access-token' });
    expect((await provider.gitUpstream(repository)).password).toBe(first.password);
    const issued = () => requests.filter((r) => r.path.endsWith('/access_tokens'));
    expect(issued()).toHaveLength(1);
    expect(issued()[0]!.body).toEqual({ permissions: { contents: 'write' }, repository_ids: [42] });
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 56 * 60000);
    expect((await provider.gitUpstream(repository)).password).not.toBe(first.password);
    expect(issued()).toHaveLength(2);
    time.mockRestore();
  });
  it.each([
    { mode: 'always', protected: false },
    { mode: 'exempt', protected: false },
    { mode: 'pull_request', protected: true },
  ])('handles App bypass $mode', async ({ mode, protected: expected }) => {
    const { provider } = await harness((r) => {
      if (r.path.includes('/rules/branches/')) return { body: [{ type: 'pull_request', ruleset_id: 9 }] };
      if (r.path.endsWith('/rulesets/9')) return { body: { bypass_actors: [{ actor_type: 'Integration', actor_id: 123, bypass_mode: mode }] } };
    });
    expect((await provider.checkBaseBranchProtection(ref, 'main')).protected).toBe(expected);
  });

  it('does not claim protection when a ruleset bypass list is unavailable', async () => {
    const { provider } = await harness((r) => {
      if (r.path.includes('/rules/branches/')) return { body: [{ type: 'pull_request', ruleset_id: 9 }] };
      if (r.path.endsWith('/rulesets/9')) return { body: {} };
    });
    expect((await provider.checkBaseBranchProtection(ref, 'main')).protected).toBeNull();
  });
  it('accepts classic PR-required protection without App bypass', async () => {
    const { provider } = await harness((r) => {
      if (r.path.includes('/rules/branches/')) return { body: [] };
      if (r.path.endsWith('/protection')) return { body: { required_pull_request_reviews: { bypass_pull_request_allowances: { apps: [{ id: 999 }] } } } };
    });
    expect((await provider.checkBaseBranchProtection(ref, 'main')).protected).toBe(true);
  });
  it('reports unknown protection when GitHub refuses Administration read', async () => {
    const { provider } = await harness((r) => (r.path.endsWith('/access_tokens') ? { status: 403, body: { message: 'forbidden' } } : undefined));
    expect((await provider.checkBaseBranchProtection(ref, 'main')).protected).toBeNull();
  });
  it('uses separate PR-scoped tokens, updates open PRs, and interprets merged responses', async () => {
    const { provider, requests } = await harness((r) => {
      if (r.path.includes('/pulls?'))
        return { body: [{ number: 5, html_url: 'https://github.com/acme/example/pull/5', state: 'open', draft: true, merged_at: null }] };
      if (r.path.endsWith('/pulls/5'))
        return { body: { number: 5, html_url: 'https://github.com/acme/example/pull/5', state: 'closed', draft: false, merged_at: '2026-10-25T00:00:00Z' } };
    });
    const pr = await provider.upsertPullRequest(ref, { head: 'task/api-1-hello', base: 'main', title: 'Fix', body: 'Details', draft: false });
    expect(pr).toMatchObject({ provider: 'github', state: 'merged' });
    expect(requests.find((r) => r.method === 'PATCH')!.body).toEqual({ title: 'Fix', body: 'Details' });
    expect(requests.find((r) => r.path.endsWith('/access_tokens'))!.body).toEqual({
      repository_ids: [42],
      permissions: { contents: 'read', pull_requests: 'write' },
    });
    expect((await provider.getPullRequest(ref, 5)).state).toBe('merged');
  });
  it('creates PRs when no open head exists and surfaces sanitized API errors', async () => {
    const { provider } = await harness((r) => {
      if (r.path.includes('/pulls?')) return { body: [] };
      if (r.path.endsWith('/pulls')) return { status: 422, body: { message: `body with ${privateKey}` } };
    });
    await expect(provider.upsertPullRequest(ref, { head: 'task/one', base: 'main', title: 'Fix', body: 'Body', draft: false })).rejects.toThrow('HTTP 422');
    try {
      await provider.upsertPullRequest(ref, { head: 'task/one', base: 'main', title: 'Fix', body: 'Body', draft: false });
    } catch (err) {
      expect(String(err)).not.toContain('PRIVATE KEY');
    }
  });
});
