import { DEFAULT_AGENT_DOCKERFILE } from '@claude-task/shared';
import type { Agent, Comment, Credential, Tag, Priority, ProjectBundle, Role, Status, Task, TaskSession, TimelineItem, User, Worker } from '@claude-task/shared';
import { expect } from 'vitest';
import type { ApiClient } from './client';
import { TEST_WORKER } from './app';
import type { TestApp } from './app';
import { FakeRunner } from './runner';
import type { RunnerTarget } from './runner';

let seq = 0;
const unique = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Creates a user through the admin API, logs them in and clears the forced
 * password change, returning a ready-to-use client.
 */
export async function createUser(
  app: TestApp,
  admin: ApiClient,
  opts: { role?: Role; displayName?: string; email?: string; password?: string } = {},
): Promise<{ user: User; client: ApiClient; password: string }> {
  const email = opts.email ?? `user-${unique()}@example.com`;
  const created = await admin.post('/users', {
    email,
    displayName: opts.displayName ?? `User ${seq}`,
    role: opts.role ?? 'member',
  });
  expect(created.status).toBe(201);
  const client = app.client();
  await client.login(email, created.body.temporaryPassword);
  const password = opts.password ?? 'a-real-password';
  const changed = await client.post('/auth/password', {
    currentPassword: created.body.temporaryPassword,
    newPassword: password,
  });
  expect(changed.status).toBe(200);
  return { user: changed.body.user, client, password };
}

let keySeq = 0;
/** Unique 2–6 letter keys. */
export function projectKey(): string {
  let n = keySeq++;
  let key = '';
  do {
    key = String.fromCharCode(65 + (n % 26)) + key;
    n = Math.floor(n / 26);
  } while (n > 0);
  return `P${key.padStart(2, 'A')}`;
}

/** The Worker new Projects run on unless told otherwise: the test's default one. */
export async function defaultWorkerId(client: ApiClient): Promise<string> {
  const workers = (await client.get('/workers')).body.workers as Worker[];
  const worker = workers.find((w) => w.name === TEST_WORKER) ?? workers[0];
  if (!worker) throw new Error('no worker to create the project on');
  return worker.id;
}

export async function createProject(
  client: ApiClient,
  body: { key?: string; name?: string; description?: string; workerId?: string } = {},
): Promise<ProjectBundle> {
  const res = await client.post('/projects', { key: projectKey(), name: 'Project', workerId: body.workerId ?? (await defaultWorkerId(client)), ...body });
  expect(res.status).toBe(201);
  return res.body;
}

export function statusByName(bundle: { statuses: Status[] }, name: string): Status {
  const s = bundle.statuses.find((x) => x.name === name);
  if (!s) throw new Error(`no status ${name}`);
  return s;
}

export async function createTask(
  client: ApiClient,
  projectId: string,
  body: {
    title?: string;
    statusId?: string;
    description?: string;
    priority?: Priority;
    tagIds?: string[];
    assigneeIds?: string[];
  } = {},
): Promise<Task> {
  const res = await client.post(`/projects/${projectId}/tasks`, { title: 'A task', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.task;
}

export async function createTag(client: ApiClient, projectId: string, name: string, color = '#ff0000'): Promise<Tag> {
  const res = await client.post(`/projects/${projectId}/tags`, { name, color });
  expect(res.status).toBe(201);
  return res.body.tag;
}

/** Board order of task titles in a status. */
export async function columnTitles(client: ApiClient, projectId: string, statusId: string): Promise<string[]> {
  const res = await client.get(`/projects/${projectId}/tasks?includeClosed=true`);
  return (res.body.tasks as Task[]).filter((t) => t.statusId === statusId).map((t) => t.title);
}

// Agents

export async function createCredential(
  admin: ApiClient,
  body: { name?: string; kind?: 'claude_oauth_token' | 'anthropic_api_key' | 'anthropic_auth_token' | 'clickup_token'; secret?: string } = {},
): Promise<Credential> {
  const res = await admin.post('/credentials', {
    name: body.name ?? `Credential ${unique()}`,
    kind: body.kind ?? 'claude_oauth_token',
    secret: body.secret ?? 'sk-ant-oat01-secret-value-1234',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.credential;
}

/** The fake Runner of a Worker Container, connected once and shared by the fixtures. */
export async function runnerOf(app: TestApp, to: RunnerTarget = app.workerId): Promise<FakeRunner> {
  const key = typeof to === 'string' ? `${to}:1` : `${to.workerId}:${to.slot ?? 1}`;
  const known = app.runners.get(key);
  if (known?.open) return known;
  const runner = await FakeRunner.connect(app, to);
  app.runners.set(key, runner);
  return runner;
}

/**
 * Creates an Agent and returns it with the fake Runner of the default Worker's slot 1, connected
 * so the Agent's Jobs dispatch there. Agents share that one Worker Container.
 */
export async function createAgent(
  app: TestApp,
  admin: ApiClient,
  opts: { name?: string; credentialId?: string; connect?: boolean; body?: Record<string, unknown>; slot?: number } = {},
): Promise<{ agent: Agent; runner: FakeRunner }> {
  const credentialId = opts.credentialId ?? (await createCredential(admin)).id;
  const res = await admin.post('/agents', {
    name: opts.name ?? `Agent ${unique()}`,
    credentialId,
    ...opts.body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await app.settle();
  const runner = opts.connect === false || !app.workerId ? (null as unknown as FakeRunner) : await runnerOf(app, { workerId: app.workerId, slot: opts.slot ?? 1 });
  const agent = (await admin.get(`/agents/${res.body.agent.id}`)).body.agent as Agent;
  return { agent, runner };
}

/** Creates a Worker and lets its (fake) image build; its slots up to the minimum start. */
export async function createWorker(app: TestApp, admin: ApiClient, body: Record<string, unknown> = {}): Promise<Worker> {
  const res = await admin.post('/workers', { name: `Worker ${unique()}`, dockerfile: DEFAULT_AGENT_DOCKERFILE, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await app.settle();
  return (await admin.get(`/workers/${res.body.worker.id}`)).body.worker as Worker;
}

/** Assigns (or with null unassigns) the Task's Agent. */
export async function assignAgent(client: ApiClient, taskId: string, agentId: string | null): Promise<Task> {
  const current = (await client.get(`/tasks/${taskId}`)).body.task as Task;
  const res = await client.patch(`/tasks/${taskId}`, { version: current.version, agentId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.task;
}

/** Assigns the Agent and posts the first User comment, which is what starts its Session. */
export async function assignAndStart(client: ApiClient, taskId: string, agentId: string, body = 'Please get started.'): Promise<Task> {
  const task = await assignAgent(client, taskId, agentId);
  const res = await client.post(`/tasks/${taskId}/comments`, { body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return task;
}

export async function moveToStatus(client: ApiClient, taskId: string, statusId: string): Promise<Task> {
  const res = await client.post(`/tasks/${taskId}/move`, { statusId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.task;
}

export async function comment(client: ApiClient, taskId: string, body: string, internal = false): Promise<Comment> {
  const res = await client.post(`/tasks/${taskId}/comments`, { body, internal });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.comment;
}

export async function getSession(client: ApiClient, taskId: string): Promise<TaskSession | null> {
  return (await client.get(`/tasks/${taskId}/session`)).body.session;
}

/** The Timeline oldest first. */
export async function timeline(client: ApiClient, taskId: string): Promise<TimelineItem[]> {
  const res = await client.get(`/tasks/${taskId}/timeline?limit=200`);
  return (res.body.items as TimelineItem[]).slice().reverse();
}
