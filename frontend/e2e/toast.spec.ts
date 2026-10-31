import { expect, test } from '@playwright/test';
import { createProject, login } from './helpers';

test('dismisses a toast when it is clicked and when its close button is pressed', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  await page.route(`**/api/v1/projects/${project.id}/agent-settings`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Temporarily unavailable' } } })
      : route.continue(),
  );
  await page.goto(`/p/${project.key}/settings`);
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  const autoResume = page.getByRole('switch', { name: 'Automatic resume at limit' });

  await autoResume.click();
  const clicked = page.locator('[data-sonner-toast]').filter({ hasText: 'Temporarily unavailable' });
  await expect(clicked).toBeVisible();
  await clicked.getByText('Temporarily unavailable').click();
  // Well under the 4 s auto-dismiss, so the click is what removed it.
  await expect(clicked).toHaveCount(0, { timeout: 1_500 });

  await autoResume.click();
  const closed = page.locator('[data-sonner-toast]').filter({ hasText: 'Temporarily unavailable' });
  await expect(closed).toBeVisible();
  await closed.getByRole('button', { name: 'Close toast' }).click();
  await expect(closed).toHaveCount(0, { timeout: 1_500 });
});
