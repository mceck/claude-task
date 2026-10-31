import { expect, test } from '@playwright/test';
import { HEADERS, createProject, createTask, login } from './helpers';

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('lists every file of the Task under its description', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Task attachments');
  const task = await createTask(page.request, project, 'Has files');

  // A description file, and a file on a Comment by a User.
  const description = await page.request.post(`/api/v1/tasks/${task.id}/attachments`, {
    multipart: { files: { name: 'spec.txt', mimeType: 'text/plain', buffer: Buffer.from('the spec') } },
    headers: HEADERS,
  });
  expect(description.status()).toBe(201);
  const comment = await page.request.post(`/api/v1/tasks/${task.id}/comments`, {
    multipart: {
      body: 'see the shot',
      internal: 'false',
      files: { name: 'shot.png', mimeType: 'image/png', buffer: PNG },
    },
    headers: HEADERS,
  });
  expect(comment.status()).toBe(201);

  await page.goto(`/t/${task.key}`);
  const list = page.getByRole('region', { name: 'Attachments' });
  await expect(list).toContainText('Attachments');
  await expect(list.getByRole('link', { name: /shot\.png/ })).toBeVisible();
  await expect(list.getByRole('link', { name: /spec\.txt/ })).toBeVisible();
  // Who posted each one, or that it belongs to the description.
  await expect(list).toContainText('Ada Admin');
  await expect(list).toContainText('Description');

  // The image opens inline, other files download.
  await expect(list.getByRole('link', { name: /shot\.png/ })).toHaveAttribute('href', /\/api\/v1\/attachments\/.+/);
  await expect(list.getByRole('link', { name: /spec\.txt/ })).toHaveAttribute('href', /\?download=1$/);
});

test('shows a description file uploaded from another page without reloading', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request, 'Live attachments');
  const task = await createTask(page.request, project, 'Files arrive');
  await page.goto(`/t/${task.key}`);
  await expect(page.getByRole('region', { name: 'Attachments' })).toHaveCount(0);

  const peer = await page.context().newPage();
  try {
    const res = await peer.request.post(`/api/v1/tasks/${task.id}/attachments`, {
      multipart: { files: { name: 'late.txt', mimeType: 'text/plain', buffer: Buffer.from('late') } },
      headers: HEADERS,
    });
    expect(res.status()).toBe(201);
    await expect(page.getByRole('region', { name: 'Attachments' })).toContainText('late.txt');
  } finally {
    await peer.close();
  }
});
