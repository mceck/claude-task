import { expect, test } from '@playwright/test';
import { createProject, login } from './helpers';

test('autosaves project agent settings on pause, tab changes and clearing a field', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const path = `/api/v1/projects/${project.id}/agent-settings`;
  const settings = async () => (await (await page.request.get(path)).json()).settings;
  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save agent settings' })).toHaveCount(0);
  await page.getByLabel('Worktree setup script').fill('npm ci');
  await expect.poll(async () => (await settings()).setupScript).toBe('npm ci');
  await page.getByLabel('Agent instructions').fill('Keep changes focused');
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await expect.poll(async () => (await settings()).agentInstructions).toBe('Keep changes focused');
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(page.getByLabel('Agent instructions')).toHaveValue('Keep changes focused');
  await page.getByLabel('Agent instructions').fill('');
  await page.getByLabel('Worktree setup script').focus();
  await expect.poll(async () => (await settings()).agentInstructions).toBe('');
  await expect(page.getByRole('status', { name: 'Project agent settings save status' })).toHaveText('All changes saved');
});

test('keeps failed edits and lets the user retry autosaving', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const path = `/api/v1/projects/${project.id}/agent-settings`;
  let fail = true;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === 'PATCH' && fail) {
      fail = false;
      await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Temporarily unavailable' } } });
    } else await route.continue();
  });
  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByLabel('Agent instructions').fill('Preserve this draft');
  const status = page.getByRole('status', { name: 'Project agent settings save status' });
  await expect(status).toContainText('Couldn’t save: Temporarily unavailable');
  await expect(page.getByLabel('Agent instructions')).toHaveValue('Preserve this draft');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(status).toHaveText('All changes saved');
  expect((await (await page.request.get(path)).json()).settings.agentInstructions).toBe('Preserve this draft');
});

test('serializes autosaves and preserves edits made while a request is in flight', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const path = `/api/v1/projects/${project.id}/agent-settings`;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const patches: Record<string, string>[] = [];
  let firstWritten = false;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patches.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (patches.length === 1) {
      firstWritten = true;
      await held;
    }
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/p/${project.key}/settings`);
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await page.getByLabel('Worktree setup script').fill('first draft');
    await expect.poll(() => firstWritten).toBe(true);
    await page.getByLabel('Worktree setup script').fill('latest draft');
    await page.getByLabel('Agent instructions').fill('Latest instructions');
    expect(patches).toEqual([{ setupScript: 'first draft' }]);
    release();
    await expect(page.getByRole('status', { name: 'Project agent settings save status' })).toHaveText('All changes saved');
    const saved = (await (await page.request.get(path)).json()).settings;
    expect(saved).toMatchObject({ setupScript: 'latest draft', agentInstructions: 'Latest instructions' });
    await expect(page.getByLabel('Worktree setup script')).toHaveValue('latest draft');
    expect(patches).toHaveLength(2);
  } finally { release(); }
});

test('autosaves agent configuration and images while Docker settings need their own save', async ({ page }) => {
  await login(page.request);
  const headers = { 'x-claude-task': '1' };
  const { credential } = await (await page.request.post('/api/v1/credentials', {
    headers, data: { name: `Autosave credential ${Date.now()}`, kind: 'anthropic_api_key', secret: 'test-secret-1234' },
  })).json();
  const { agent } = await (await page.request.post('/api/v1/agents', {
    headers, data: { name: `Autosave agent ${Date.now()}`, credentialId: credential.id, dockerfile: 'FROM claude-task/agent-base\nUSER agent\n' },
  })).json();
  const path = `/api/v1/agents/${agent.id}`;
  const read = async () => (await (await page.request.get(path)).json()).agent;
  const patches: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(path)) patches.push(request.postDataJSON());
  });
  await page.goto(`/agents/${agent.id}`);
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save agent', exact: true })).toHaveCount(0);
  await page.getByLabel('Dockerfile', { exact: true }).fill('FROM unfinished');
  await page.getByRole('checkbox', { name: 'PostgreSQL', exact: true }).uncheck();
  await page.getByLabel('CPU limit', { exact: true }).fill('2');
  await page.getByLabel('Memory (MB)', { exact: true }).fill('512');
  await page.getByLabel('Model', { exact: true }).fill('claude-sonnet-5-5');
  await page.getByLabel('Effort', { exact: true }).selectOption('high');
  await expect(page.getByRole('status', { name: 'Agent configuration save status' })).toHaveText('All changes saved');
  const saved = await read();
  expect(saved).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', dockerfile: agent.dockerfile, cpuLimit: null, memoryMb: null, services: agent.services });
  expect(patches.length).toBeGreaterThan(0);
  for (const body of patches) {
    expect(Object.keys(body).every((key) => ['model', 'effort'].includes(key))).toBe(true);
  }

  await page.getByRole('button', { name: 'Save Docker configuration', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await read()).dockerfile).toBe(agent.dockerfile);
  await page.getByLabel('Dockerfile', { exact: true }).fill('FROM claude-task/agent-base\n# Updated environment\nUSER agent\n');
  await page.getByRole('button', { name: 'Save Docker configuration', exact: true }).click();
  await expect(page.getByText('Docker configuration saved', { exact: true })).toBeVisible();
  expect(await read()).toMatchObject({ cpuLimit: 2, memoryMb: 512, services: ['redis'] });
  expect(Object.keys(patches.at(-1)!).sort()).toEqual(['cpuLimit', 'dockerfile', 'memoryMb', 'services']);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await page.getByLabel('Avatar image', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
  await expect.poll(async () => (await read()).avatarImageUrl).not.toBeNull();
  await page.getByRole('button', { name: 'Remove image', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Agent image save status' })).toHaveText('All changes saved');
  await expect.poll(async () => (await read()).avatarImageUrl).toBeNull();
});
