import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createProject, createTask, loggedInContext } from './helpers';

const headers = { 'x-claude-task': '1' };

async function seedAgent(request: APIRequestContext) {
  const name = `Question agent ${Date.now()}`;
  const { credential } = await (await request.post('/api/v1/credentials', { headers, data: { name: `Key ${Date.now()}`, kind: 'anthropic_api_key', secret: 'test-secret-1234' } })).json();
  const res = await request.post('/api/v1/agents', { headers, data: { name, credentialId: credential.id, dockerfile: 'FROM claude-task/agent-base\nUSER agent\n' } });
  expect(res.status()).toBe(201);
  const { agent } = await res.json();
  await expect.poll(async () => (await (await request.get(`/api/v1/agents/${agent.id}`)).json()).agent.state).toBe('idle');
  return agent as { id: string; name: string };
}

/** Assigns the Agent, starts it with a Comment, and returns the Job's Task Tools bearer token. */
async function startAgent(request: APIRequestContext, taskId: string, agentId: string): Promise<string> {
  const { task } = await (await request.get(`/api/v1/tasks/${taskId}`)).json();
  expect((await request.patch(`/api/v1/tasks/${taskId}`, { headers, data: { version: task.version, agentId } })).ok()).toBe(true);
  expect((await request.post(`/api/v1/tasks/${taskId}/comments`, { headers, data: { body: 'Please get started.' } })).ok()).toBe(true);
  let token = '';
  await expect
    .poll(async () => {
      const { received } = await (await request.get(`/api/v1/__test/runners/${agentId}`)).json();
      const start = received.find((m: { type: string }) => m.type === 'job.start');
      token = start ? JSON.parse(start.claudeArgs.mcpConfig).mcpServers['claude-task'].headers.Authorization : '';
      return token;
    })
    .not.toBe('');
  return token;
}

/** Calls a Task Tool the way `claude` does: JSON-RPC over Streamable HTTP with the Job token. */
async function callTool(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post('/api/v1/mcp', {
    headers: { authorization: token, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.result.isError ?? false, body.result.content[0].text).toBe(false);
  return JSON.parse(body.result.content[0].text);
}

const DB_ITEM = {
  header: 'Database',
  question: 'Which database should we use?',
  options: [
    { label: 'Postgres', description: 'Already in production' },
    { label: 'MySQL', description: 'The team knows it' },
  ],
};

test('a Question answered in one browser shows as answered in the other', async ({ browser }) => {
  const a = await loggedInContext(browser);
  const b = await loggedInContext(browser);
  const project = await createProject(a.request);
  const task = await createTask(a.request, project, 'Pick a database');
  const agent = await seedAgent(a.request);
  const token = await startAgent(a.request, task.id, agent.id);

  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await pageA.goto(`/t/${task.key}`);
  await pageB.goto(`/t/${task.key}`);
  await callTool(a.request, token, 'ask_question', { questions: [DB_ITEM] });

  const questionA = pageA.getByRole('region', { name: 'Question' });
  await expect(questionA).toContainText('Which database should we use?');
  await expect(pageB.getByRole('region', { name: 'Question' })).toContainText('Already in production');
  const send = questionA.getByRole('button', { name: 'Send answer' });
  await expect(send).toBeDisabled();
  await questionA.getByRole('radio', { name: /Other/ }).click();
  await questionA.getByRole('textbox', { name: 'Other answer for Database' }).fill('SQLite for now');
  await send.click();

  await expect(questionA).toContainText('Answered by');
  await expect(pageB.getByRole('region', { name: 'Question' })).toContainText('“SQLite for now”');
  await expect(pageB.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
  await expect(pageB.getByRole('button', { name: 'Answered the question' })).toBeVisible();
});

test('a Survey collects answers and Send now delivers the results', async ({ browser }) => {
  const a = await loggedInContext(browser);
  const project = await createProject(a.request);
  const me = (await (await a.request.get('/api/v1/auth/me')).json()).user;
  const created = await a.request.post('/api/v1/users', { headers, data: { email: `luca-${Date.now()}@example.com`, displayName: 'Luca', role: 'member' } });
  const luca = (await created.json()).user;
  const task = await createTask(a.request, project, 'Team vote', 'Todo', { assigneeIds: [me.id, luca.id] });
  const agent = await seedAgent(a.request);
  const token = await startAgent(a.request, task.id, agent.id);

  const page = await a.newPage();
  await page.goto(`/t/${task.key}`);
  await callTool(a.request, token, 'create_survey', { questions: [DB_ITEM] });

  const survey = page.getByRole('region', { name: 'Survey' });
  await expect(survey).toContainText('0/2 expected answered');
  await survey.getByRole('radio', { name: /Postgres/ }).click();
  await survey.getByRole('button', { name: 'Save answer' }).click();
  await expect(survey).toContainText('1/2 expected answered');
  await expect(survey).toContainText('waiting for Luca');
  await survey.getByRole('button', { name: 'Send now' }).click();
  await expect(survey).toContainText('Sent early by');
  await expect(page.getByLabel('System comment').filter({ hasText: 'closed the survey early' })).toBeVisible();
});
