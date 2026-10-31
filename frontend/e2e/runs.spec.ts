import { expect, test } from '@playwright/test';
import { Stream } from '../../backend/test/helpers/stream';
import { createProject, createTask, login, replay, seedAgent, startJob } from './helpers';

/** The live Run of a Subagent Run and then of its transcript. */
test('shows a Subagent Run in the bar with its live transcript in the dialog', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Runs agent');
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Delegated work');
  const { jobId, sessionId } = await startJob(page.request, agent.id, task.id);
  const s = new Stream(sessionId);
  await replay(page.request, agent.id, jobId, [
    s.init(),
    s.text('Starting.'),
    s.toolUse('toolu_run', 'Agent', { description: 'Explore the repo', subagent_type: 'Explore', prompt: 'Look around' }),
    s.text('Looking at the files', 'toolu_run'),
    s.toolUse('toolu_read', 'Read', { file_path: 'src/a.ts' }, 'toolu_run'),
  ]);

  await page.goto(`/t/${task.key}`);
  const bar = page.getByLabel('Active runs');
  const chip = bar.getByRole('button', { name: /Explore the repo/ });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAccessibleName(/Explore the repo running/);
  await chip.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Explore the repo', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Explore');
  await expect(dialog).toContainText('1 tool call');
  await expect(dialog.getByLabel('Run transcript')).toContainText('Looking at the files');
  await expect(dialog.getByLabel('Run transcript')).toContainText('src/a.ts');

  // The prompt is there, folded.
  await dialog.getByRole('button', { name: 'Prompt', exact: true }).click();
  await expect(dialog).toContainText('Look around');

  // A message landing while the dialog is open shows up live.
  await replay(page.request, agent.id, jobId, [s.text('Found the entry point', 'toolu_run')]);
  await expect(dialog.getByLabel('Run transcript')).toContainText('Found the entry point');

  // Once the subagent hands back, its chip leaves the bar and its Timeline trace stays.
  await replay(page.request, agent.id, jobId, [s.toolResult('toolu_read', 'export const a = 1;', { parent: 'toolu_run' }), s.toolResult('toolu_run', 'Done')]);
  await expect(dialog).toContainText('finished');
  await expect(chip).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  const trace = page.getByRole('list', { name: 'Timeline' }).getByRole('button', { name: /Explore the repo/ });
  await expect(trace).toContainText('finished');
  await trace.click();
  await expect(page.getByRole('dialog').getByLabel('Run transcript')).toContainText('Found the entry point');
});

/** A failed Run stays until the reader closes it. */
test('keeps a failed Background Command in the bar until the reader dismisses it', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Command agent');
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Install');
  const { jobId, sessionId } = await startJob(page.request, agent.id, task.id);
  const s = new Stream(sessionId);
  await replay(page.request, agent.id, jobId, [s.init(), s.taskStarted({ taskId: 'bg1', taskType: 'local_bash', description: 'npm ci', backgrounded: true })]);

  await page.goto(`/t/${task.key}`);
  const bar = page.getByLabel('Active runs');
  await expect(bar.getByRole('button', { name: /^npm ci/ })).toHaveAccessibleName(/npm ci running/);

  await replay(page.request, agent.id, jobId, [s.taskNotification({ taskId: 'bg1', status: 'failed', summary: 'npm ci failed: lockfile is missing' })]);
  const failed = bar.getByRole('button', { name: /^npm ci/ });
  await expect(failed).toHaveAccessibleName(/npm ci failed/);

  // The dialog says why it failed, in full.
  await failed.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'npm ci', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Background command');
  await expect(dialog).toContainText('npm ci failed: lockfile is missing');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await bar.getByRole('button', { name: 'Dismiss npm ci', exact: true }).click();
  await expect(bar.getByRole('button', { name: /^npm ci/ })).toBeHidden();

  // Its error stays on its Timeline trace.
  const trace = page.getByRole('list', { name: 'Timeline' }).getByRole('button', { name: /npm ci/ });
  await expect(trace).toContainText('failed');
  await expect(trace).toContainText('lockfile is missing');
});

/** The bar keeps running Runs before failures waiting to be read, whatever order events arrived in. */
test('lists a running Run before an older failed one and opens it without a dialog warning', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Order agent');
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Ordered runs');
  const { jobId, sessionId } = await startJob(page.request, agent.id, task.id);
  const s = new Stream(sessionId);
  await replay(page.request, agent.id, jobId, [
    s.init(),
    s.toolUse('run_old', 'Agent', { description: 'First run', subagent_type: 'Explore', prompt: 'One' }),
    s.toolUse('run_new', 'Agent', { description: 'Second run', subagent_type: 'Explore', prompt: 'Two' }),
  ]);

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/t/${task.key}`);
  const bar = page.getByLabel('Active runs');
  await expect(bar.getByRole('button')).toHaveCount(2);

  // While the page is open the older Run fails: the newer running one must move to the front.
  await replay(page.request, agent.id, jobId, [s.toolResult('run_old', 'boom', { isError: true })]);
  await expect(bar.getByRole('button').first()).toContainText('Second run');
  await bar.getByRole('button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(errors.filter((text) => text.includes('Description'))).toEqual([]);
});
