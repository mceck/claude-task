import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login, uniqueKey } from './helpers';

const headers = { 'x-claude-task': '1' };

async function setup(page: Page) {
  await login(page.request);
  const name = `Project setup ${Date.now()}`;
  const credentialResponse = await page.request.post('/api/v1/credentials', {
    headers, data: { name, kind: 'anthropic_api_key', secret: 'test-secret-1234' },
  });
  const { credential } = await credentialResponse.json();
  const agentResponse = await page.request.post('/api/v1/agents', {
    headers, data: { name, credentialId: credential.id, dockerfile: 'FROM claude-task/agent-base\nUSER agent\n' },
  });
  expect(agentResponse.status()).toBe(201);
  const { agent } = await agentResponse.json();
  const connectionResponse = await page.request.post('/api/v1/git/connections', {
    headers, data: { provider: 'gitlab', name, baseUrl: 'https://gitlab.example.com', token: 'glpat-e2e-token-1234' },
  });
  expect(connectionResponse.status()).toBe(201);
  const { connection } = await connectionResponse.json();
  await page.goto('/');
  await page.getByRole('button', { name: 'New project', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  const key = uniqueKey();
  await dialog.getByLabel('Key', { exact: true }).fill(key);
  await dialog.getByLabel('Default Agent', { exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await dialog.getByLabel('Repository', { exact: true }).click();
  await page.getByPlaceholder('Search by owner, group or name').fill('platform/service');
  await page.locator('[cmdk-group]').filter({ hasText: name })
    .getByRole('option', { name: /acme\/platform\/service/ }).click();
  await expect(dialog.getByLabel('Base branch')).toHaveValue('main');
  return { name, key, agent, connection, dialog };
}

test('creates a Project with Git and default Agent, preserving input after a branch error', async ({ page }) => {
  const { name, key, agent, connection, dialog } = await setup(page);
  await dialog.getByLabel('Base branch').fill('missing-branch');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(dialog.getByText('The base branch "missing-branch" does not exist in this repository', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(name);
  await expect(dialog.getByLabel('Default Agent', { exact: true })).toContainText(name);
  await expect(dialog.getByLabel('Repository', { exact: true })).toContainText('acme/platform/service');
  expect((await page.request.get(`/api/v1/projects/${key}`)).status()).toBe(404);
  await dialog.getByLabel('Base branch').fill('main');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page).toHaveURL(`/p/${key}`);
  const { project } = await (await page.request.get(`/api/v1/projects/${key}`)).json();
  expect(project.repository).toMatchObject({ connectionId: connection.id, providerRepoId: '101', baseBranch: 'main' });
  const { settings } = await (await page.request.get(`/api/v1/projects/${key}/agent-settings`)).json();
  expect(settings.defaultAgentId).toBe(agent.id);
  const response = await page.request.post(`/api/v1/projects/${key}/tasks`, { headers, data: { title: 'First Task' } });
  expect(response.status()).toBe(201);
  const { task } = await response.json();
  expect(task.agentId).toBe(agent.id);
  const { session } = await (await page.request.get(`/api/v1/tasks/${task.id}/session`)).json();
  expect(session.state).toBe('pending');
});

test('clears optional Repository and Agent choices before creation', async ({ page }) => {
  const { key, dialog } = await setup(page);
  await dialog.getByLabel('Default Agent', { exact: true }).click();
  await page.getByRole('option', { name: 'No Agent', exact: true }).click();
  await dialog.getByLabel('Repository', { exact: true }).click();
  await page.getByRole('option', { name: 'No Repository', exact: true }).click();
  await expect(dialog.getByLabel('Base branch')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page).toHaveURL(`/p/${key}`);
  const { project } = await (await page.request.get(`/api/v1/projects/${key}`)).json();
  expect(project.repository).toBeNull();
  const { settings } = await (await page.request.get(`/api/v1/projects/${key}/agent-settings`)).json();
  expect(settings.defaultAgentId).toBeNull();
});
