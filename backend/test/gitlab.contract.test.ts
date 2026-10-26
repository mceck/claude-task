// Opt-in: a dedicated GitLab project and token. Normal test runs never contact GitLab.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitLabProvider } from '../src/git/gitlab';

const { GITLAB_CONTRACT_URL: url, GITLAB_CONTRACT_TOKEN: token, GITLAB_CONTRACT_PROJECT: project } = process.env;
const enabled = !!(url && token && project);
describe.skipIf(!enabled)('Live GitLab contract (dedicated project only, read-only)', () => {
  it('validates the token, discovers the project, its default branch, protection and Git Proxy upstream', async () => {
    const provider = new GitLabProvider('contract', url!.replace(/\/+$/, ''), token!);
    const identity = await provider.validate();
    expect(identity.access[0]!.label).toBeTruthy();
    const ref = (await provider.listAccessibleRepositories()).find((r) => `${r.owner}/${r.name}` === project);
    expect(ref).toBeDefined();
    const repo = await provider.getRepository(ref!);
    expect(await provider.branchExists(ref!, repo.defaultBranch)).toBe(true);
    expect(await provider.branchExists(ref!, `missing-${randomUUID()}`)).toBe(false);
    expect((await provider.checkBaseBranchProtection(ref!, repo.defaultBranch)).settingsUrl).toContain('/-/settings/repository');
    const upstream = await provider.gitUpstream(repo);
    const refs = await fetch(`${upstream.url}/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${Buffer.from(`${upstream.username}:${upstream.password}`).toString('base64')}` },
    });
    expect(refs.status).toBe(200);
  });
});
