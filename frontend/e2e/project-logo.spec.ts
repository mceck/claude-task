import { expect, test } from '@playwright/test';
import { createProject, loggedInContext, login } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('uploads, replaces and removes a project logo across settings, navigation, cards and a live board', async ({ page, browser }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Project with logo');
  const second = await loggedInContext(browser);
  const board = await second.newPage();
  try {
    await board.goto(`/p/${project.key}`);
    await expect(board.getByRole('heading', { name: 'Project with logo' })).toBeVisible();
    await page.goto(`/p/${project.key}/settings`);
    const logoSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Project logo', exact: true }) });
    const logo = logoSection.getByRole('img', { name: 'Project with logo logo' });
    await page.getByLabel('Upload logo', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await expect(logo).toBeVisible();
    const firstUrl = await logo.getAttribute('src');
    await expect(board.locator('header').getByRole('img', { name: 'Project with logo logo' })).toHaveAttribute('src', firstUrl!);

    await page.getByLabel('Replace logo', { exact: true }).setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: PNG });
    await expect(logo).not.toHaveAttribute('src', firstUrl!);
    const nextUrl = await logo.getAttribute('src');
    await expect(board.locator('header').getByRole('img', { name: 'Project with logo logo' })).toHaveAttribute('src', nextUrl!);
    await page.reload();
    await expect(logo).toHaveAttribute('src', nextUrl!);
    await page.goto('/');
    await expect(page.getByRole('link').filter({ hasText: 'Project with logo' }).getByRole('img', { name: 'Project with logo logo' })).toHaveCount(2);

    await page.goto(`/p/${project.key}/settings`);
    await page.getByRole('button', { name: 'Remove logo', exact: true }).click();
    await expect(logo).toHaveCount(0);
    await expect(page.getByLabel('Upload logo', { exact: true })).toBeEnabled();
    await expect(board.getByRole('img', { name: 'Project with logo logo' })).toHaveCount(0);
  } finally {
    await second.close();
  }
});

test('rejects unsupported and oversized files without changing the project', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  await page.goto(`/p/${project.key}/settings`);
  const input = page.getByLabel('Upload logo', { exact: true });
  await input.setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByText('The logo must be a PNG, JPEG, GIF or WebP image', { exact: true })).toBeVisible();
  await input.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  await expect(page.getByText('The logo must be at most 2 MB', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove logo', exact: true })).toHaveCount(0);
});
