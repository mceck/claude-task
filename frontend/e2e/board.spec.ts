import { expect, test } from '@playwright/test';
import pg from 'pg';
import { ADMIN, cardTitles, column, createProject, createTask, drag, loggedInContext, login } from './helpers';

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('logs in and lands on the projects list', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');

  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByText('Ada Admin')).toBeVisible();
});

test('creates a task from the board', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  await page.goto(`/p/${project.key}`);

  const todo = column(page, 'Todo');
  await todo.getByRole('button', { name: 'Add task' }).click();
  await todo.getByLabel('New task title').fill('Write the release notes');
  await todo.getByLabel('New task title').press('Enter');
  await expect(todo.getByRole('article', { name: `${project.key}-1` })).toContainText('Write the release notes');

  await page.reload();
  await expect(column(page, 'Todo').getByRole('article', { name: `${project.key}-1` })).toBeVisible();
});

test('drags between columns and within a column; another browser sees it live', async ({ browser }) => {
  const a = await loggedInContext(browser);
  const b = await loggedInContext(browser);
  const project = await createProject(a.request);
  for (const title of ['first', 'second', 'third']) await createTask(a.request, project, title, 'Todo');
  await createTask(a.request, project, 'busy', 'In Progress');

  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await pageA.goto(`/p/${project.key}`);
  await pageB.goto(`/p/${project.key}`);
  await expect(column(pageB, 'Todo').getByRole('article')).toHaveCount(3);

  // Across columns: "second" goes to the top of In Progress.
  const second = column(pageA, 'Todo').getByRole('article').filter({ hasText: 'second' });
  const busy = column(pageA, 'In Progress').getByRole('article').filter({ hasText: 'busy' });
  await drag(pageA, second, busy, 'top');
  await expect.poll(() => cardTitles(pageA, 'In Progress')).toEqual(['second', 'busy']);
  await expect.poll(() => cardTitles(pageB, 'In Progress'), { timeout: 1000 }).toEqual(['second', 'busy']);
  await expect.poll(() => cardTitles(pageB, 'Todo'), { timeout: 1000 }).toEqual(['first', 'third']);

  // Within a column: "third" above "first".
  const third = column(pageA, 'Todo').getByRole('article').filter({ hasText: 'third' });
  const first = column(pageA, 'Todo').getByRole('article').filter({ hasText: 'first' });
  await drag(pageA, third, first, 'top');
  await expect.poll(() => cardTitles(pageA, 'Todo')).toEqual(['third', 'first']);
  await expect.poll(() => cardTitles(pageB, 'Todo'), { timeout: 1000 }).toEqual(['third', 'first']);

  // Into an empty column, then below the last card of another.
  await drag(pageA, column(pageA, 'Todo').getByRole('article').filter({ hasText: 'first' }), column(pageA, 'Done'));
  await expect.poll(() => cardTitles(pageB, 'Done'), { timeout: 1000 }).toEqual(['first']);
  await drag(pageA, column(pageA, 'Todo').getByRole('article').filter({ hasText: 'third' }), column(pageA, 'In Progress'), 'bottom');
  await expect.poll(() => cardTitles(pageB, 'In Progress'), { timeout: 1000 }).toEqual(['second', 'busy', 'third']);

  await pageA.reload();
  await expect.poll(() => cardTitles(pageA, 'Todo')).toEqual([]);
  await expect.poll(() => cardTitles(pageA, 'In Progress')).toEqual(['second', 'busy', 'third']);
  await expect.poll(() => cardTitles(pageA, 'Done')).toEqual(['first']);
  await a.close();
  await b.close();
});

test('posts a comment and an internal note, seen live elsewhere', async ({ browser }) => {
  const a = await loggedInContext(browser);
  const b = await loggedInContext(browser);
  const project = await createProject(a.request);
  const task = await createTask(a.request, project, 'Discuss me');

  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await pageA.goto(`/p/${project.key}?task=${task.key}`);
  await pageB.goto(`/t/${task.key}`);
  await expect(pageB.getByRole('list', { name: 'Timeline' })).toBeVisible();

  await pageA.getByRole('textbox', { name: 'Comment', exact: true }).fill('This is **important**');
  await pageA.getByRole('textbox', { name: 'Comment', exact: true }).press('ControlOrMeta+Enter');
  const comment = pageA.getByRole('listitem', { name: 'Comment' });
  await expect(comment.locator('strong')).toHaveText('important');

  await pageA.getByRole('switch', { name: 'Internal note' }).click();
  await pageA.getByRole('textbox', { name: 'Comment', exact: true }).fill('Only for us');
  await pageA.getByRole('button', { name: 'Add note' }).click();
  const note = pageA.getByRole('listitem', { name: 'Internal note' });
  await expect(note).toContainText('Only for us');
  await expect(note).toContainText('Internal note');

  await expect(pageB.getByRole('listitem', { name: 'Comment' }).locator('strong')).toHaveText('important', { timeout: 1000 });
  await expect(pageB.getByRole('listitem', { name: 'Internal note' })).toContainText('Only for us', { timeout: 1000 });
  await a.close();
  await b.close();
});

test('uploads an image and previews it inline', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Has a screenshot');
  await page.goto(`/t/${task.key}`);

  await page.getByLabel('Attach files').setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('list', { name: 'Files to attach' })).toContainText('screenshot.png');
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('See attached');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  const image = page.getByRole('img', { name: 'screenshot.png' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
});

test('hides closed statuses until toggled, and combines filters', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  await createTask(page.request, project, 'Shipped long ago', 'Closed');
  await createTask(page.request, project, 'Urgent login bug', 'Todo', { priority: 'urgent' });
  await createTask(page.request, project, 'Urgent docs', 'Todo', { priority: 'urgent' });
  await createTask(page.request, project, 'Minor login tweak', 'Todo', { priority: 'low' });
  await page.goto(`/p/${project.key}`);

  await expect(column(page, 'Todo')).toBeVisible();
  await expect(column(page, 'Closed')).toHaveCount(0);
  // The toggle lives in the URL, which updates asynchronously, so click and then assert.
  await page.getByLabel('Show closed').click();
  await expect(page.getByLabel('Show closed')).toBeChecked();
  await expect(column(page, 'Closed').getByRole('article')).toContainText('Shipped long ago');
  await page.getByLabel('Show closed').click();
  await expect(page.getByLabel('Show closed')).not.toBeChecked();
  await expect(column(page, 'Closed')).toHaveCount(0);

  await page.getByLabel('Filter text').fill('login');
  await expect.poll(() => cardTitles(page, 'Todo')).toEqual(['Urgent login bug', 'Minor login tweak']);
  await page.getByRole('button', { name: 'Priority' }).click();
  await page.getByRole('option', { name: 'Urgent' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => cardTitles(page, 'Todo')).toEqual(['Urgent login bug']);
});

test('forces a new user to change their temporary password', async ({ page, browser }) => {
  const admin = await loggedInContext(browser);
  const res = await admin.request.post('/api/v1/users', {
    data: { email: `new-${Date.now()}@example.com`, displayName: 'Newbie' },
    headers: { 'x-claude-task': '1' },
  });
  const { user, temporaryPassword } = await res.json();

  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(temporaryPassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/change-password/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/change-password/);

  await page.getByLabel('Temporary password').fill(temporaryPassword);
  await page.getByLabel('New password (at least 8 characters)').fill('my-own-password');
  await page.getByLabel('Confirm new password').fill('my-own-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await admin.close();
});

test('sends you to login when the login expired while the live connection was down', async ({ page }) => {
  // Proxy the WebSocket so the test can drop it like a server restart would (no browser network event).
  const sockets: { close: (o?: { code?: number; reason?: string }) => Promise<void> }[] = [];
  await page.routeWebSocket('**/api/v1/ws', (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  await login(page.request);
  const project = await createProject(page.request);
  await page.goto(`/p/${project.key}`);
  await expect(column(page, 'Todo')).toBeVisible();
  await expect.poll(() => sockets.length).toBeGreaterThan(0);

  const db = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await db.connect();
  await db.query('delete from logins');
  await db.end();
  for (const ws of sockets) await ws.close({ code: 1001, reason: 'going away' });

  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

function e2eDatabaseUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres');
  url.pathname = '/claude_task_e2e';
  return url.toString();
}

for (const view of ['page', 'board panel'] as const) {
  test(`expands task activity from the ${view}, preserves drafts and receives live comments`, async ({ page }, testInfo) => {
    await login(page.request);
    const project = await createProject(page.request);
    const task = await createTask(page.request, project, 'Discuss in full screen');
    await page.request.post(`/api/v1/tasks/${task.id}/comments`, {
      headers: { 'x-claude-task': '1' },
      data: { body: 'The conversation so far.\n\n' + 'Earlier discussion.\n\n'.repeat(40) },
    });
    await page.goto(view === 'page' ? `/t/${task.key}` : `/p/${project.key}?task=${task.key}`);
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Keep this draft.');
    await page.getByRole('switch', { name: 'Internal note', exact: true }).click();
    await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment.') });
    await page.getByRole('button', { name: 'Expand activity' }).click();
    const chat = page.getByRole('dialog', { name: `${task.key} Activity` });
    await expect(chat).toBeVisible();
    await expect(chat.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue('Keep this draft.');
    await expect(chat.getByRole('switch', { name: 'Internal note', exact: true })).toBeChecked();
    await expect(chat.getByLabel('Files to attach')).toContainText('draft.txt');
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveCount(1);
    const box = (await chat.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(Math.abs(box.x)).toBeLessThan(1);
    expect(Math.abs(box.y)).toBeLessThan(1);
    expect(Math.abs(box.width - viewport.width)).toBeLessThan(1);
    expect(Math.abs(box.height - viewport.height)).toBeLessThan(1);
    await expect(chat.getByRole('button', { name: 'Add note' })).toBeInViewport();

    await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers: { 'x-claude-task': '1' }, data: { body: 'A new comment while reading full screen.' } });
    await expect(chat.getByRole('listitem', { name: 'Comment', exact: true }).last()).toContainText('A new comment while reading full screen.');
    await expect(chat.getByRole('listitem', { name: 'Comment', exact: true }).last()).toBeInViewport();
    await chat.getByRole('button', { name: 'Exit full screen' }).click();
    await expect(chat).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue('Keep this draft.');
    await expect(page.getByLabel('Files to attach')).toContainText('draft.txt');
    await page.getByRole('button', { name: 'Expand activity' }).click();
    await page.keyboard.press('Escape');
    await expect(chat).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Expand activity' })).toBeFocused();

    await page.getByRole('button', { name: 'Expand activity' }).click();
    if (view === 'page') await page.setViewportSize({ width: 390, height: 844 });
    await expect(chat.getByRole('button', { name: 'Add note' })).toBeInViewport();
    await chat.getByRole('button', { name: 'Add note' }).click();
    await expect(chat.getByRole('listitem', { name: 'Internal note' })).toContainText('Keep this draft.');
    await expect(chat.getByRole('listitem', { name: 'Internal note' })).toContainText('draft.txt');
    await expect(chat.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue('');
    await page.screenshot({ path: testInfo.outputPath('task-activity-fullscreen.png') });
  });
}
