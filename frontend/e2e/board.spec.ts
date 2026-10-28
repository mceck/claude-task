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

test('marks cards with unread comments and clears them once the task is read', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Has news');
  const posted = await page.request.post(`/api/v1/tasks/${task.id}/comments`, { data: { body: 'Fresh news' }, headers: { 'x-claude-task': '1' } });
  expect(posted.status()).toBe(201);
  await page.goto(`/p/${project.key}`);

  const card = page.getByRole('article', { name: task.key });
  await expect(card.getByTestId('task-unread')).toHaveAccessibleName('1 unread comment');
  await expect(card.getByTestId('task-unread')).toHaveAccessibleName('1 unread comment');
  await expect(card.locator('p')).toHaveCSS('font-weight', '600');
  await card.click();
  await expect(page.getByText('Fresh news')).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}/preferences`)).json()).preference.unreadComments)
    .toBe(0);

  await page.keyboard.press('Escape');
  await expect(card.getByTestId('task-unread')).toHaveCount(0);
  await expect(card.locator('p')).toHaveCSS('font-weight', '500');
});

test('updates muted Task badges live for Comments, deletions and reads on another client', async ({ browser }) => {
  const a = await loggedInContext(browser);
  const b = await loggedInContext(browser);
  try {
    const project = await createProject(a.request);
    const task = await createTask(a.request, project, 'Muted news');
    const headers = { 'x-claude-task': '1' };
    const mute = await a.request.patch(`/api/v1/tasks/${task.id}/preferences`, { data: { muted: true, following: false }, headers });
    expect(mute.status()).toBe(200);
    const page = await a.newPage();
    await page.goto(`/p/${project.key}`);
    const card = page.getByRole('article', { name: task.key });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('task-unread')).toHaveCount(0);
    const current = (await (await a.request.get(`/api/v1/tasks/${task.id}`)).json()).task;
    expect((await a.request.patch(`/api/v1/tasks/${task.id}`, { data: { version: current.version, priority: 'high' }, headers })).status()).toBe(200);
    await expect(card.locator('p')).toHaveCSS('font-weight', '600');
    await expect(card.getByTestId('task-unread')).toHaveCount(0);

    const first = await a.request.post(`/api/v1/tasks/${task.id}/comments`, { data: { body: 'Public news' }, headers });
    expect(first.status()).toBe(201);
    await expect(card.getByTestId('task-unread')).toHaveAccessibleName('1 unread comment');
    const second = await b.request.post(`/api/v1/tasks/${task.id}/comments`, { data: { body: 'Internal news', internal: true }, headers });
    expect(second.status()).toBe(201);
    await expect(card.getByTestId('task-unread')).toHaveAccessibleName('2 unread comments');
    const secondComment = (await second.json()).comment;
    expect((await b.request.delete(`/api/v1/comments/${secondComment.id}`, { headers })).status()).toBe(204);
    await expect(card.getByTestId('task-unread')).toHaveAccessibleName('1 unread comment');

    const reader = await b.newPage();
    await reader.goto(`/t/${task.key}`);
    await expect(reader.getByText('Public news')).toBeVisible();
    await expect(card.getByTestId('task-unread')).toHaveCount(0);
    await expect(card.locator('p')).toHaveCSS('font-weight', '500');
  } finally {
    await a.close();
    await b.close();
  }
});

for (const initial of [true, false]) {
  test(`a delayed ${initial ? 'initial' : 'refreshed'} preference response preserves a newer read position`, async ({ page }) => {
    await login(page.request);
    const project = await createProject(page.request);
    const task = await createTask(page.request, project, 'Delayed snapshot');
    const headers = { 'x-claude-task': '1' };
    const first = await page.request.post(`/api/v1/tasks/${task.id}/comments`, { data: { body: 'First news' }, headers });
    expect(first.status()).toBe(201);
    const card = page.getByRole('article', { name: task.key });
    if (!initial) {
      await page.goto(`/p/${project.key}`);
      await expect(card.getByTestId('task-unread')).toHaveAccessibleName('1 unread comment');
    }

    let release!: () => void;
    let captured!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const snapshot = new Promise<void>((resolve) => { captured = resolve; });
    let delayed = false;
    await page.route(`**/projects/${project.id}/task-preferences`, async (route) => {
      const response = await route.fetch();
      if (!delayed) {
        delayed = true;
        captured();
        await held;
      }
      await route.fulfill({ response });
    });
    try {
      let comment = (await first.json()).comment;
      if (initial) {
        await page.goto(`/p/${project.key}`);
      } else {
        const second = await page.request.post(`/api/v1/tasks/${task.id}/comments`, { data: { body: 'Second news' }, headers });
        expect(second.status()).toBe(201);
        comment = (await second.json()).comment;
      }
      await snapshot;
      await expect(card).toBeVisible();
      const read = await page.request.put(`/api/v1/tasks/${task.id}/read-position`, { data: { itemId: comment.id }, headers });
      expect(read.status()).toBe(200);
      await expect(card.getByTestId('task-unread')).toHaveCount(0);
      const staleResponse = page.waitForResponse(`**/projects/${project.id}/task-preferences`);
      release();
      await staleResponse;
      await expect(card.getByTestId('task-unread')).toHaveCount(0);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

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

test('posts a comment and an internal chat, seen live elsewhere', async ({ browser }) => {
  const a = await loggedInContext(browser);
  const b = await loggedInContext(browser);
  const project = await createProject(a.request);
  const task = await createTask(a.request, project, 'Discuss me');

  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await pageA.goto(`/p/${project.key}?task=${task.key}`);
  await pageB.goto(`/t/${task.key}`);
  await expect(pageB.getByRole('list', { name: 'Timeline' })).toBeVisible();

  // One WYSIWYG editor: no Write/Preview tabs.
  await expect(pageA.getByRole('textbox', { name: 'Comment', exact: true })).toBeVisible();
  await expect(pageA.getByRole('button', { name: /^(write|preview)$/i })).toHaveCount(0);
  // No toolbar, and one line that grows to three, then scrolls.
  const composer = pageA.getByRole('textbox', { name: 'Comment', exact: true });
  await expect(pageA.getByRole('toolbar')).toHaveCount(0);
  const lineHeight = await composer.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect((await composer.boundingBox())!.height).toBeCloseTo(lineHeight, 0);
  await composer.click();
  for (let i = 0; i < 5; i++) await pageA.keyboard.press('Shift+Enter');
  expect((await composer.boundingBox())!.height).toBeCloseTo(3 * lineHeight, 0);
  for (let i = 0; i < 5; i++) await pageA.keyboard.press('Backspace');
  // Markdown typed in the editor becomes formatting, and Enter sends.
  await pageA.getByRole('textbox', { name: 'Comment', exact: true }).click();
  await pageA.keyboard.type('This is **important**');
  await pageA.getByRole('textbox', { name: 'Comment', exact: true }).press('Enter');
  const comment = pageA.getByRole('listitem', { name: 'Comment' });
  await expect(comment.locator('strong')).toHaveText('important');

  await pageA.getByRole('switch', { name: 'Internal chat' }).click();
  await pageA.getByRole('textbox', { name: 'Comment', exact: true }).fill('Only for us');
  await pageA.getByRole('button', { name: 'Send' }).click();
  const note = pageA.getByRole('listitem', { name: 'Internal chat' });
  await expect(note).toContainText('Only for us');
  await expect(note).toContainText('Internal chat');

  await expect(pageB.getByRole('listitem', { name: 'Comment' }).locator('strong')).toHaveText('important', { timeout: 1000 });
  await expect(pageB.getByRole('listitem', { name: 'Internal chat' })).toContainText('Only for us', { timeout: 1000 });

  // Editing a comment uses the same editor.
  await comment.getByRole('button', { name: 'Comment actions' }).click();
  await pageA.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = pageA.getByRole('textbox', { name: 'Edit comment', exact: true });
  await expect(edit).toBeFocused();
  await pageA.keyboard.type(' Really.');
  await pageA.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(comment).toContainText('This is important Really.');

  // Pasted files become attachments of the comment, not part of its text.
  await pageA.getByRole('switch', { name: 'Internal chat' }).click();
  await pageA.getByRole('textbox', { name: 'Comment', exact: true }).evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(pageA.getByLabel('Files to attach')).toContainText('notes.txt');
  await expect(pageA.getByRole('textbox', { name: 'Comment', exact: true })).toHaveText('');
  await a.close();
  await b.close();
});

test('reading a task on the web moves the read position, also for comments arriving while it is open', async ({ page, browser }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Read me');
  const writer = await loggedInContext(browser);
  try {
    const post = (body: string) =>
      writer.request.post(`/api/v1/tasks/${task.id}/comments`, { data: { body }, headers: { 'x-claude-task': '1' } });
    expect((await post('Before opening')).status()).toBe(201);
    const unread = async () =>
      (await (await page.request.get(`/api/v1/tasks/${task.id}/preferences`)).json()).preference.unread as boolean;
    expect(await unread()).toBe(true);

    await page.goto(`/t/${task.key}`);
    await expect(page.getByText('Before opening')).toBeVisible();
    await expect.poll(unread).toBe(false);

    expect((await post('While open')).status()).toBe(201);
    await expect(page.getByText('While open')).toBeVisible();
    await expect.poll(unread).toBe(false);
  } finally {
    await writer.close();
  }
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

test('closes a task from its header in one click', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Wrap me up', 'Todo');
  const closedId = project.statuses.find((s) => s.name === 'Closed')!.id;
  await page.goto(`/t/${task.key}`);

  const close = page.getByRole('button', { name: 'Close task' });
  await expect(close).toBeVisible();
  await close.click();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task.statusId).toBe(closedId);
  await expect(page.getByRole('combobox', { name: 'Status' })).toContainText('Closed');
  // An already closed Task offers no Close.
  await expect(close).toHaveCount(0);
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

for (const view of ['page', 'board dialog'] as const) {
  test(`shows the task from the ${view} with swappable activity and details panels, preserving drafts and receiving live comments`, async ({ page }, testInfo) => {
    await login(page.request);
    const project = await createProject(page.request);
    const task = await createTask(page.request, project, 'Discuss in the activity', 'Todo', {
      description: 'Task details beside the conversation.\n\n'.repeat(40),
    });
    for (const body of ['Earlier discussion.\n\n'.repeat(40), 'The conversation so far.']) {
      await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers: { 'x-claude-task': '1' }, data: { body } });
    }
    await page.goto(view === 'page' ? `/t/${task.key}` : `/p/${project.key}?task=${task.key}`);
    const scope = view === 'page' ? page.locator('body') : page.getByRole('dialog', { name: task.key });
    const composer = scope.getByRole('textbox', { name: 'Comment', exact: true });
    const details = scope.getByRole('region', { name: 'Task details' });
    const activity = scope.getByRole('region', { name: 'Task activity' });

    // Activity first, scrolled to the latest comment, with the details in the sidebar.
    await expect(scope.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Discuss in the activity');
    await expect(composer).toBeInViewport({ ratio: 1 });
    await expect(scope.getByText('The conversation so far.')).toBeInViewport();
    await expect(details).toBeVisible();
    await expect(details).toContainText('Task details beside the conversation.');
    expect((await details.boundingBox())!.x).toBeGreaterThan((await activity.boundingBox())!.x);

    await composer.fill('Keep this draft.');
    await scope.getByRole('switch', { name: 'Internal chat', exact: true }).click();
    await scope.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment.') });
    if (view === 'board dialog') {
      // Escape inside a field never closes the task.
      await composer.press('Escape');
      await expect(scope).toBeVisible();
    }

    await scope.getByRole('button', { name: 'Hide details' }).click();
    await expect(details).toBeHidden();
    await scope.getByRole('button', { name: 'Show details' }).click();
    await expect(details).toBeVisible();

    // Details first: the activity moves to the sidebar, keeping the draft.
    await scope.getByRole('button', { name: 'Focus details' }).click();
    await expect(scope.getByRole('button', { name: 'Focus details' })).toHaveAttribute('aria-pressed', 'true');
    expect((await activity.boundingBox())!.x).toBeGreaterThan((await details.boundingBox())!.x);
    await scope.getByRole('button', { name: 'Hide activity' }).click();
    await expect(activity).toBeHidden();
    await scope.getByRole('button', { name: 'Show activity' }).click();
    await expect(activity).toBeVisible();
    await scope.getByRole('button', { name: 'Focus activity' }).click();
    await expect(composer).toHaveText('Keep this draft.');
    await expect(scope.getByRole('switch', { name: 'Internal chat', exact: true })).toBeChecked();
    await expect(scope.getByLabel('Files to attach')).toContainText('draft.txt');

    await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers: { 'x-claude-task': '1' }, data: { body: 'A new comment while reading.' } });
    await expect(scope.getByRole('listitem', { name: 'Comment', exact: true }).last()).toContainText('A new comment while reading.');
    await expect(scope.getByRole('listitem', { name: 'Comment', exact: true }).last()).toBeInViewport();

    // The board dialog takes the whole screen on phones.
    if (view === 'board dialog') {
      await page.setViewportSize({ width: 390, height: 844 });
      // On narrow screens the sidebar overlays the main panel.
      await scope.getByRole('button', { name: 'Hide details' }).click();
    }
    await expect(scope.getByRole('button', { name: 'Send' })).toBeInViewport();
    await scope.getByRole('button', { name: 'Send' }).click();
    await expect(scope.getByRole('listitem', { name: 'Internal chat' })).toContainText('Keep this draft.');
    await expect(scope.getByRole('listitem', { name: 'Internal chat' })).toContainText('draft.txt');
    await expect(composer).toHaveText('');
    await page.screenshot({ path: testInfo.outputPath('task-view.png') });

    // The layout is a per-browser preference.
    await scope.getByRole('button', { name: 'Focus details' }).click();
    // The phone check above already collapsed the sidebar.
    if (view === 'page') await scope.getByRole('button', { name: 'Hide activity' }).click();
    await page.reload();
    await expect(scope.getByRole('button', { name: 'Focus details' })).toHaveAttribute('aria-pressed', 'true');
    await expect(activity).toBeHidden();
    await expect(details).toBeVisible();

    if (view === 'board dialog') {
      await details.click({ position: { x: 4, y: 4 } });
      await page.keyboard.press('Escape');
      await expect(scope).toHaveCount(0);
      await expect(page).not.toHaveURL(/task=/);
    }
  });
}

test('edits the description in place where it was clicked and saves it once when the edit ends', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Describe me', 'Todo', {
    description: 'First paragraph.\n\n' + 'Filler paragraph.\n\n'.repeat(30) + 'Last paragraph.',
  });
  await page.goto(`/t/${task.key}`);
  // Changes are hidden from the Timeline by default.
  await expect(page.getByLabel('Hide changes')).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Hide changes').click();
  const description = page.getByRole('region', { name: 'Description', exact: true });
  const editor = description.getByRole('textbox', { name: 'editable markdown', exact: true });
  const toolbar = description.getByRole('toolbar');
  // The editor also shows the description, read-only until clicked.
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(toolbar).toBeHidden();
  const first = description.locator('p', { hasText: 'First paragraph.' });
  const before = (await first.boundingBox())!;

  await first.click();
  await expect(editor).toBeFocused();
  await expect(toolbar).toBeVisible();
  await expect(description.getByRole('button', { name: /^(Save|Cancel)$/ })).toHaveCount(0);
  // Starting to edit moves nothing.
  expect(Math.abs((await first.boundingBox())!.y - before.y)).toBeLessThan(1);

  // The caret starts in the clicked paragraph.
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited.');
  const last = description.locator('p', { hasText: 'Last paragraph.' });
  await last.click();
  // Editing far down a long description, the toolbar stays at the top of the panel.
  await expect(toolbar).toBeInViewport();
  await page.keyboard.press('End');
  await page.keyboard.type(' Twice.');
  // No toolbar button for code blocks: the markdown shortcut makes them.
  await expect(toolbar.getByRole('button', { name: /insert code block/i })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.type('```ts ');
  await expect(description.locator('.cm-editor')).toBeVisible();
  await page.keyboard.type('const done = true;');
  await expect(page.getByText('updated the description')).toHaveCount(0);

  // Leaving the editor saves once and keeps the scroll position.
  const details = page.getByRole('region', { name: 'Task details' });
  const scrollTop = await details.evaluate((el) => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await page.getByLabel('Task conversation').click({ position: { x: 4, y: 4 } });
  await expect(toolbar).toBeHidden();
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  expect(Math.abs((await details.evaluate((el) => el.scrollTop)) - scrollTop)).toBeLessThan(1);
  await expect(description).toContainText('First paragraph. Edited.');
  await expect(description).toContainText('Last paragraph. Twice.');
  await expect.poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task.description).toContain('```ts\nconst done = true;\n```');
  await expect(page.getByText('updated the description')).toHaveCount(1);

  // Opening and leaving without changes saves nothing.
  await first.click();
  await expect(editor).toBeFocused();
  await editor.press('Escape');
  await expect(toolbar).toBeHidden();
  await page.reload();
  await expect(description).toContainText('Last paragraph. Twice.');
  await expect(page.getByText('updated the description')).toHaveCount(0);
  await page.getByLabel('Hide changes').click();
  await expect(page.getByText('updated the description')).toHaveCount(1);
});

test('inserts an image into the description from a dialog above the board’s task dialog', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Add a screenshot', 'Todo', { description: 'See below.' });
  await page.goto(`/p/${project.key}?task=${task.key}`);
  const taskDialog = page.getByRole('dialog', { name: task.key });
  const description = taskDialog.getByRole('region', { name: 'Description', exact: true });
  await description.locator('p', { hasText: 'See below.' }).click();
  await page.keyboard.press('End');
  await description.getByRole('button', { name: 'Insert image' }).click();

  const imageDialog = page.getByRole('dialog', { name: 'Insert image' });
  await expect(imageDialog).toBeVisible();
  await expect(imageDialog.getByLabel('Upload an image')).toBeAttached();
  await imageDialog.getByLabel('Image URL').fill('https://example.com/screenshot.png');
  await imageDialog.getByLabel('Alt text').fill('The broken page');
  await imageDialog.getByRole('button', { name: 'Insert' }).click();
  await expect(imageDialog).toHaveCount(0);

  // Still editing: the dialog was part of the edit.
  await expect(description.getByRole('toolbar')).toBeVisible();
  await expect(description.getByRole('img', { name: 'The broken page' })).toBeVisible();
  await taskDialog.getByLabel('Task conversation').click({ position: { x: 4, y: 4 } });
  await expect(description.getByRole('toolbar')).toBeHidden();
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task.description)
    .toContain('![The broken page](https://example.com/screenshot.png)');
  await expect(taskDialog).toBeVisible();
});

test('makes inline code from one line and a code block from several', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Format code', 'Todo', { description: 'npm install\n\nnpm test\n\nThen deploy.' });
  await page.goto(`/t/${task.key}`);
  const description = page.getByRole('region', { name: 'Description', exact: true });
  const code = description.getByRole('toolbar').getByRole('radio', { name: /^Code/ });

  const first = description.locator('p', { hasText: 'npm install' });
  const second = description.locator('p', { hasText: 'npm test' });
  await first.click();
  await expect(code).toBeVisible();
  // Drag across both lines.
  const from = (await first.boundingBox())!;
  const to = (await second.locator('span').boundingBox())!;
  await page.mouse.move(from.x + 1, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 1, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
  await code.click();
  await expect(description.locator('.cm-editor')).toBeVisible();
  // The new code block takes the caret.
  await expect(description.locator('.cm-content')).toBeFocused();

  await description.locator('p', { hasText: 'Then deploy.' }).dblclick({ position: { x: 50, y: 8 } });
  await code.click();
  await page.getByLabel('Task conversation').click({ position: { x: 4, y: 4 } });
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task.description)
    .toMatch(/^```\nnpm install\nnpm test\n```\n\n.*`deploy`/s);
});
