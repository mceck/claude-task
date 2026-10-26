import { expect, test } from '@playwright/test';
import { createProject, createTask, login } from './helpers';

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
