import { expect, test } from '@playwright/test';
import { login, seedAgent } from './helpers';

test('creates a global schedule, runs it now and opens the run from its history', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Scheduler agent');
  const name = `Morning triage ${Date.now()}`;
  await page.goto('/schedules');
  await expect(page.getByText('No schedules yet.')).toBeVisible();
  await page.getByRole('button', { name: 'New schedule' }).click();
  await page.getByLabel('Schedule name').fill(name);
  await page.getByLabel('Agent', { exact: true }).selectOption(agent.id);
  await page.getByLabel('Cron expression').fill('0 9 * * 1-5');
  await expect(page.getByText('Monday to Friday at 09:00')).toBeVisible();
  await page.getByLabel('Prompt').fill('Look at every board and report what is stuck.');
  await page.getByRole('button', { name: 'Create schedule' }).click();
  await expect(page).toHaveURL(/\/schedules\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByText('No runs yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Run now' }).click();
  const link = page.getByRole('table').getByRole('link').first();
  await expect(link).toBeVisible();
  await expect(page.getByRole('table').getByText('Running')).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/schedules\/[0-9a-f-]+\/runs\/[A-Z]+-1$/);
  await expect(page.getByLabel('Task conversation').getByText('Look at every board and report what is stuck.')).toBeVisible();

  await page.getByRole('link', { name: 'Back to the schedule' }).click();
  await page.getByRole('link', { name: 'Back to schedules' }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Global');
  await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Monday to Friday at 09:00');
});
