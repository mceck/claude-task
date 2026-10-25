// Opt-in: a dedicated test App/repository. Normal test runs never contact GitHub.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubProvider } from '../src/git/github';
const enabled = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_CONTRACT_REPOSITORY);
const provider = new GitHubProvider(async () => ({ appId: process.env.GITHUB_APP_ID!, privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n') }));
describe.skipIf(!enabled)('Live GitHub App contract (dedicated repository only)', () => {
  it('discovers the repository, checks its default branch and protection, and scopes container credentials', async () => {
    const repos = await provider.listAccessibleRepositories();
    const ref = repos.find((r) => `${r.owner}/${r.name}` === process.env.GITHUB_CONTRACT_REPOSITORY);
    expect(ref).toBeDefined();
    const repo = await provider.getRepository(ref!);
    expect(await provider.branchExists(ref!, repo.defaultBranch)).toBe(true);
    expect(await provider.branchExists(ref!, `missing-${randomUUID()}`)).toBe(false);
    expect((await provider.checkBaseBranchProtection(ref!, repo.defaultBranch)).settingsUrl).toContain('/settings/');
    const token = await provider.issueRepositoryToken(ref!);
    const response = await fetch('https://api.github.com/installation/repositories', {
      headers: { authorization: `Bearer ${token.token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { repositories: { id: number }[] };
    expect(body.repositories.map((r) => String(r.id))).toEqual([ref!.providerRepoId]);
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now() + 5 * 60000);
  });
});
