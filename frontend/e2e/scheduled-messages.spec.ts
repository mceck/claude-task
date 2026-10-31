import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createProject, createTask, login } from './helpers';

// The usage-limit offer ("Schedule resume" / "No") needs a System Comment from a rate-limited Turn, which this
// backend cannot be made to produce without a real runner: the backend tests cover it, the card is only type-checked.

/** A `datetime-local` value, in the browser's time zone, this many hours from now. */
const inHours = (page: Page, hours: number) =>
  page.evaluate((h) => {
    const d = new Date(Date.now() + h * 3_600_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, hours);

test('schedules a comment, edits its time, cancels it and sees it in the history', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Later');
  await page.goto(`/t/${task.key}`);

  const composer = page.getByRole('textbox', { name: 'Comment', exact: true });
  await composer.fill('Check the build tomorrow');
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  const picker = page.getByLabel('Send at');
  await picker.fill(await inHours(page, -1));
  await expect(page.getByText('at least a minute from now')).toBeVisible();
  await picker.fill(await inHours(page, 5));
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();

  const strip = page.getByRole('region', { name: 'Scheduled', exact: true });
  await expect(strip).toContainText('Check the build tomorrow');
  await expect(strip).toContainText('Admin');
  // Nothing was published as a Comment, and the composer is clear.
  await expect(page.getByRole('listitem', { name: 'Comment' })).toHaveCount(0);
  await expect(composer).toHaveText('');

  await strip.getByRole('button', { name: 'Edit' }).click();
  await strip.getByLabel('Scheduled message text').fill('Check the build in the morning');
  await strip.getByLabel('Send at').fill(await inHours(page, 8));
  await strip.getByRole('button', { name: 'Save' }).click();
  await expect(strip).toContainText('Check the build in the morning');

  const listed = async () => (await (await page.request.get(`/api/v1/tasks/${task.id}/scheduled-messages`)).json()).messages;
  expect((await listed())[0].body).toBe('Check the build in the morning');

  await strip.getByRole('button', { name: 'Cancel' }).click();
  await expect(strip.getByRole('button', { name: 'Send now' })).toHaveCount(0);
  await strip.getByRole('button', { name: /History/ }).click();
  await expect(strip.getByRole('list', { name: 'Scheduled history' })).toContainText('Cancelled');
  expect((await listed())[0].state).toBe('cancelled');
});

test('sends a scheduled internal note now, keeping it out of the Agent conversation', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Reminder');
  await page.goto(`/t/${task.key}`);

  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Remind the team');
  await page.getByRole('switch', { name: 'Internal chat' }).click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByLabel('Send at').fill(await inHours(page, 24));
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();

  const strip = page.getByRole('region', { name: 'Scheduled', exact: true });
  await expect(strip).toContainText('Internal chat');
  await strip.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByRole('listitem', { name: 'Internal chat' })).toContainText('Remind the team');
  await expect(strip.getByRole('button', { name: 'Send now' })).toHaveCount(0);
});

test('switches automatic resume on a Task and on the Project', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Overnight');
  const autoResume = async () => (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).task.autoResume;
  expect(await autoResume()).toBe(false);

  await page.goto(`/t/${task.key}`);
  await page.getByRole('button', { name: 'Task actions' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Automatic resume at limit' }).click();
  await expect.poll(autoResume).toBe(true);
  await page.getByRole('button', { name: 'Task actions' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Automatic resume at limit' })).toBeChecked();
  await page.keyboard.press('Escape');

  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('switch', { name: 'Automatic resume at limit' }).click();
  const settings = async () => (await (await page.request.get(`/api/v1/projects/${project.id}/agent-settings`)).json()).settings;
  await expect.poll(async () => (await settings()).autoResume).toBe(true);
});
