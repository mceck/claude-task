import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { Stream } from '../../backend/test/helpers/stream';
import { HEADERS, login, replay, seedAgent, waitForStart } from './helpers';

const H = HEADERS;

async function createSchedule(request: APIRequestContext, agentId: string, name: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/schedules', {
    headers: H,
    data: { name, agentId, cron: '0 9 * * *', timeZone: 'UTC', prompt: 'Do the thing.', ...extra },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).schedule as { id: string; name: string };
}

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

test('does not show a run page for a Task of another Schedule', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Foreign run agent');
  const mine = await createSchedule(page.request, agent.id, `Schedule A ${Date.now()}`);
  const other = await createSchedule(page.request, agent.id, `Schedule B ${Date.now()}`);
  const run = (await (await page.request.post(`/api/v1/schedules/${other.id}/run`, { headers: H })).json()).run;

  await page.goto(`/schedules/${mine.id}/runs/${run.taskKey}`);
  await expect(page.getByText('Run not found.')).toBeVisible();
  await expect(page.getByLabel('Task conversation')).toHaveCount(0);
});

test('a finished run is read-only', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Closed run agent');
  const schedule = await createSchedule(page.request, agent.id, `Finished ${Date.now()}`);
  const run = (await (await page.request.post(`/api/v1/schedules/${schedule.id}/run`, { headers: H })).json()).run;
  const { jobId, sessionId } = await waitForStart(page.request, agent.id, run.taskId);
  const s = new Stream(sessionId);
  await replay(page.request, agent.id, jobId, [s.init(), s.text('Done.'), s.result()], true);
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/schedules/${schedule.id}/runs`)).json()).runs[0].state)
    .toBe('succeeded');

  await page.goto(`/schedules/${schedule.id}/runs/${run.taskKey}`);
  await expect(page.getByLabel('Task conversation')).toBeVisible();
  await expect(page.getByText('This run is closed')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveCount(0);
});

test('the schedule dialog stays inside a short viewport', async ({ page }) => {
  await login(page.request);
  await seedAgent(page.request, 'Dialog agent');
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(600);

  const submit = page.getByRole('button', { name: 'Create schedule' });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
});

test('editing the Base Branch keeps the Repository when the repository list is unavailable', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Tied agent');
  const { connection } = await (
    await page.request.post('/api/v1/git/connections', {
      headers: H,
      data: { provider: 'gitlab', name: `Tied git ${Date.now()}`, baseUrl: 'https://gitlab.example.com', token: 'glpat-e2e-token-1234' },
    })
  ).json();
  const schedule = await createSchedule(page.request, agent.id, `Tied ${Date.now()}`, {
    repository: { connectionId: connection.id, providerRepoId: '101', baseBranch: 'main' },
  });
  // A second branch exists on the provider, so the edited Base Branch is valid.
  expect(
    (await page.request.post('/api/v1/__test/git/branches', { headers: H, data: { provider: 'gitlab', repoId: '101', branch: 'release' } })).ok(),
  ).toBe(true);
  // The connection's repository listing is unavailable, so the picker cannot resolve the chosen Repository.
  await page.route('**/api/v1/git/repositories', (route) => route.fulfill({ json: { groups: [] } }));

  await page.goto(`/schedules/${schedule.id}`);
  await page.getByRole('button', { name: 'Edit schedule' }).click();
  await page.getByLabel('Base branch').fill('release');
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  const saved = (await (await page.request.get(`/api/v1/schedules/${schedule.id}`)).json()).schedule;
  expect(saved.repository).toMatchObject({ connectionId: connection.id, providerRepoId: '101', baseBranch: 'release' });
});

test('a long name does not push the Enabled switch out of view', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Long name agent');
  await createSchedule(page.request, agent.id, `A schedule with a long name ${'that keeps going '.repeat(4)}`);
  await page.setViewportSize({ width: 1600, height: 1000 });

  await page.goto('/schedules');
  const container = page.locator('[data-slot="table-container"]');
  expect(await container.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('switch').first()).toBeInViewport();
});

test('a failed enabled toggle reports the error instead of failing silently', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Toggle agent');
  const schedule = await createSchedule(page.request, agent.id, `Toggle ${Date.now()}`);
  await page.route('**/api/v1/schedules/*', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'Internal server error' } } })
      : route.continue(),
  );

  await page.goto('/schedules');
  await page.getByRole('switch', { name: `Enable ${schedule.name}` }).click();
  await expect(page.getByText('Couldn’t update the schedule')).toBeVisible();
});

test('double-clicking Run now starts one run', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Run now agent');
  const schedule = await createSchedule(page.request, agent.id, `Run now ${Date.now()}`);
  let posts = 0;
  await page.route('**/api/v1/schedules/*/run', async (route) => {
    posts++;
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });

  await page.goto(`/schedules/${schedule.id}`);
  await page.getByRole('button', { name: 'Run now' }).dblclick();
  await expect
    .poll(async () => ((await (await page.request.get(`/api/v1/schedules/${schedule.id}/runs`)).json()).runs as unknown[]).length)
    .toBe(1);
  expect(posts).toBe(1);
});

test('a Schedule whose Agent is disabled can still be edited', async ({ page }) => {
  await login(page.request);
  const agent = await seedAgent(page.request, 'Disabled agent');
  const schedule = await createSchedule(page.request, agent.id, `Disabled ${Date.now()}`, { prompt: 'Original prompt.' });
  expect((await page.request.patch(`/api/v1/agents/${agent.id}`, { headers: H, data: { enabled: false } })).ok()).toBe(true);

  await page.goto(`/schedules/${schedule.id}`);
  await page.getByRole('button', { name: 'Edit schedule' }).click();
  await page.getByLabel('Prompt').fill('Updated prompt.');
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('Updated prompt.')).toBeVisible();
});
