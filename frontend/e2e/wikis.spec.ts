import { expect, test } from '@playwright/test';
import { login } from './helpers';

const headers = { 'x-claude-task': '1' };

test('creates a wiki, chats from two browsers and resets the chat for everyone', async ({ page, browser }) => {
  await login(page.request);
  const name = `Knowledge ${Date.now()}`;
  const credentialResult = await page.request.post('/api/v1/credentials', {
    headers,
    data: { name, kind: 'anthropic_api_key', secret: 'test-secret-1234' },
  });
  const { credential } = await credentialResult.json();
  const agentResult = await page.request.post('/api/v1/agents', {
    headers,
    data: { name, credentialId: credential.id, dockerfile: 'FROM claude-task/agent-base\nUSER agent\n' },
  });
  const { agent } = await agentResult.json();
  const connectionResult = await page.request.post('/api/v1/git/connections', {
    headers,
    data: { provider: 'gitlab', name, baseUrl: 'https://gitlab.example.com', token: 'glpat-e2e-token-1234' },
  });
  expect(connectionResult.status()).toBe(201);
  const { connection } = await connectionResult.json();
  await page.goto('/wikis');
  await page.getByRole('button', { name: 'New wiki' }).click();
  await page.getByLabel('Wiki name').fill(name);
  await page.getByLabel('Wiki description').fill('Documentation shared by the team');
  await page.getByLabel('Agent', { exact: true }).selectOption(agent.id);
  await page.getByRole('combobox', { name: 'Repository', exact: true }).click();
  await page.locator(`[cmdk-item][data-value="${connection.id}:101"]`).click();
  await page.getByRole('button', { name: 'Create wiki' }).click();
  await expect(page).toHaveURL(/\/wikis\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const other = await browser.newContext();
  try {
    await login(other.request);
    const peer = await other.newPage();
    await peer.goto(page.url());
    const comment = page.getByRole('textbox', { name: 'Comment', exact: true });
    await comment.fill('What do we know about onboarding?');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(peer.getByText('What do we know about onboarding?', { exact: true })).toBeVisible();
    await peer.getByRole('textbox', { name: 'Comment', exact: true }).fill('Please include the deployment guide.');
    await peer.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(page.getByText('Please include the deployment guide.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reset chat', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Reset chat', exact: true }).click();
    await expect(page.getByText('What do we know about onboarding?', { exact: true })).toHaveCount(0);
    await expect(peer.getByText('What do we know about onboarding?', { exact: true })).toHaveCount(0);
    await expect(peer.getByText('Please include the deployment guide.', { exact: true })).toHaveCount(0);
    await peer.reload();
    await expect(peer.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(peer.getByText('What do we know about onboarding?', { exact: true })).toHaveCount(0);
  } finally {
    await other.close();
  }
});
