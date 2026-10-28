import { expect, test } from '@playwright/test';
import { login } from './helpers';

const headers = { 'x-claude-task': '1' };

test('creates a wiki, chats from two browsers and manages chats: new, switch, rename, delete', async ({ page, browser }) => {
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
    const conversation = (p: typeof page) => p.getByLabel('Task conversation');
    const chatList = (p: typeof page) => p.getByRole('navigation', { name: 'Chats' });
    const chatRow = (p: typeof page, title: string) => chatList(p).getByRole('listitem').filter({ hasText: title }).locator('> button').first();
    const send = async (p: typeof page, text: string) => {
      await p.getByRole('textbox', { name: 'Comment', exact: true }).fill(text);
      await p.getByRole('button', { name: 'Comment', exact: true }).click();
    };
    await send(page, 'What do we know about onboarding?');
    await expect(conversation(peer).getByText('What do we know about onboarding?', { exact: true })).toBeVisible();
    await expect(chatRow(peer, 'What do we know about onboarding?')).toBeVisible();
    await send(peer, 'Please include the deployment guide.');
    await expect(conversation(page).getByText('Please include the deployment guide.', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page).toHaveURL(/\/wikis\/[0-9a-f-]+\/chats\/[0-9a-f-]+$/);
    await expect(conversation(page).getByText('What do we know about onboarding?', { exact: true })).toHaveCount(0);
    await send(page, 'How do we release?');
    await expect(chatRow(page, 'How do we release?')).toBeVisible();
    await expect(chatRow(peer, 'How do we release?')).toBeVisible();

    await chatRow(page, 'What do we know about onboarding?').click();
    await expect(conversation(page).getByText('Please include the deployment guide.', { exact: true })).toBeVisible();
    await expect(conversation(page).getByText('How do we release?', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /Chat actions: What do we know/ }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByLabel('Chat title').fill('Onboarding notes');
    await page.getByRole('button', { name: 'Rename chat', exact: true }).click();
    await expect(chatRow(page, 'Onboarding notes')).toBeVisible();
    await expect(chatRow(peer, 'Onboarding notes')).toBeVisible();

    await page.getByRole('button', { name: /Chat actions: Onboarding notes/ }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Delete this chat and everything in it for everyone. Wiki files are kept.');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete chat', exact: true }).click();
    await expect(chatRow(page, 'Onboarding notes')).toHaveCount(0);
    await expect(chatRow(peer, 'Onboarding notes')).toHaveCount(0);
    await expect(conversation(page).getByText('How do we release?', { exact: true })).toBeVisible();
    await peer.reload();
    await expect(peer.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(conversation(peer).getByText('Please include the deployment guide.', { exact: true })).toHaveCount(0);
  } finally {
    await other.close();
  }
});
