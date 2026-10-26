import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { Stream } from '../../backend/test/helpers/stream';
import { createProject, createTask, login } from './helpers';

const headers = { 'x-claude-task': '1' };

async function seedAgent(request: APIRequestContext, name = 'Test agent') {
  name = `${name} ${Date.now()}`;
  const res = await request.post('/api/v1/credentials', {
    headers,
    data: { name: `Key ${Date.now()}`, kind: 'anthropic_api_key', secret: 'test-secret-1234' },
  });
  expect(res.status()).toBe(201);
  const { credential } = await res.json();
  const result = await request.post('/api/v1/agents', {
    headers,
    data: { name, credentialId: credential.id, dockerfile: 'FROM claude-task/agent-base\nUSER agent\n' },
  });
  expect(result.status()).toBe(201);
  const { agent } = await result.json();
  await expect.poll(async () => (await (await request.get(`/api/v1/agents/${agent.id}`)).json()).agent.state).toBe('idle');
  return agent as { id: string; name: string };
}

async function messages(request: APIRequestContext, agentId: string): Promise<Record<string, unknown>[]> {
  return (await (await request.get(`/api/v1/__test/runners/${agentId}`)).json()).received;
}

async function jobStart(request: APIRequestContext, agentId: string, taskId: string) {
  let start: Record<string, unknown> | undefined;
  await expect
    .poll(async () => {
      const { jobs } = await (await request.get(`/api/v1/agents/${agentId}/jobs`)).json();
      const job = jobs.find((j: { task: { id: string } }) => j.task.id === taskId);
      start = (await messages(request, agentId)).find((m) => m.type === 'job.start' && m.jobId === job?.id);
      return !!start;
    })
    .toBe(true);
  return start! as { jobId: string; sessionId: string };
}

async function replay(request: APIRequestContext, agentId: string, jobId: string, events: Record<string, unknown>[], exit = false) {
  expect((await request.post(`/api/v1/__test/runners/${agentId}`, { headers, data: { jobId, events, exit } })).ok()).toBe(true);
}

async function assign(page: Page, agentName: string) {
  await page.getByRole('combobox', { name: 'Assign agent' }).click();
  await page.getByRole('option', { name: agentName, exact: true }).click();
}

/** Assignment alone doesn't start the Agent: the first User Comment does. */
async function assignAndStart(page: Page, agentName: string) {
  await assign(page, agentName);
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Please get started.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
}

test('completes assigned skills in the chat with keyboard, click, and Escape', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Slash commands');
  const agent = await seedAgent(page.request, 'Skill agent');
  await page.route(`**/api/v1/tasks/${task.id}/session`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.session) body.session.commands = [{ name: 'review', description: 'Review changes', kind: 'skill' }, { name: 'release', description: 'Prepare release', kind: 'skill' }, { name: 'compact', description: 'Summarize conversation history', kind: 'claude' }];
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/t/${task.key}`);
  const assigned = page.waitForResponse((r) => r.url().endsWith(`/tasks/${task.id}`) && r.request().method() === 'PATCH' && r.status() === 200);
  await assign(page, agent.name);
  await assigned;
  await page.reload();
  const composer = page.getByRole('textbox', { name: 'Comment', exact: true });
  const box = composer.locator('xpath=ancestor::div[@data-internal]');
  await expect(composer).toBeVisible();
  const height = (await box.boundingBox())!.height;
  await composer.fill('/');
  await expect(page.getByRole('listbox', { name: 'Chat commands' })).toBeVisible();
  // The suggestions overlay the conversation above the composer, which keeps its shape.
  expect((await box.boundingBox())!.height).toBe(height);
  expect((await page.getByRole('listbox', { name: 'Chat commands' }).boundingBox())!.y).toBeLessThan((await box.boundingBox())!.y);
  await composer.press('ArrowDown');
  await composer.press('Enter');
  await expect(composer).toHaveText('/release ');
  await composer.fill('Please /rev');
  await page.getByRole('option', { name: /^\/review/ }).click();
  await expect(composer).toHaveText('Please /review ');
  await composer.fill('/re');
  await composer.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Chat commands' })).toBeHidden();
  await expect(composer).toHaveText('/re');
  await composer.fill('src/re');
  await expect(page.getByRole('listbox', { name: 'Chat commands' })).toBeHidden();
  await composer.fill('/comp');
  await expect(page.getByRole('option', { name: /^\/compact/ })).toBeVisible();
  await composer.press('Tab');
  await expect(composer).toHaveText('/compact ');
  await composer.fill('/review authentication');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Timeline' }).getByText('/review authentication', { exact: true })).toBeVisible();
});

test('manages MCP servers without exposing saved secrets', async ({ page }) => {
  await login(page.request);
  await page.goto('/admin/extensions');
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: 'Add MCP server', exact: true }).click();
  const name = `search-${Date.now()}`;
  await page.getByLabel('MCP server name').fill(name);
  await page.getByLabel('MCP URL').fill('https://mcp.example.com');
  await page.getByRole('button', { name: 'Add headers', exact: true }).click();
  await page.getByLabel('Headers name 1').fill('Authorization');
  await page.getByLabel('Headers value 1').fill('Bearer test-secret-1234');
  await page.getByRole('checkbox', { name: 'Secret', exact: true }).check();
  await page.getByRole('button', { name: 'Save MCP server', exact: true }).click();
  const server = page.locator('article').filter({ has: page.getByRole('heading', { name: `${name} http`, exact: true }) });
  await expect(server).toBeVisible();
  await expect(page.locator('body')).not.toContainText('test-secret-1234');
  await server.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Headers value 1')).toHaveValue('');
  await page.getByLabel('MCP description').fill('Updated configuration');
  await page.getByRole('button', { name: 'Save MCP server', exact: true }).click();
  await expect(server).toContainText('Updated configuration');
  await server.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(server).toBeHidden();
});

test('adds a marketplace plugin to the catalog and assigns it to an agent', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Plugin agent');
  const name = `design-${Date.now()}`;
  await page.goto('/admin/extensions');
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
  await page.getByLabel('Plugin name').fill(name);
  await page.getByRole('button', { name: 'Add plugin', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('plugin@marketplace');
  await page.getByLabel('Marketplace source').fill('anthropics/claude-plugins-official');
  await page.getByLabel('Plugin description').fill('Design workflows');
  await page.getByRole('button', { name: 'Add plugin', exact: true }).click();
  const plugin = page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(plugin).toContainText('anthropics/claude-plugins-official');

  await page.goto(`/agents/${agent.id}`);
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.getByRole('checkbox', { name: new RegExp(`^${name}`) }).check();
  await page.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect(page.getByText('Agent saved', { exact: true })).toBeVisible();
  const saved = (await (await page.request.get(`/api/v1/agents/${agent.id}`)).json()).agent;
  expect(saved.pluginIds).toHaveLength(1);

  await page.goto('/admin/extensions');
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
  await plugin.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unassign this plugin');
  await expect(plugin).toBeVisible();
});

test('creates and rotates write-only credentials, configures an agent and reads build/container logs', async ({ page }) => {
  await login(page.request);
  await page.goto('/admin/credentials');
  await page.getByRole('button', { name: 'New credential' }).click();
  await page.getByLabel('Credential name').fill('Release credential');
  await page.getByLabel('Secret', { exact: true }).fill('test-original-secret-9876');
  await page.getByRole('button', { name: 'Save credential' }).click();
  const credential = page.locator('section').filter({ hasText: 'Release credential' });
  await expect(credential).toContainText('…9876');
  await expect(page.locator('body')).not.toContainText('test-original-secret-9876');
  await credential.getByRole('button', { name: 'Edit / rotate' }).click();
  await expect(page.getByLabel('New secret')).toHaveValue('');
  await page.getByLabel('New secret').fill('test-rotated-secret-4321');
  await page.getByRole('button', { name: 'Save credential' }).click();
  await expect(credential).toContainText('…4321');

  await page.getByRole('link', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'New agent' }).click();
  await expect(page.getByRole('checkbox', { name: 'PostgreSQL', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Redis', exact: true })).toBeChecked();
  for (const name of ['MySQL', 'Mailpit', 'RustFS']) {
    await expect(page.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  }
  await page.getByLabel('Agent name').fill('Release agent');
  await page.getByLabel('Credential', { exact: true }).selectOption({ label: 'Release credential · …4321' });
  await page.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.getByRole('heading', { name: 'Release agent' })).toBeVisible();
  await expect(page.getByText('Runner: connected')).toBeVisible();
  await page.getByRole('tab', { name: 'Builds', exact: true }).click();
  await expect(page.getByLabel('Build output')).toContainText('Step 1/1');
  await page.getByRole('tab', { name: 'Container logs' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Container logs' })).toContainText('runner started');
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.getByRole('checkbox', { name: 'PostgreSQL', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Redis', exact: true }).uncheck();
  for (const name of ['MySQL', 'Mailpit', 'RustFS']) {
    await page.getByRole('checkbox', { name, exact: true }).check();
  }
  await page.getByLabel('Model', { exact: true }).fill('claude-sonnet-5-5');
  await page.getByLabel('Effort').selectOption('high');
  await page.getByRole('button', { name: 'Save agent', exact: true }).click();
  await expect(page.getByText('Agent saved', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('claude-sonnet-5-5');
  await expect(page.getByRole('checkbox', { name: 'PostgreSQL', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Redis', exact: true })).not.toBeChecked();
  for (const name of ['MySQL', 'Mailpit', 'RustFS']) {
    await expect(page.getByRole('checkbox', { name, exact: true })).toBeChecked();
  }
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Release agent (copy)' })).toBeVisible();
  await page.getByRole('tab', { name: 'Configuration' }).click();
  for (const name of ['MySQL', 'Mailpit', 'RustFS']) {
    await expect(page.getByRole('checkbox', { name, exact: true })).toBeChecked();
  }
  await page.goto('/admin/credentials');
  await expect(credential.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await expect(credential).toContainText('Release agent (copy)');
});

test('streams a turn, expands thinking and activities, delivers comments, stops and notifies the agent', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Fix the redirect');
  const agent = await seedAgent(page.request, 'Runtime agent');
  await page.goto(`/t/${task.key}`);
  await assignAndStart(page, agent.name);
  await expect(page.getByLabel('Session: running')).toBeVisible();
  const job = await jobStart(page.request, agent.id, task.id);
  const s = new Stream(job.sessionId);
  await replay(page.request, agent.id, job.jobId, [s.delta('Checking the redirect now.')]);
  await expect(page.getByLabel('Agent is writing')).toContainText('Checking the redirect now.');
  await replay(page.request, agent.id, job.jobId, [
    s.thinking('Inspect the failing case.'),
    s.text('Checking the redirect now.'),
    s.toolUse('tool-1', 'Bash', { command: 'npm test' }),
    s.toolResult('tool-1', 'Tests passed'),
  ]);
  await expect(page.getByLabel('Agent is writing')).toHaveCount(0);
  await page.getByLabel('Thinking', { exact: true }).getByRole('button').click();
  await expect(page.getByText('Inspect the failing case.')).toBeVisible();
  await page
    .getByLabel('Activity', { exact: true })
    .getByRole('button', { name: /1 action/ })
    .click();
  await page.getByRole('button', { name: /Ran.*npm test/ }).click();
  await expect(page.getByText('Tests passed', { exact: true })).toBeVisible();

  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Please check logout too.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByLabel('Delivery: Delivered')).toBeVisible();
  await expect.poll(async () => (await messages(page.request, agent.id)).some((m) => m.type === 'job.input')).toBe(true);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await messages(page.request, agent.id)).some((m) => m.type === 'job.interrupt')).toBe(true);
  await replay(page.request, agent.id, job.jobId, [s.text('Stopped after checking logout.'), s.result()]);
  await expect(page.getByLabel('Turn summary')).toContainText('Turn finished');
  await replay(page.request, agent.id, job.jobId, [], true);
  await expect(page.getByLabel('Session: waiting for messages')).toBeVisible();

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'editable markdown', exact: true }).fill('Include the logout flow.');
  await page.getByRole('textbox', { name: 'editable markdown', exact: true }).press('Escape');
  await expect(page.getByRole('button', { name: 'Notify agent' })).toBeVisible();
  await page.getByRole('button', { name: 'Notify agent' }).click();
  await expect(page.getByRole('button', { name: 'Notify agent' })).toHaveCount(0);
  await expect(page.getByLabel('System comment').filter({ hasText: 'notified the agent' })).toBeVisible();
});

test('shows card state and lets a member reorder the queue without managing agents', async ({ browser }) => {
  const admin = await browser.newContext();
  await login(admin.request);
  const project = await createProject(admin.request);
  const tasks = await Promise.all(['First', 'Second', 'Third'].map((title) => createTask(admin.request, project, title)));
  const agent = await seedAgent(admin.request, 'Queue agent');
  for (const task of [tasks[1]!, tasks[2]!, tasks[0]!]) {
    const { task: current } = await (await admin.request.get(`/api/v1/tasks/${task.id}`)).json();
    expect((await admin.request.patch(`/api/v1/tasks/${task.id}`, { headers, data: { version: current.version, agentId: agent.id } })).ok()).toBe(true);
    expect((await admin.request.post(`/api/v1/tasks/${task.id}/comments`, { headers, data: { body: 'Please get started.' } })).ok()).toBe(true);
    if (task.id !== tasks[0]!.id) {
      const job = await jobStart(admin.request, agent.id, task.id);
      await replay(admin.request, agent.id, job.jobId, [new Stream(job.sessionId).result()], true);
      await expect.poll(async () => (await (await admin.request.get(`/api/v1/tasks/${task.id}/session`)).json()).session.state).toBe('idle');
    }
  }
  const running = await jobStart(admin.request, agent.id, tasks[0]!.id);
  for (const task of tasks.slice(1)) {
    expect((await admin.request.post(`/api/v1/tasks/${task.id}/comments`, { headers, data: { body: `Follow up on ${task.key}` } })).ok()).toBe(true);
  }
  const email = `member-${Date.now()}@example.com`;
  await admin.request.post('/api/v1/users', { headers, data: { email, displayName: 'Member', temporaryPassword: 'temporary-password' } });
  const member = await browser.newContext();
  await login(member.request, email, 'temporary-password');
  expect(
    (await member.request.post('/api/v1/auth/password', { headers, data: { currentPassword: 'temporary-password', newPassword: 'member-password' } })).ok(),
  ).toBe(true);
  const page = await member.newPage();
  await page.goto(`/p/${project.key}`);
  await expect(page.getByRole('article', { name: tasks[1]!.key }).getByLabel(`Agent ${agent.name}: queued #1`)).toBeVisible();
  await page.goto(`/agents/${agent.id}`);
  await expect(page.getByRole('tab', { name: 'Configuration' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restart', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `Move ${tasks[2]!.key} up` }).click();
  await expect(page.getByRole('list', { name: 'Agent queue' }).getByRole('listitem').first()).toContainText(tasks[2]!.key);
  await page.getByRole('button', { name: `Remove ${tasks[2]!.key}`, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Agent queue' }).getByRole('listitem')).toHaveCount(1);
  await page.goto(`/t/${tasks[2]!.key}`);
  await expect(page.getByLabel('Delivery: Not delivered')).toBeVisible();
  await page.goto(`/t/${tasks[1]!.key}`);
  await expect(page.getByLabel('Delivery: Queued')).toBeVisible();
  await replay(admin.request, agent.id, running.jobId, [new Stream(running.sessionId).result()], true);
  await expect(page.getByLabel('Delivery: Delivered')).toBeVisible();
  await page.goto('/admin/credentials');
  await expect(page.getByText('Page not found')).toBeVisible();
  await member.close();
  await admin.close();
});

test('saves project setup, instructions and write-only environment secrets', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByLabel('Worktree setup script').fill('npm ci');
  await page.getByLabel('Agent instructions').fill('Always add regression tests.');
  await page.getByRole('button', { name: 'Save agent settings' }).click();
  await expect(page.getByText('Agent settings saved', { exact: true })).toBeVisible();
  await page.getByLabel('Variable name').fill('DEPLOY_SECRET');
  await page.getByLabel('Variable value').fill('private-value-6789');
  await page.getByRole('checkbox', { name: 'Secret', exact: true }).check();
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  await expect(page.getByText('Secret · …6789')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('private-value-6789');
  await page.reload();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(page.getByLabel('Worktree setup script')).toHaveValue('npm ci');
  await expect(page.getByLabel('Agent instructions')).toHaveValue('Always add regression tests.');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Variable value')).toHaveValue('');
});

test('imports a .env file and merges it with the existing variables', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByLabel('Variable name').fill('KEEP_ME');
  await page.getByLabel('Variable value').fill('kept');
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  await expect(page.getByText('kept', { exact: true })).toBeVisible();
  await page.getByLabel('.env file').setInputFiles({ name: '.env', mimeType: 'text/plain', buffer: Buffer.from('# staging\nKEEP_ME=replaced\nAPI_URL="https://staging.example.com"\n') });
  await expect(page.getByRole('list', { name: 'Variables to import' })).toContainText('KEEP_ME· overwrites');
  await page.getByRole('button', { name: 'Import 2 variables' }).click();
  await expect(page.getByText('Imported 2 variables')).toBeVisible();
  await expect(page.getByText('https://staging.example.com', { exact: true })).toBeVisible();
  await expect(page.getByText('replaced', { exact: true })).toBeVisible();
  await page.getByLabel('.env content').fill('not a variable');
  await expect(page.getByText('Line 1: expected NAME=value')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
});

test('shows setup failures and retries the same session only on request', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Recover setup');
  const agent = await seedAgent(page.request, 'Retry agent');
  await page.goto(`/t/${task.key}`);
  await assignAndStart(page, agent.name);
  const start = await jobStart(page.request, agent.id, task.id);
  expect(
    (
      await page.request.post(`/api/v1/__test/runners/${agent.id}`, { headers, data: { jobId: start.jobId, failure: 'npm ci failed: lockfile is missing' } })
    ).ok(),
  ).toBe(true);
  await expect(page.getByLabel('System comment')).toContainText('lockfile is missing');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(async () => (await messages(page.request, agent.id)).filter((m) => m.type === 'job.start').length).toBe(2);
  const starts = (await messages(page.request, agent.id)).filter((m) => m.type === 'job.start');
  expect(starts[1]!.sessionId).toBe(start.sessionId);
  await expect(page.getByLabel('Session: running')).toBeVisible();
});

test('keeps the live session state when an older HTTP snapshot arrives late', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Live session state');
  const agent = await seedAgent(page.request, 'Live state agent');
  let release!: () => void;
  let received!: () => void;
  let completed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    received = resolve;
  });
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  await page.route(
    `**/tasks/${task.id}/session`,
    async (route) => {
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
      completed();
    },
    { times: 1 },
  );
  try {
    await page.goto(`/t/${task.key}`);
    await ready;
    await assignAndStart(page, agent.name);
    await jobStart(page.request, agent.id, task.id);
    await expect(page.getByLabel('Session: running')).toBeVisible();
    release();
    await done;
    await expect(page.getByLabel('Session: running')).toBeVisible();
  } finally {
    release();
  }
});
