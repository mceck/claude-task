import { expect, test } from '@playwright/test';
import { HEADERS, createProject, createTask, login, seedAgent, startJob } from './helpers';

test('summarises Task counts and unread Tasks in the sidebar Boards list', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Sidebar summary');
  const open = await createTask(page.request, project, 'Open task');
  await createTask(page.request, project, 'Done task', 'Done');
  const comment = await page.request.post(`/api/v1/tasks/${open.id}/comments`, { data: { body: 'Hello' }, headers: HEADERS });
  expect(comment.status()).toBe(201);

  await page.goto('/');
  const entry = page.locator(`nav a[href="/p/${project.key}"]`);
  await expect(entry).toContainText('1/2');
  await expect(entry.locator('[aria-label^="Task counts:"]')).toHaveAttribute('aria-label', 'Task counts: 1 open · 1 done');
  await expect(entry.getByTestId('sidebar-project-unread')).toHaveText('1');
});

test('updates the sidebar unread badge live, without waiting for a refresh', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Sidebar live');
  const task = await createTask(page.request, project, 'Quiet task');
  await page.goto('/');
  const entry = page.locator(`nav a[href="/p/${project.key}"]`);
  await expect(entry).toBeVisible();
  await expect(entry.getByTestId('sidebar-project-unread')).toHaveCount(0);
  const posted = await page.request.post(`/api/v1/tasks/${task.id}/comments`, { data: { body: 'News' }, headers: HEADERS });
  expect(posted.status()).toBe(201);
  await expect(entry.getByTestId('sidebar-project-unread')).toHaveText('1', { timeout: 5000 });
  const read = await page.request.put(`/api/v1/tasks/${task.id}/read-position`, { data: { itemId: (await posted.json()).comment.id }, headers: HEADERS });
  expect(read.ok()).toBe(true);
  await expect(entry.getByTestId('sidebar-project-unread')).toHaveCount(0, { timeout: 5000 });
});

test('shows the running Agent dot in the sidebar Boards list', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request);
  const project = await createProject(page.request, 'Sidebar running');
  const task = await createTask(page.request, project, 'Agent task');
  await startJob(page.request, agent.id, task.id);

  await page.goto('/');
  const entry = page.locator(`nav a[href="/p/${project.key}"]`);
  await expect(entry.getByTestId('sidebar-project-running')).toBeVisible();
});
