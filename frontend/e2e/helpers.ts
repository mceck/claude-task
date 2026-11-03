import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const ADMIN = { email: 'admin@example.com', password: 'admin-password' };
/** The header the API requires on every write, so a browser form can't send one. */
export const HEADERS = { 'x-claude-task': '1' };
const H = HEADERS;

/** A random project key, e.g. "EQZK"; the database is fresh for every run. */
export function uniqueKey(): string {
  return `E${Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`;
}

/** Logs the context in through the API; the cookie is shared with its pages. */
export async function login(request: APIRequestContext, email = ADMIN.email, password = ADMIN.password) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password }, headers: H });
  expect(res.status()).toBe(200);
}

export async function loggedInContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await login(context.request);
  return context;
}

export const DOCKERFILE = 'FROM claude-task/agent-base\nUSER agent\n';

export interface SeededWorker {
  id: string;
  name: string;
}

/**
 * A Worker with one always-on Worker Container, so its fake Runner connects (the e2e server keys it by Worker id).
 * `wait` polls until its image is built and its Runner is connected.
 */
export async function seedWorker(request: APIRequestContext, name = 'E2E worker', { wait = false } = {}): Promise<SeededWorker> {
  const res = await request.post('/api/v1/workers', {
    data: { name: `${name} ${Date.now()} ${Math.random().toString(36).slice(2, 6)}`, dockerfile: DOCKERFILE, minimum: 1, cap: 1 },
    headers: H,
  });
  expect(res.status()).toBe(201);
  const { worker } = await res.json();
  if (wait) await expect.poll(async () => (await (await request.get(`/api/v1/workers/${worker.id}`)).json()).worker.state).toBe('idle');
  return { id: worker.id, name: worker.name };
}

export interface SeededProject {
  id: string;
  key: string;
  /** The Worker it runs on: the id the fake Runner helpers take. */
  workerId: string;
  statuses: { id: string; name: string }[];
}

/** A Project on its own new Worker, unless one is given. */
export async function createProject(request: APIRequestContext, name = 'E2E project', workerId?: string): Promise<SeededProject> {
  const worker = workerId ?? (await seedWorker(request)).id;
  const res = await request.post('/api/v1/projects', { data: { key: uniqueKey(), name, workerId: worker }, headers: H });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { id: body.project.id, key: body.project.key, workerId: worker, statuses: body.statuses };
}

export async function createTask(
  request: APIRequestContext,
  project: SeededProject,
  title: string,
  status = 'Todo',
  extra: Record<string, unknown> = {},
): Promise<{ id: string; key: string }> {
  const statusId = project.statuses.find((s) => s.name === status)!.id;
  const res = await request.post(`/api/v1/projects/${project.id}/tasks`, { data: { title, statusId, ...extra }, headers: H });
  expect(res.status()).toBe(201);
  return (await res.json()).task;
}

export interface SeededAgent {
  id: string;
  name: string;
  credentialName: string;
}

/** A Credential and an enabled Agent. */
export async function seedAgent(request: APIRequestContext, name = 'Test agent'): Promise<SeededAgent> {
  const res = await request.post('/api/v1/credentials', {
    data: { name: `Key ${Date.now()}`, kind: 'anthropic_api_key', secret: 'test-secret-1234' },
    headers: H,
  });
  expect(res.status()).toBe(201);
  const { credential } = await res.json();
  const result = await request.post('/api/v1/agents', {
    data: { name: `${name} ${Date.now()}`, credentialId: credential.id },
    headers: H,
  });
  expect(result.status()).toBe(201);
  const { agent } = await result.json();
  return agent as SeededAgent;
}

/** The messages the fake Runner of a Worker's slot 1 received from the backend. */
export async function runnerMessages(request: APIRequestContext, workerId: string): Promise<Record<string, unknown>[]> {
  return (await (await request.get(`/api/v1/__test/runners/${workerId}`)).json()).received;
}

export interface StartedJob {
  jobId: string;
  sessionId: string;
  /** The `job.start` the Runner received, `claudeArgs` included. */
  start: Record<string, unknown>;
}

/** Waits for the Runner to receive the Task's `job.start`. */
export async function waitForStart(request: APIRequestContext, workerId: string, taskId: string): Promise<StartedJob> {
  let start: Record<string, unknown> | undefined;
  await expect
    .poll(async () => {
      const { jobs } = await (await request.get(`/api/v1/workers/${workerId}/jobs`)).json();
      const job = jobs.find((j: { task: { id: string } }) => j.task.id === taskId);
      start = (await runnerMessages(request, workerId)).find((m) => m.type === 'job.start' && m.jobId === job?.id);
      return !!start;
    })
    .toBe(true);
  return { jobId: start!.jobId as string, sessionId: start!.sessionId as string, start: start! };
}

/** Assigns the Agent and sends the first User Comment, which starts the first Job on the Project's Worker. */
export async function startJob(request: APIRequestContext, agentId: string, taskId: string, workerId: string): Promise<StartedJob> {
  const { task } = await (await request.get(`/api/v1/tasks/${taskId}`)).json();
  expect((await request.patch(`/api/v1/tasks/${taskId}`, { data: { version: task.version, agentId }, headers: H })).ok()).toBe(true);
  expect((await request.post(`/api/v1/tasks/${taskId}/comments`, { data: { body: 'Please get started.' }, headers: H })).ok()).toBe(true);
  return waitForStart(request, workerId, taskId);
}

/** Replays stream-json events as the Worker's fake Runner; `exit: false` keeps the Job alive. */
export async function replay(request: APIRequestContext, workerId: string, jobId: string, events: Record<string, unknown>[], exit = false) {
  expect((await request.post(`/api/v1/__test/runners/${workerId}`, { data: { jobId, events, exit }, headers: H })).ok()).toBe(true);
}

export const column = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

export async function cardTitles(page: Page, status: string): Promise<string[]> {
  return column(page, status).locator('article p').allTextContents();
}

/** Drags with real pointer events, in small steps so dnd-kit's sensors pick it up. */
export async function drag(page: Page, source: Locator, target: Locator, position: 'top' | 'center' | 'bottom' = 'center') {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  const y = position === 'top' ? to.y + 4 : position === 'bottom' ? to.y + to.height - 4 : to.y + to.height / 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, y, { steps: 20 });
  await page.waitForTimeout(100);
  await page.mouse.up();
}
