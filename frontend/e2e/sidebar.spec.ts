import { expect, test } from '@playwright/test';
import { Stream } from '../../backend/test/helpers/stream';
import { HEADERS, createProject, createTask, login, replay, seedAgent, startJob } from './helpers';

test('summarises Task counts and unread Turn Summaries in the sidebar Boards list', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Sidebar summary');
  const task = await createTask(page.request, project, 'Open task');
  await createTask(page.request, project, 'Done task', 'Done');
  const agent = await seedAgent(page.request);
  const start = await startJob(page.request, agent.id, task.id);
  const stream = new Stream(start.sessionId);
  await replay(page.request, agent.id, start.jobId, [stream.init(), stream.result()], true);
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/projects')).json()).projects.find((p: { id: string }) => p.id === project.id).activity.unreadTasks)
    .toBe(1);

  await page.goto('/');
  await expect(page.getByTestId('project-unread')).toHaveText('1');
  const entry = page.locator(`nav a[href="/p/${project.key}"]`);
  await expect(entry).toContainText('1/2');
  await expect(entry.locator('[aria-label^="Task counts:"]')).toHaveAttribute('aria-label', 'Task counts: 1 open · 1 done');
  await expect(entry.getByTestId('sidebar-project-unread')).toHaveText('1');
});

test('updates the sidebar unread badge live when a Turn finishes, without waiting for a refresh', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Sidebar live');
  const task = await createTask(page.request, project, 'Quiet task');
  const agent = await seedAgent(page.request);
  await page.goto('/');
  const entry = page.locator(`nav a[href="/p/${project.key}"]`);
  await expect(entry).toBeVisible();
  await expect(entry.getByTestId('sidebar-project-unread')).toHaveCount(0);

  const start = await startJob(page.request, agent.id, task.id);
  const stream = new Stream(start.sessionId);
  await replay(page.request, agent.id, start.jobId, [stream.init(), stream.result()], true);
  await expect(entry.getByTestId('sidebar-project-unread')).toHaveText('1', { timeout: 10000 });

  const timeline = (await (await page.request.get(`/api/v1/tasks/${task.id}/timeline`)).json()).items;
  const summary = timeline.find((i: { type: string; item?: { payload?: { kind?: string } } }) => i.type === 'agent' && i.item?.payload?.kind === 'turn_summary');
  expect((await page.request.put(`/api/v1/tasks/${task.id}/read-position`, { data: { itemId: summary.id }, headers: HEADERS })).ok()).toBe(true);
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
