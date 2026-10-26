import { generateKeyPairSync } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createProject, createTask, login } from './helpers';
const headers = { 'x-claude-task': '1' };
const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

/** A GitHub connection through the API; the e2e backend backs every one with the same fake App. */
async function githubConnection(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/git/connections', {
    headers,
    data: { provider: 'github', name: `GitHub ${Date.now()}`, appId: '42', privateKey: pem() },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).connection.id;
}

test('links a repository, validates its base branch, shows protection for information and locks changes with open sessions', async ({ page }, testInfo) => {
  await login(page.request);
  const connectionId = await githubConnection(page.request);
  const project = await createProject(page.request);
  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Repository', exact: true }).click();
  await page.getByLabel('Search repositories').fill('example');
  await page.getByRole('combobox', { name: 'Repository', exact: true }).selectOption(`${connectionId}:1`);
  await expect(page.getByLabel('Base branch', { exact: true })).toHaveValue('main');
  await page.getByLabel('Base branch', { exact: true }).fill('missing');
  await page.getByRole('button', { name: 'Save repository' }).click();
  await expect(page.getByRole('alert')).toContainText('does not exist');
  await page.getByLabel('Base branch', { exact: true }).fill('main');
  await page.getByRole('button', { name: 'Save repository' }).click();
  await expect(page.getByRole('heading', { name: 'Base branch protection', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Provider protection' })).toHaveText('Protected · main');
  await expect(page.getByText('Pushes to the base branch are always blocked by claude-task.')).toBeVisible();
  await page.request.post('/api/v1/__test/git/protection', { headers, data: { protected: false } });
  await page.getByRole('button', { name: 'Re-check protection' }).click();
  await expect(page.getByRole('status', { name: 'Provider protection' })).toHaveText('Not protected · main');
  await expect(page.getByRole('link', { name: 'GitHub branch settings' })).toHaveAttribute('href', 'https://github.com/acme/example/settings/rules');
  // Informational only: no warning on the Board.
  await page.goto(`/p/${project.key}`);
  await expect(page.getByRole('heading', { name: 'E2E project' })).toBeVisible();
  await expect(page.getByLabel('Base branch protection warning')).toHaveCount(0);

  const credential = (
    await (
      await page.request.post('/api/v1/credentials', {
        headers,
        data: { name: `Git key ${Date.now()}`, kind: 'anthropic_api_key', secret: 'test-placeholder-secret' },
      })
    ).json()
  ).credential;
  const agent = (
    await (
      await page.request.post('/api/v1/agents', {
        headers,
        data: { name: `Git agent ${Date.now()}`, credentialId: credential.id, dockerfile: 'FROM claude-task/agent-base\nUSER agent\n' },
      })
    ).json()
  ).agent;
  const task = await createTask(page.request, project, 'Fix café login');
  const current = (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task;
  await page.request.patch(`/api/v1/tasks/${task.id}`, { headers, data: { version: current.version, agentId: agent.id } });
  await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers, data: { body: 'Please get started.' } });
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task.branchName)
    .toBe(`task/${task.key.toLowerCase()}-fix-cafe-login`);
  await page.goto(`/t/${task.key}`);
  // The task branch is a real link, even before a PR has been opened.
  await expect(page.getByRole('link', { name: `task/${task.key.toLowerCase()}-fix-cafe-login` })).toHaveAttribute(
    'href',
    `https://github.com/acme/example/tree/task/${task.key.toLowerCase()}-fix-cafe-login`,
  );
  await page.request.post('/api/v1/__test/git/pull-request', { headers, data: { taskId: task.id } });
  await expect(page.getByRole('link', { name: 'Pull request #1: draft' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('git-task.png'), fullPage: true });
  await page.goto(`/p/${project.key}`);
  await expect(page.getByRole('article', { name: task.key }).getByRole('link', { name: 'Pull request #1: draft' })).toBeVisible();
  await page.request.post('/api/v1/__test/git/merge', { headers, data: { taskId: task.id } });
  await expect(page.getByRole('article', { name: task.key }).getByRole('link', { name: 'Pull request #1: merged' })).toBeVisible();
  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Repository', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Repository', exact: true })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'non-closed sessions' })).toBeVisible();
});

test('adds write-only GitHub and GitLab connections and links a GitLab repository from the grouped picker', async ({ page }) => {
  await login(page.request);
  await page.goto('/admin/github');
  await expect(page).toHaveURL(/\/admin\/git$/);
  const github = `Acme GitHub ${Date.now()}`;
  const gitlab = `Acme GitLab ${Date.now()}`;

  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByLabel('Connection name').fill(github);
  await page.getByLabel('GitHub App ID').fill('1234');
  await page.getByLabel('GitHub App private key').fill(pem());
  await page.getByRole('button', { name: 'Save connection' }).click();
  const githubCard = page.getByRole('region', { name: github });
  await expect(githubCard).toContainText('App 1234');
  await expect(githubCard.getByRole('link', { name: 'acme', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByLabel('Provider').selectOption('gitlab');
  await page.getByLabel('Connection name').fill(gitlab);
  await expect(page.getByLabel('GitLab URL')).toHaveValue('https://gitlab.com');
  await page.getByLabel('GitLab URL').fill('https://gitlab.example.com');
  await page.getByLabel('GitLab token').fill('glpat-e2e-secret-value-9876');
  await page.getByRole('button', { name: 'Save connection' }).click();
  const gitlabCard = page.getByRole('region', { name: gitlab });
  await expect(gitlabCard).toContainText('gitlab.example.com');
  await expect(gitlabCard).toContainText('…9876');
  await expect(gitlabCard).toContainText('expires');
  await expect(gitlabCard.getByRole('link', { name: 'claude-task-bot' })).toBeVisible();
  // Write-only: the secret is never shown back, not even when editing.
  await expect(page.getByText('glpat-e2e-secret-value-9876')).toHaveCount(0);
  await gitlabCard.getByRole('button', { name: 'Edit / rotate' }).click();
  await expect(page.getByLabel('GitLab token')).toHaveValue('');
  await expect(page.getByLabel('GitLab URL')).toBeDisabled();
  await page.getByLabel('Connection name').fill(`${gitlab} renamed`);
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('region', { name: `${gitlab} renamed` })).toContainText('…9876');
  const connections = (await (await page.request.get('/api/v1/git/connections')).json()).connections as { id: string; name: string }[];
  expect(JSON.stringify(connections)).not.toContain('glpat-e2e-secret-value-9876');
  expect(JSON.stringify(connections)).not.toContain('PRIVATE KEY');
  const gitlabId = connections.find((c) => c.name === `${gitlab} renamed`)!.id;

  const project = await createProject(page.request, 'GitLab project');
  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Repository', exact: true }).click();
  const picker = page.getByRole('combobox', { name: 'Repository', exact: true });
  await expect(picker.locator(`optgroup[label="GitLab · ${gitlab} renamed · gitlab.example.com"] option`)).toHaveText(['acme/platform/service (private)', 'acme/tools (private)']);
  await expect(picker.locator(`optgroup[label="GitHub · ${github} · github.com"] option`)).toHaveText(['acme/example (private)', 'acme/other (private)']);
  await page.getByLabel('Search repositories').fill('platform');
  await picker.selectOption(`${gitlabId}:101`);
  await expect(page.getByLabel('Base branch', { exact: true })).toHaveValue('main');
  await page.getByRole('button', { name: 'Save repository' }).click();
  await expect(page.getByRole('link', { name: 'GitLab acme/platform/service' })).toHaveAttribute('href', 'https://gitlab.example.com/acme/platform/service');
  await expect(page.getByRole('status', { name: 'Provider protection' })).toHaveText('Protected · main');

  // A linked connection can't be deleted.
  await page.goto('/admin/git');
  await expect(page.getByRole('region', { name: `${gitlab} renamed` }).getByRole('button', { name: 'Delete' })).toBeDisabled();
  await expect(page.getByRole('region', { name: `${gitlab} renamed` })).toContainText('1 linked project');
});
