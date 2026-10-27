import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { login } from './helpers';

test('groups agent skills by source, selects hidden skills in bulk and persists assignments', async ({ page }, testInfo) => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres');
  databaseUrl.pathname = '/claude_task_e2e';
  const db = new pg.Client({ connectionString: databaseUrl.toString() });
  const entries = [
    { id: randomUUID(), name: 'review-ui', description: 'Review interfaces for accessibility and consistency.', source: 'acme/frontend' },
    { id: randomUUID(), name: 'design-system', description: 'Build polished components with shared design tokens.', source: 'acme/frontend' },
    { id: randomUUID(), name: 'review-api', description: 'Review API contracts and error handling.', source: 'acme/quality' },
    { id: randomUUID(), name: 'test-strategy', description: 'Choose focused tests for critical user journeys.', source: 'acme/quality' },
  ];
  await db.connect();
  try {
    for (const entry of entries) {
      await db.query(
        'insert into skills (id, name, description, source, files, content_hash) values ($1, $2, $3, $4, $5, $6)',
        [entry.id, entry.name, entry.description, entry.source, JSON.stringify([{
          path: 'SKILL.md', content: Buffer.from(entry.description).toString('base64'), executable: false,
        }]), entry.id],
      );
    }
  } finally {
    await db.end();
  }

  await login(page.request);
  const headers = { 'x-claude-task': '1' };
  const credentialResponse = await page.request.post('/api/v1/credentials', {
    headers, data: { name: 'Skill assignment credential', kind: 'anthropic_api_key', secret: 'test-secret-1234' },
  });
  expect(credentialResponse.status()).toBe(201);
  const { credential } = await credentialResponse.json();
  const agentResponse = await page.request.post('/api/v1/agents', {
    headers,
    data: { name: 'Design teammate', credentialId: credential.id, skillIds: [entries[0]!.id], dockerfile: 'FROM claude-task/agent-base\nUSER agent\n' },
  });
  expect(agentResponse.status()).toBe(201);
  const { agent } = await agentResponse.json();
  await page.goto(`/agents/${agent.id}`);
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();

  const selector = page.getByRole('region', { name: 'Skills', exact: true });
  const all = selector.getByRole('checkbox', { name: 'Select all skills', exact: true });
  const frontend = selector.getByRole('checkbox', { name: 'Select all skills from acme/frontend', exact: true });
  const quality = selector.getByRole('checkbox', { name: 'Select all skills from acme/quality', exact: true });
  const search = selector.getByRole('textbox', { name: 'Search skills' });
  await expect(all).toBeChecked({ indeterminate: true });
  await expect(frontend).toBeChecked({ indeterminate: true });
  await expect(quality).not.toBeChecked();
  await expect(selector.getByRole('status')).toHaveText('1 selected');

  await frontend.check();
  await selector.getByRole('checkbox', { name: 'design-system', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(frontend).toBeChecked({ indeterminate: true });
  await quality.check();
  await frontend.check();
  await frontend.uncheck();
  await expect(quality).toBeChecked();
  await expect(selector.getByRole('status')).toHaveText('2 selected');

  await search.fill('review');
  await expect(selector.getByRole('checkbox', { name: 'design-system', exact: true })).toHaveCount(0);
  await frontend.check();
  await expect(frontend).toBeChecked();
  await expect(all).toBeChecked();
  await quality.uncheck();
  await expect(selector.getByRole('status')).toHaveText('2 selected');
  await all.check();
  await expect(selector.getByRole('status')).toHaveText('4 selected');
  await all.uncheck();
  await expect(selector.getByRole('status')).toHaveText('0 selected');
  await frontend.check();

  // Searching never submits the surrounding agent form or changes the selection.
  await search.fill('no-such-skill');
  await search.press('Enter');
  await expect(selector.getByText('No matching skills', { exact: true })).toBeVisible();
  await expect(selector.getByRole('status')).toHaveText('2 selected');
  await selector.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(selector.getByRole('checkbox', { name: 'design-system', exact: true })).toBeChecked();
  await selector.getByRole('button', { name: 'Collapse acme/frontend' }).click();
  await expect(selector.getByRole('checkbox', { name: 'review-ui', exact: true })).toBeHidden();
  await selector.getByRole('button', { name: 'Expand acme/frontend' }).click();

  await expect(page.getByRole('status', { name: 'Agent configuration save status' })).toHaveText('All changes saved');
  const saved = await (await page.request.get(`/api/v1/agents/${agent.id}`)).json();
  expect(saved.agent.skillIds.sort()).toEqual([entries[0]!.id, entries[1]!.id].sort());
  await page.reload();
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(frontend).toBeChecked();
  await expect(quality).not.toBeChecked();

  await selector.scrollIntoViewIfNeeded();
  await selector.screenshot({ path: testInfo.outputPath('skill-selector-dark.png'), animations: 'disabled' });
  await page.getByRole('button', { name: /Ada Admin admin@example.com/ }).click();
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click();
  await selector.screenshot({ path: testInfo.outputPath('skill-selector-light.png'), animations: 'disabled' });

  await page.goto('/agents');
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const newSelector = page.getByRole('dialog').getByRole('region', { name: 'Skills', exact: true });
  await expect(newSelector.getByRole('status')).toHaveText('0 selected');
  await newSelector.getByRole('checkbox', { name: 'Select all skills', exact: true }).check();
  await expect(newSelector.getByRole('status')).toHaveText('4 selected');
  await newSelector.screenshot({ path: testInfo.outputPath('skill-selector-mobile.png'), animations: 'disabled' });
  expect(await newSelector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
