import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createProject, createTask, login } from './helpers';
const headers = { 'x-claude-task': '1' };

test('links a repository, validates its base branch, warns about protection and locks changes with open sessions', async ({ page }, testInfo) => {
  await login(page.request);
  const project = await createProject(page.request);
  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Repository', exact: true }).click();
  await page.getByLabel('Search repositories').fill('example');
  await page.getByRole('combobox', { name: 'GitHub repository' }).selectOption('1');
  await expect(page.getByLabel('Base branch', { exact: true })).toHaveValue('main');
  await page.getByLabel('Base branch', { exact: true }).fill('missing');
  await page.getByRole('button', { name: 'Save repository' }).click();
  await expect(page.getByRole('alert')).toContainText('does not exist');
  await page.getByLabel('Base branch', { exact: true }).fill('main');
  await page.getByRole('button', { name: 'Save repository' }).click();
  await expect(page.getByRole('heading', { name: 'Base branch protection', exact: true })).toBeVisible();
  await expect(page.getByText('Protected · main')).toBeVisible();
  await page.request.post('/api/v1/__test/git/protection', { headers, data: { protected: false } });
  await page.getByRole('button', { name: 'Re-check protection' }).click();
  await expect(page.getByLabel('Base branch protection warning')).toContainText('Base branch is unprotected');
  await page.goto(`/p/${project.key}`);
  await expect(page.getByLabel('Base branch protection warning')).toHaveAttribute('href', 'https://github.com/acme/example/settings/rules');

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
  await expect(page.getByRole('combobox', { name: 'GitHub repository' })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'non-closed sessions' })).toBeVisible();
});

test('configures a write-only GitHub App and lists its installations and repositories', async ({ page }) => {
  await login(page.request);
  await page.goto('/admin/github');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  await page.getByLabel('GitHub App ID').fill('1234');
  await page.getByLabel('GitHub App private key').fill(key);
  await page.getByRole('button', { name: 'Save GitHub App' }).click();
  await expect(page.getByText('A key is saved.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('GitHub App private key')).toHaveValue('');
  await expect(page.getByRole('link', { name: 'acme/example', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'acme', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('GitHub App ID')).toHaveValue('1234');
  await expect(page.getByLabel('GitHub App private key')).toHaveValue('');
});
