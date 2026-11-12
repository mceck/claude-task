import { expect, test } from '@playwright/test';
import { Stream } from '../../backend/test/helpers/stream';
import { createProject, createTask, login, replay, seedAgent, startJob } from './helpers';

// The Btw answer comes from a fork the fake Runner of this suite cannot play (the backend tests cover it), so
// this drives what the web client can: the System hints, the refusals, a Btw that waits for its fork and a Clear
// that waits for the running Job.

test('/clear on a Task without a Session says why and keeps the draft', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Nothing to clear');
  await page.goto(`/t/${task.key}`);

  const composer = page.getByRole('textbox', { name: 'Comment', exact: true });
  await composer.fill('/clear');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('[data-sonner-toast]')).toContainText(/no conversation to clear/);
  await expect(composer).toHaveText('/clear');
});

test('offers /btw and /clear as System hints and keeps Comment mode', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Hints');
  await page.goto(`/t/${task.key}`);

  const composer = page.getByRole('textbox', { name: 'Comment', exact: true });
  await composer.click();
  await composer.pressSequentially('/');
  const list = page.getByRole('listbox', { name: 'Chat commands' });
  await expect(list.getByRole('option', { name: /\/btw/ })).toContainText('System');
  await expect(list.getByRole('option', { name: /\/clear/ })).toContainText('System');
  await list.getByRole('option', { name: /\/btw/ }).click();
  await expect(composer).toHaveText('/btw');
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();

  // Internal chat shows no hints.
  await page.getByLabel('Internal chat').click();
  await composer.fill('');
  await composer.pressSequentially('/');
  await expect(list).toBeHidden();
});

test('a Btw shows as a Btw with its reply chip, and a Clear waits for the running Job', async ({ page }) => {
  await login(page.request);
  const project = await createProject(page.request);
  const task = await createTask(page.request, project, 'Side questions');
  const agent = await seedAgent(page.request);
  const { jobId, sessionId } = await startJob(page.request, agent.id, task.id, project.workerId);
  // The Session's conversation exists once `claude` has reported it: a Btw forks from it.
  const s = new Stream(sessionId);
  await replay(page.request, project.workerId, jobId, [s.init(), s.text('Working on it.')]);
  await page.goto(`/t/${task.key}`);

  const composer = page.getByRole('textbox', { name: 'Comment', exact: true });
  await composer.fill('/btw what is the plan?');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const btw = page.getByRole('listitem', { name: 'Btw' });
  await expect(btw).toContainText('what is the plan?');
  await expect(btw).toContainText('Btw');
  await expect(btw).toContainText('Thinking…');
  await expect(btw.getByText('Internal chat')).toHaveCount(0);
  await expect(composer).toHaveText('');

  await btw.getByRole('button', { name: 'Reply to btw' }).click();
  await expect(page.getByText('Replying to btw:')).toContainText('what is the plan?');
  await page.getByRole('button', { name: 'Stop replying to btw' }).click();
  await expect(page.getByText('Replying to btw:')).toHaveCount(0);

  await composer.fill('/clear');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByText('Clear pending: the chat will clear when the Agent finishes')).toBeVisible();
  await expect(page.getByLabel(/Session: .*clear pending/)).toContainText('Clear pending');
});
