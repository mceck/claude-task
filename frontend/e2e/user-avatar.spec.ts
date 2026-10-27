import { expect, test } from '@playwright/test';
import { createProject, createTask, login } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('an Admin changes a User photo, sees it on earlier Comments and removes it', async ({ page }) => {
  await login(page.request);
  const me = (await (await page.request.get('/api/v1/auth/me')).json()).user;
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Avatar conversation');
  const posted = await page.request.post(`/api/v1/tasks/${task.id}/comments`, {
    data: { body: 'A comment written before the profile photo' }, headers: { 'x-claude-task': '1' },
  });
  expect(posted.ok()).toBeTruthy();
  await page.goto('/admin/users');
  await page.getByRole('button', { name: `Actions for ${me.displayName}` }).click();
  await page.getByRole('menuitem', { name: 'Change photo' }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('Profile image', { exact: true });
  await input.setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: PNG });
  const image = dialog.locator('img');
  await expect(image).toBeVisible();
  const first = await image.getAttribute('src');
  await input.setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: PNG });
  await expect(image).not.toHaveAttribute('src', first!);
  const next = await image.getAttribute('src');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.goto(`/t/${task.key}`);
  await expect(page.getByText('A comment written before the profile photo', { exact: true })).toBeVisible();
  await expect(page.locator(`img[src="${next}"]`).first()).toBeVisible();
  await page.goto('/admin/users');
  await page.getByRole('button', { name: `Actions for ${me.displayName}` }).click();
  await page.getByRole('menuitem', { name: 'Change photo' }).click();
  await dialog.getByRole('button', { name: 'Remove photo', exact: true }).click();
  await expect(image).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Remove photo', exact: true })).toHaveCount(0);
});

test('reports invalid photos and keeps the current avatar', async ({ page }) => {
  await login(page.request);
  const me = (await (await page.request.get('/api/v1/auth/me')).json()).user;
  await page.goto('/admin/users');
  await page.getByRole('button', { name: `Actions for ${me.displayName}` }).click();
  await page.getByRole('menuitem', { name: 'Change photo' }).click();
  const input = page.getByLabel('Profile image', { exact: true });
  await input.setInputFiles({ name: 'avatar.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByText('Choose a PNG, JPEG, GIF or WebP image up to 2 MB.', { exact: true })).toBeVisible();
  await input.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  await expect(page.getByText('Choose a PNG, JPEG, GIF or WebP image up to 2 MB.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(0);
});
