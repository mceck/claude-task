import { expect, test } from '@playwright/test';
import { HEADERS, createProject, createTask, login } from './helpers';

const H = HEADERS;

test('keeps the loaded Timeline when its refetch fails', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Timeline errors');
  const task = await createTask(page.request, project, 'Long conversation');
  for (const body of ['first note', 'second note']) {
    expect((await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers: H, data: { body } })).status()).toBe(201);
  }

  await page.goto(`/p/${project.key}`);
  await page.getByRole('article', { name: task.key }).click();
  const conversation = page.getByLabel('Task conversation');
  await expect(conversation.getByText('second note', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Reopening the Task refetches the cached Timeline; that refetch fails.
  await page.route('**/api/v1/tasks/*/timeline**', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Timeline unavailable' } } }),
  );
  await page.getByRole('article', { name: task.key }).click();

  // The failure is reported inline; the conversation already read stays on screen (after the retries).
  await expect(conversation.getByText('Timeline unavailable')).toBeVisible({ timeout: 15_000 });
  await expect(conversation.getByText('second note', { exact: true })).toBeVisible();
});

test('picks up a Status renamed while the Task page is open', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Live statuses');
  const task = await createTask(page.request, project, 'Status watcher');
  const todo = project.statuses.find((s) => s.name === 'Todo')!;

  await page.goto(`/t/${task.key}`);
  await expect(page.getByLabel('Status')).toContainText('Todo');

  const renamed = await page.request.patch(`/api/v1/statuses/${todo.id}`, { headers: H, data: { name: 'Doing' } });
  expect(renamed.status()).toBe(200);
  await expect(page.getByLabel('Status')).toContainText('Doing');
});

test('a rapid double Enter in Quick add creates one Task', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Quick add');
  let posts = 0;
  await page.route('**/api/v1/projects/*/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    await new Promise((r) => setTimeout(r, 300));
    return route.continue();
  });

  await page.goto(`/p/${project.key}`);
  await page.getByRole('button', { name: 'Add task' }).first().click();
  const input = page.getByLabel('New task title');
  await input.fill('Only once');
  await input.press('Enter');
  await input.press('Enter');

  await expect(page.getByRole('article').filter({ hasText: 'Only once' })).toHaveCount(1);
  await expect.poll(() => posts).toBe(1);
});

test('shows a Board error instead of an empty Board', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Board errors');
  await page.route('**/api/v1/projects/*/tasks**', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'Server exploded' } } }),
  );

  await page.goto(`/p/${project.key}`);
  await expect(page.getByText('Server exploded')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add task' })).toHaveCount(0);
});

test('reports a Copy link failure instead of failing silently', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Copy link');
  const task = await createTask(page.request, project, 'Copy errors');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('Clipboard blocked')) },
    });
  });

  await page.goto(`/t/${task.key}`);
  await page.getByRole('button', { name: 'Task actions' }).click();
  await page.getByRole('menuitem', { name: 'Copy link' }).click();
  await expect(page.getByText('Couldn’t copy the link')).toBeVisible();
});

test('shows a Projects error instead of an empty list', async ({ page }) => {
  await login(page.request);
  await page.route('**/api/v1/projects*', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'Projects unavailable' } } }),
  );
  await page.goto('/');
  await expect(page.getByText('Projects unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});
