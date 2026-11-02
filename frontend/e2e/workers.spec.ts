import { expect, test } from '@playwright/test';
import { DOCKERFILE, HEADERS as headers, createTask, login, uniqueKey } from './helpers';

test('creates a Worker in the UI, follows its containers and builds, and creates a Project on it', async ({ page }) => {
  await login(page.request);
  const name = `Flutter worker ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Workers', exact: true }).click();
  await page.getByRole('button', { name: 'New worker' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox', { name: 'PostgreSQL', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Redis', exact: true })).toBeChecked();
  await dialog.getByLabel('Worker name').fill(name);
  await dialog.getByLabel('Minimum', { exact: true }).fill('1');
  await dialog.getByLabel('Cap', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Create worker' }).click();

  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const containers = page.getByRole('list', { name: 'Worker containers' });
  await expect(containers.getByRole('listitem')).toHaveCount(2);
  await expect(containers.getByRole('listitem', { name: 'Container 1' })).toContainText('Runner connected');
  await expect(page.getByText('Idle', { exact: true }).first()).toBeVisible();
  await containers.getByRole('listitem', { name: 'Container 1' }).getByRole('button', { name: 'Logs', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Container logs')).toContainText('runner started');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Builds', exact: true }).click();
  await expect(page.getByLabel('Build output')).toContainText('Step 1/1');

  // The list shows its capacity and, once used, its Projects.
  await page.getByRole('link', { name: 'Workers', exact: true }).first().click();
  const card = page.getByRole('link').filter({ hasText: name });
  await expect(card.getByLabel('Containers')).toContainText('0 busy · 1 running / cap 2');

  await page.goto('/');
  await page.getByRole('button', { name: 'New project', exact: true }).first().click();
  const form = page.getByRole('dialog');
  const key = uniqueKey();
  await form.getByLabel('Name', { exact: true }).fill('Worker project');
  await form.getByLabel('Key', { exact: true }).fill(key);
  await form.getByRole('combobox', { name: 'Worker', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await form.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page).toHaveURL(`/p/${key}`);
  const { project } = await (await page.request.get(`/api/v1/projects/${key}`)).json();
  const { worker } = await (await page.request.get(`/api/v1/workers/${project.workerId}`)).json();
  expect(worker.name).toBe(name);

  await page.goto(`/workers/${worker.id}`);
  await page.getByRole('tab', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Worker projects' })).toContainText('Worker project');

  // A Worker in use can't be deleted: the refusal names its Projects.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete worker', exact: true }).click();
  await expect(page.getByText(/The worker runs these projects: Worker project/)).toBeVisible();
});

test('refuses a Project Worker change while a Session is started, with the reason', async ({ page }) => {
  await login(page.request);
  const workers = await Promise.all(['Old', 'New'].map(async (label) => {
    const res = await page.request.post('/api/v1/workers', { headers, data: { name: `${label} worker ${Date.now()}`, dockerfile: DOCKERFILE, minimum: 1 } });
    expect(res.status()).toBe(201);
    return (await res.json()).worker as { id: string; name: string };
  }));
  const res = await page.request.post('/api/v1/projects', { headers, data: { key: uniqueKey(), name: 'Moving project', workerId: workers[0]!.id } });
  const { project, statuses } = await res.json();
  const { credential } = await (await page.request.post('/api/v1/credentials', {
    headers, data: { name: `Move key ${Date.now()}`, kind: 'anthropic_api_key', secret: 'test-secret-1234' },
  })).json();
  const { agent } = await (await page.request.post('/api/v1/agents', { headers, data: { name: `Mover ${Date.now()}`, credentialId: credential.id } })).json();
  const task = await createTask(page.request, { id: project.id, key: project.key, workerId: workers[0]!.id, statuses }, 'Started work');
  expect((await page.request.patch(`/api/v1/tasks/${task.id}`, { headers, data: { version: 1, agentId: agent.id } })).ok()).toBe(true);
  expect((await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers, data: { body: 'Go' } })).ok()).toBe(true);

  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('combobox', { name: 'Worker', exact: true }).click();
  await page.getByRole('option', { name: workers[1]!.name, exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /current worker|still running a job/ })).toBeVisible();
  expect((await (await page.request.get(`/api/v1/projects/${project.id}/agent-settings`)).json()).settings.workerId).toBe(workers[0]!.id);
});
