// Requests in flight while other changes arrive: late responses, out-of-order events, quick repeated edits.
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { cardTitles, column, createProject, createTask, drag, login } from './helpers';

const headers = { 'x-claude-task': '1' };

/**
 * Holds the response to the next matching request until `release()`. `sent` resolves once the server has
 * handled the request, or once it's caught when it should reach the server only on release (`beforeServer`)
 * or never (`failWith`, the error status the page gets instead). `done` resolves once the page has its answer.
 */
async function holdResponse(page: Page, url: string, method: string, { beforeServer = false, failWith }: { beforeServer?: boolean; failWith?: number } = {}) {
  let release!: () => void;
  let markSent!: () => void;
  let markDone!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const sent = new Promise<void>((resolve) => (markSent = resolve));
  const done = new Promise<void>((resolve) => (markDone = resolve));
  let held = false;
  await page.route(url, async (route) => {
    if (held || route.request().method() !== method) return route.fallback();
    held = true;
    const response = beforeServer || failWith ? null : await route.fetch();
    markSent();
    await gate;
    if (failWith) await route.fulfill({ status: failWith, json: { error: { code: 'internal', message: 'Something broke' } } });
    else await route.fulfill({ response: response ?? (await route.fetch()) });
    markDone();
  });
  return { release, sent, done };
}

test('an edit to a comment older than the loaded timeline shows up only where it belongs, once', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Long discussion');
  const ids: string[] = [];
  for (let i = 1; i <= 55; i++) {
    const res = await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers, data: { body: `Point number ${i}.` } });
    ids.push((await res.json()).comment.id);
  }
  await page.goto(`/t/${task.key}`);
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline.getByText('Point number 55.')).toBeVisible();
  await expect(timeline.getByText('Point number 1.', { exact: true })).toHaveCount(0);

  await page.request.patch(`/api/v1/comments/${ids[0]}`, { headers, data: { body: 'The very first point, reworded.' } });
  await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers, data: { body: 'A fresh reply.' } });
  await expect(timeline.getByText('A fresh reply.')).toBeVisible();
  await expect(timeline.getByText('The very first point, reworded.')).toHaveCount(0);

  await timeline.getByRole('button', { name: 'Load older activity' }).click();
  await expect(timeline.getByText('Point number 2.', { exact: true })).toBeVisible();
  await expect(timeline.getByText('The very first point, reworded.')).toHaveCount(1);
  await expect(timeline.getByRole('listitem', { name: 'Comment', exact: true }).first()).toContainText('The very first point, reworded.');
  await expect(timeline.getByRole('listitem', { name: 'Comment', exact: true })).toHaveCount(56);
});

test('timeline items that arrive out of order are shown in the order they happened', async ({ page }) => {
  // Hold the first comment's event back until the second one has been delivered.
  let held: string | null = null;
  let subscribed = false;
  await page.routeWebSocket('**/api/v1/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'subscribed') subscribed = true;
      if (msg.type === 'event' && msg.event.type === 'comment.created' && msg.event.comment.body === 'Happened first.') return void (held = String(raw));
      ws.send(raw);
      if (held && msg.type === 'event' && msg.event.type === 'comment.created') ws.send(held);
    });
  });
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Ordering');
  await page.goto(`/t/${task.key}`);
  await expect(page.getByText('No activity yet.')).toBeVisible();
  await expect.poll(() => subscribed).toBe(true);
  await page.waitForLoadState('networkidle');

  for (const body of ['Happened first.', 'Happened second.']) {
    await page.request.post(`/api/v1/tasks/${task.id}/comments`, { headers, data: { body } });
  }
  const comments = page.getByRole('listitem', { name: 'Comment', exact: true });
  await expect(comments).toHaveCount(2);
  await expect(comments.first()).toContainText('Happened first.');
  await expect(comments.last()).toContainText('Happened second.');
});

test('a failed move puts back only the moved card, keeping a card created meanwhile', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  await createTask(page.request, project, 'Mover', 'Todo');
  // The server never sees this move: it fails on the way.
  const move = await holdResponse(page, '**/api/v1/tasks/*/move', 'POST', { failWith: 500 });
  await page.goto(`/p/${project.key}`);
  await expect.poll(() => cardTitles(page, 'Todo')).toEqual(['Mover']);

  await drag(page, column(page, 'Todo').getByRole('article').filter({ hasText: 'Mover' }), column(page, 'In Progress'));
  await expect.poll(() => cardTitles(page, 'In Progress')).toEqual(['Mover']);
  await move.sent;
  await createTask(page.request, project, 'Arrived meanwhile', 'Todo');
  await expect.poll(() => cardTitles(page, 'Todo')).toEqual(['Arrived meanwhile']);

  move.release();
  await move.done;
  await expect(page.getByText('Couldn’t move')).toBeVisible();
  await expect.poll(() => cardTitles(page, 'In Progress')).toEqual([]);
  await expect.poll(() => cardTitles(page, 'Todo')).toEqual(['Mover', 'Arrived meanwhile']);
});

test('quick consecutive tag toggles are all saved', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const tagIds: string[] = [];
  for (const name of ['Alpha', 'Beta']) {
    const res = await page.request.post(`/api/v1/projects/${project.id}/tags`, { headers, data: { name, color: '#6366f1' } });
    tagIds.push((await res.json()).tag.id);
  }
  const task = await createTask(page.request, project, 'Tag me twice');
  // The second toggle comes before the server has even seen the first.
  const save = await holdResponse(page, `**/api/v1/tasks/${task.id}`, 'PATCH', { beforeServer: true });
  await page.goto(`/t/${task.key}`);

  await page.getByRole('button', { name: 'Edit tags' }).click();
  await page.getByRole('option', { name: 'Alpha' }).click();
  await save.sent;
  await page.getByRole('option', { name: 'Beta' }).click();
  save.release();
  await page.keyboard.press('Escape');

  await expect.poll(async () => (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task.tagIds.sort()).toEqual([...tagIds].sort());
  const button = page.getByRole('button', { name: 'Edit tags' });
  await expect(button).toContainText('Alpha');
  await expect(button).toContainText('Beta');
  await expect(page.getByText('Someone else changed this task')).toHaveCount(0);
});

test('a late save response doesn’t undo a newer change seen live', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Original title');
  const save = await holdResponse(page, `**/api/v1/tasks/${task.id}`, 'PATCH');
  await page.goto(`/p/${project.key}?task=${task.key}`);
  const dialog = page.getByRole('dialog', { name: task.key });
  // The board behind the dialog is hidden from the accessibility tree.
  const card = page.locator(`article[aria-label="${task.key}"] p`);

  await dialog.getByRole('combobox', { name: 'Priority' }).click();
  await page.getByRole('option', { name: 'High' }).click();
  await save.sent;
  const { version } = (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task;
  await page.request.patch(`/api/v1/tasks/${task.id}`, { headers, data: { version, title: 'Renamed elsewhere' } });
  await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Renamed elsewhere');
  await expect(card).toHaveText('Renamed elsewhere');

  save.release();
  await save.done;
  // Let the late response settle before checking nothing went back.
  await page.waitForTimeout(200);
  await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Renamed elsewhere');
  await expect(card).toHaveText('Renamed elsewhere');
  await expect(dialog.getByRole('combobox', { name: 'Priority' })).toContainText('High');
});

test('keeps text typed while a comment is being sent', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Chatty');
  const send = await holdResponse(page, `**/api/v1/tasks/${task.id}/comments`, 'POST');
  await page.goto(`/t/${task.key}`);
  const composer = page.getByRole('textbox', { name: 'Comment', exact: true });

  await composer.click();
  await page.keyboard.type('Sent right away.');
  await page.keyboard.press('Enter');
  await send.sent;
  await page.keyboard.type('Typed meanwhile.');
  send.release();
  await send.done;

  await expect(page.getByRole('listitem', { name: 'Comment', exact: true })).toContainText('Sent right away.');
  await expect(composer).toHaveText('Typed meanwhile.');
  // Typing goes on where it left off.
  await page.keyboard.type(' And more.');
  await expect(composer).toHaveText('Typed meanwhile. And more.');
});

test('keeps an unsent comment draft per task when the task dialog closes', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const first = await createTask(page.request, project, 'Draft here');
  const second = await createTask(page.request, project, 'Nothing here');
  await page.goto(`/p/${project.key}`);
  const dialog = page.getByRole('dialog');
  const composer = dialog.getByRole('textbox', { name: 'Comment', exact: true });
  const open = async (key: string) => {
    await column(page, 'Todo').getByRole('article', { name: key }).click();
    await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible();
  };
  const close = async () => {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };

  await open(first.key);
  await composer.fill('Half a thought.');
  await close();
  await open(second.key);
  await expect(composer).toHaveText('');
  await close();
  await open(first.key);
  await expect(composer).toHaveText('Half a thought.');

  await dialog.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(dialog.getByRole('listitem', { name: 'Comment', exact: true })).toContainText('Half a thought.');
  await close();
  await open(first.key);
  await expect(composer).toHaveText('');
});
