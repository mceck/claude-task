import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const ADMIN = { email: 'admin@example.com', password: 'admin-password' };
const H = { 'x-claude-task': '1' };

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

export interface SeededProject {
  id: string;
  key: string;
  statuses: { id: string; name: string }[];
}

export async function createProject(request: APIRequestContext, name = 'E2E project'): Promise<SeededProject> {
  const res = await request.post('/api/v1/projects', { data: { key: uniqueKey(), name }, headers: H });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { id: body.project.id, key: body.project.key, statuses: body.statuses };
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
