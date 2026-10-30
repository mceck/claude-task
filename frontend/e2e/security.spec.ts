import { expect, test } from '@playwright/test';
import { createProject, createTask, login } from './helpers';

test('a 401 from a write rechecks the Login and sends you to login', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Edit after logout', 'Todo');
  await page.goto(`/t/${task.key}`);
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  await expect(title).toHaveValue('Edit after logout');

  // The Login ends between opening the page and saving: the write 401s, then the
  // Login check finds the session gone and the app routes to /login.
  let expired = false;
  await page.route(`**/api/v1/tasks/${task.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    expired = true;
    await route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Not logged in' } } });
  });
  await page.route('**/api/v1/auth/me', async (route) => {
    if (!expired) return route.fallback();
    await route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Not logged in' } } });
  });
  await title.fill('Changed without a Login');
  await title.press('Enter');
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

test('a transient failure loading the current User is retried', async ({ page }) => {
  let first = true;
  await page.route('**/api/v1/auth/me', async (route) => {
    if (!first) return route.fallback();
    first = false;
    await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Starting up' } } });
  });
  await login(page.request);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 15_000 });
});

// Descriptions are written by members and by Agents (update_task), so their HTML is untrusted.
test('never runs HTML from a task description', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Hostile description', 'Todo', {
    description: [
      'Before the payload.',
      '<details open ontoggle="window.__xss = \'details\'">x</details>',
      '<iframe srcdoc="<script>parent.__xss = \'iframe\'</script>"></iframe>',
      'Inline <img src="/x.png" onerror="window.__xss = \'img\'" /> image.',
      'After the payload.',
    ].join('\n\n'),
  });
  await page.goto(`/t/${task.key}`);
  const description = page.getByRole('region', { name: 'Description', exact: true });
  await expect(description).toContainText('After the payload.');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as { __xss?: string }).__xss)).toBeUndefined();
  await expect(description.locator('details, iframe, [ontoggle], [onerror]')).toHaveCount(0);

  // Editing it must not bring the HTML to life either.
  await description.getByText('After the payload.').click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as { __xss?: string }).__xss)).toBeUndefined();
  await expect(description.locator('details, iframe, [ontoggle], [onerror]')).toHaveCount(0);
});
