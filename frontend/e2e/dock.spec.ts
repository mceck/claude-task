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

test('reorders minimized chats by dragging a bar and keeps the order', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Dock order');
  const names = ['Alpha', 'Bravo', 'Charlie'];
  const tasks = [];
  for (const name of names) {
    const task = await createTask(page.request, project, name);
    expect((await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers: H, data: { body: `${name} note` } })).status()).toBe(201);
    await page.goto(`/t/${task.key}`);
    await page.getByRole('button', { name: 'Minimize chat' }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${project.key}$`));
    tasks.push(task);
  }

  const dock = page.getByRole('region', { name: 'Minimized chats' });
  const order = () => dock.getByRole('article').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
  const expected = (labels: string[]) => labels.map((label) => `Minimized chat: ${label}`);
  await expect.poll(order).toEqual(expected(names));
  // The last Task page's composer is gone: the row has dropped back before a bar is measured for the drag.
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--chat-composer-height'))).toBe('');

  // Dragging a bar with the mouse moves the conversation: Alpha goes from the left end to the corner, where Charlie was.
  const from = (await dock.getByRole('button', { name: 'Drag Alpha' }).boundingBox())!;
  const to = (await dock.getByRole('article', { name: 'Minimized chat: Charlie' }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, from.y + from.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(order).toEqual(expected(['Bravo', 'Charlie', 'Alpha']));

  // The keyboard moves a panel too: Space picks a bar up, the arrow keys move it, Space drops it. Each step waits for
  // the drag's live region to say it happened, so a slow machine cannot swallow a key.
  const announced = page.locator('[id^="DndLiveRegion"]').filter({ hasText: /draggable item/i });
  await dock.getByRole('button', { name: 'Drag Bravo' }).focus();
  await page.keyboard.press('Space');
  await expect(announced).toContainText(/moved over droppable area/i);
  const lifted = await announced.textContent();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => announced.textContent()).not.toBe(lifted);
  await page.keyboard.press('Space');
  await expect(announced).toContainText(/was dropped over droppable area/i);
  await expect.poll(order).toEqual(expected(['Charlie', 'Bravo', 'Alpha']));

  // The order is a per-browser preference like the rest of the Dock, and a click still opens or collapses a panel.
  await page.reload();
  await expect.poll(order).toEqual(expected(['Charlie', 'Bravo', 'Alpha']));
  await dock.getByRole('button', { name: 'Collapse Bravo' }).click();
  await expect(dock.getByRole('button', { name: 'Open Bravo' })).toHaveAttribute('aria-expanded', 'false');

  // Minimizing a conversation that is already in the Dock still makes it the newest, nearest the corner.
  await page.goto(`/t/${tasks[1]!.key}`);
  await page.getByRole('button', { name: 'Minimize chat' }).click();
  await expect.poll(order).toEqual(expected(['Charlie', 'Alpha', 'Bravo']));
});

test('pulses the avatar of a collapsed panel with unread activity', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Dock unread');
  const task = await createTask(page.request, project, 'Needs me');
  // Minimized from the Board, not from a Task page: the Board keeps its Project subscription, so the comment's event
  // reaches a live page instead of racing the connection a fresh navigation opens.
  await page.goto(`/p/${project.key}`);
  await page.getByRole('article', { name: task.key }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Task conversation')).toBeVisible();
  await dialog.getByRole('button', { name: 'Minimize chat' }).click();
  await expect(dialog).toBeHidden();

  const panel = page.getByRole('region', { name: 'Minimized chats' }).getByRole('article', { name: 'Minimized chat: Needs me' });
  const halo = panel.locator('.dock-unread-halo');
  await expect(panel).toBeVisible();
  await expect(halo).toHaveCount(0);

  // Collapsed, the bar is all there is: a comment that arrives while the panel is shut has to show on the bar itself.
  await panel.getByRole('button', { name: 'Collapse Needs me' }).click();
  // Wait for the conversation to be gone: an open panel would read the Comment as it arrives and the test would race it.
  await expect(panel.getByLabel('Task conversation')).toHaveCount(0);
  expect((await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers: H, data: { body: 'Look here' } })).status()).toBe(201);
  // The preference travels over the live connection, which a loaded machine can take a while to deliver.
  await expect(panel.getByRole('img', { name: 'Unread' })).toBeVisible({ timeout: 15_000 });
  await expect(halo).toHaveCount(1);

  // Opening the panel reads it, and the halo goes with the dot.
  await panel.getByRole('button', { name: 'Open Needs me' }).click();
  await expect(halo).toHaveCount(0, { timeout: 15_000 });
  await expect(panel.getByRole('img', { name: 'Unread' })).toHaveCount(0, { timeout: 15_000 });
});

test('a collapsed panel leaves the room above it clickable', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Dock clicks');
  const tasks = [await createTask(page.request, project, 'Older chat'), await createTask(page.request, project, 'Newer chat')];
  for (const task of tasks) {
    await page.goto(`/t/${task.key}`);
    await page.getByRole('button', { name: 'Minimize chat' }).click();
  }

  const dock = page.getByRole('region', { name: 'Minimized chats' });
  const older = dock.getByRole('article', { name: 'Minimized chat: Older chat' });
  const newer = dock.getByRole('article', { name: 'Minimized chat: Newer chat' });
  const open = (await newer.boundingBox())!;
  await older.getByRole('button', { name: 'Collapse Older chat' }).click();
  await expect(older.getByRole('button', { name: 'Open Older chat' })).toHaveAttribute('aria-expanded', 'false');
  // A collapsed bar still names its Project and Task Key.
  await expect(older).toContainText('Dock clicks');
  await expect(older).toContainText(tasks[0]!.key);
  const collapsed = (await older.boundingBox())!;

  // The row spans every panel, but only the panels themselves take clicks: above a collapsed one the page shows through.
  const over = await page.evaluate(
    ({ x, y }) => (document.elementFromPoint(x, y)?.closest('[aria-label="Minimized chats"]') ? 'dock' : 'page'),
    { x: collapsed.x + collapsed.width / 2, y: open.y + 20 },
  );
  expect(over).toBe('page');
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
