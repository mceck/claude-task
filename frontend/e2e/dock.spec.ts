import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { HEADERS, createProject, createTask, login } from './helpers';

const H = HEADERS;

/** A Wiki with one Chat that has a Comment (and so is listed and titled by it). */
async function seedWiki(request: APIRequestContext, name: string) {
  const { credential } = await (
    await request.post('/api/v1/credentials', { headers: H, data: { name, kind: 'anthropic_api_key', secret: 'test-secret-1234' } })
  ).json();
  // Disabled: a Comment must not start a Job that later blocks deleting the Wiki.
  const { agent } = await (
    await request.post('/api/v1/agents', {
      headers: H,
      data: { name, credentialId: credential.id, enabled: false, dockerfile: 'FROM claude-task/agent-base\nUSER agent\n' },
    })
  ).json();
  const { connection } = await (
    await request.post('/api/v1/git/connections', {
      headers: H,
      data: { provider: 'gitlab', name, baseUrl: 'https://gitlab.example.com', token: 'glpat-e2e-token-1234' },
    })
  ).json();
  const wikiResponse = await request.post('/api/v1/wikis', {
    headers: H,
    data: { name, description: 'Shared documentation', agentId: agent.id, repository: { connectionId: connection.id, providerRepoId: '101' } },
  });
  expect(wikiResponse.status()).toBe(201);
  const { wiki } = await wikiResponse.json();
  const { chat } = await (await request.post(`/api/v1/wikis/${wiki.id}/chats`, { headers: H, data: {} })).json();
  expect((await request.post(`/api/v1/tasks/${chat.id}/comments`, { headers: H, data: { body: 'Wiki note to keep' } })).status()).toBe(201);
  return { wiki, chat, connection };
}

test('minimizes a Task conversation into the dock, restores it and keeps it across reloads', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Dock project');
  const task = await createTask(page.request, project, 'Minimize me');
  expect((await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers: H, data: { body: 'First note' } })).status()).toBe(201);

  await page.goto(`/p/${project.key}`);
  await page.getByRole('article', { name: task.key }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Task conversation')).toBeVisible();

  // Minimizing leaves the Task where it was: the Board dialog closes and the chat waits in the Dock.
  await page.getByRole('button', { name: 'Minimize chat' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/task=/);
  const dock = page.getByRole('region', { name: 'Minimized chats' });
  const panel = dock.getByRole('article', { name: 'Minimized chat: Minimize me' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('First note')).toBeVisible();
  await expect(page.getByRole('article', { name: task.key })).toBeVisible();

  // A per-browser preference: a reload brings it back, conversation included.
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(panel.getByText('First note')).toBeVisible();

  // Collapsed, only the title bar is there and the conversation is not mounted.
  await panel.getByRole('button', { name: 'Collapse Minimize me' }).click();
  const collapsedHeader = panel.getByRole('button', { name: 'Open Minimize me' });
  await expect(collapsedHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByLabel('Task conversation')).toHaveCount(0);
  await collapsedHeader.click();
  await expect(panel.getByLabel('Task conversation')).toBeVisible();

  // Opening the full page moves the conversation there: it can't be in both places.
  await panel.getByRole('button', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${task.key}$`));
  await expect(dock).toHaveCount(0);
  await expect(page.getByLabel('Task conversation')).toBeVisible();

  // Minimizing from the Task page goes back to its Board, with the chat in the Dock.
  await page.getByRole('button', { name: 'Minimize chat' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${project.key}$`));
  await expect(page.getByRole('region', { name: 'Minimized chats' }).getByText('First note')).toBeVisible();

  // Closing the panel forgets the conversation.
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.getByRole('region', { name: 'Minimized chats' })).toHaveCount(0);
});

test('minimizes a Wiki Chat and drops its panel when the Chat is deleted', async ({ page }) => {
  await login(page.request);
  const { wiki, chat, connection } = await seedWiki(page.request, `Dock wiki ${Date.now()}`);

  await page.goto(`/wikis/${wiki.id}/chats/${chat.id}`);
  await expect(page.getByLabel('Task conversation')).toBeVisible();

  // Minimizing a Chat leaves the Wiki: its page is the conversation.
  await page.getByRole('button', { name: 'Minimize chat' }).click();
  await expect(page).toHaveURL(/\/wikis$/);
  const dock = page.getByRole('region', { name: 'Minimized chats' });
  const panel = dock.getByRole('article', { name: 'Minimized chat: Wiki note to keep' });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Task conversation').getByText('Wiki note to keep')).toBeVisible();

  // Opening it goes to the Chat and takes it out of the Dock.
  await dock.getByRole('button', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(new RegExp(`/wikis/${wiki.id}/chats/${chat.id}$`));
  await expect(page.getByRole('region', { name: 'Minimized chats' })).toHaveCount(0);

  // Minimized again, a Delete Chat elsewhere removes the panel without a word.
  await page.getByRole('button', { name: 'Minimize chat' }).click();
  await expect(dock.getByLabel('Task conversation').getByText('Wiki note to keep')).toBeVisible();
  expect((await page.request.delete(`/api/v1/wikis/${wiki.id}/chats/${chat.id}`, { headers: H })).status()).toBe(204);
  await expect(page.getByRole('region', { name: 'Minimized chats' })).toHaveCount(0);

  // Leave the installation as it was: a later test searches Repositories across every Git Connection.
  expect((await page.request.delete(`/api/v1/wikis/${wiki.id}`, { headers: H })).status()).toBe(204);
  expect((await page.request.delete(`/api/v1/git/connections/${connection.id}`, { headers: H })).status()).toBe(204);
});

test('offers no minimizing where the Dock cannot fit', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Narrow dock');
  const task = await createTask(page.request, project, 'Too narrow');
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto(`/p/${project.key}`);
  await page.getByRole('article', { name: task.key }).click();
  await expect(page.getByRole('dialog').getByLabel('Task conversation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Minimize chat' })).toHaveCount(0);
});
