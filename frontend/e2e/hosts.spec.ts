import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('manages a Host and shows its connect token only once', async ({ page }) => {
  await login(page.request);
  const name = `Host ${Date.now()}`;
  await page.goto('/workers');
  await page.getByRole('tab', { name: 'Hosts', exact: true }).click();
  await page.getByRole('button', { name: 'Add host', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Host name').fill(name);
  await dialog.getByRole('button', { name: 'Add host', exact: true }).click();
  await expect(dialog.getByText('This token is shown only once')).toBeVisible();
  const token = await dialog.getByLabel('Host Token').inputValue();
  await expect(dialog.getByLabel('Connect command 2')).toContainText(token);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('disconnected');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByLabel('Docker network').fill('vpn');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await row.getByRole('button', { name: 'Regenerate token', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Regenerate token', exact: true }).click();
  await expect(dialog.getByLabel('Host Token')).not.toHaveValue(token);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('must be removed by hand');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete host', exact: true }).click();
  await expect(row).toHaveCount(0);
});

test('shows Hosts to a Member without management actions', async ({ browser }) => {
  const admin = await browser.newContext(); await login(admin.request);
  const email = `host-member-${Date.now()}@example.com`;
  // Use the API's shared CSRF header, as the browser client does.
  const { HEADERS } = await import('./helpers');
  await admin.request.post('/api/v1/users', { headers: HEADERS, data: { email, displayName: 'Host Member', role: 'member', temporaryPassword: 'temporary-password' } });
  const member = await browser.newContext(); await login(member.request, email, 'temporary-password');
  await member.request.post('/api/v1/auth/password', { headers: HEADERS, data: { currentPassword: 'temporary-password', newPassword: 'member-password' } });
  const page = await member.newPage(); await page.goto('/workers');
  await page.getByRole('tab', { name: 'Hosts', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Hosts' })).toContainText('Local');
  await expect(page.getByRole('button', { name: 'Add host', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Regenerate token', exact: true })).toHaveCount(0);
  await member.close(); await admin.close();
});
