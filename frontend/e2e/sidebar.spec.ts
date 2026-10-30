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
