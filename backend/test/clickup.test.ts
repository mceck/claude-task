import { deduceCategory, parseClickUpQuery } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import { FakeClickUp } from './helpers/fake-clickup';
import { createAgent, createCredential, createProject, createTask, createUser } from './helpers/fixtures';
import type { ApiClient } from './helpers/client';

const cu = new FakeClickUp();
const app = useTestApp({ clickup: cu.factory });

async function reset() {
  Object.assign(cu, new FakeClickUp(), { factory: cu.factory });
  cu.statuses = new FakeClickUp().statuses;
  cu.tasks = [];
  app.server.ctx.clickupSync.retryDelaysMs = [0, 0];
}

async function linkedProject(admin: ApiClient, query = '') {
  const credential = await createCredential(admin, { kind: 'clickup_token', secret: 'pk_clickup_token_1234' });
  const res = await admin.post('/projects', {
    key: 'CU',
    name: 'Mirrored',
    workerId: app.workerId,
    clickup: { credentialId: credential.id, teamId: 'T1', sourceType: 'list', sourceId: 'L1', query },
  });
  return { credential, res, bundle: res.body };
}

async function tasksOf(admin: ApiClient, projectId: string) {
  return (await admin.get(`/projects/${projectId}/tasks?includeClosed=true`)).body.tasks as any[];
}

describe('ClickUp query and categories', () => {
  it('accepts allowed filters and normalizes arrays', () => {
    expect(parseClickUpQuery('?statuses=open&tags[]=a&include_closed=true')).toEqual({
      ok: true,
      params: [['statuses[]', 'open'], ['tags[]', 'a'], ['include_closed', 'true']],
    });
    expect(parseClickUpQuery('page=2')).toMatchObject({ ok: false });
    expect(parseClickUpQuery('')).toEqual({ ok: true, params: [] });
  });

  it('deduces the Category from the ClickUp type and name', () => {
    expect(deduceCategory('closed', 'closed')).toBe('closed');
    expect(deduceCategory('custom', 'In Review')).toBe('review');
    expect(deduceCategory('custom', 'complete')).toBe('done');
    expect(deduceCategory('custom', 'in progress')).toBe('open');
    expect(deduceCategory('open', 'to do')).toBe('open');
  });
});

describe('ClickUp sync', () => {
  it('imports Statuses and Tasks when the Project is created', async () => {
    await reset();
    cu.task('a1', 'to do');
    cu.task('a2', 'in progress', { name: 'Second', description: 'Body' });
    const admin = await app.admin();
    const { res, credential } = await linkedProject(admin, 'assignees[]=5&include_closed=true');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.statuses.map((s: any) => [s.name, s.category])).toEqual([
      ['to do', 'open'], ['in progress', 'open'], ['in review', 'review'], ['complete', 'done'], ['closed', 'closed'],
    ]);
    expect(res.body.project.clickup).toMatchObject({ credentialId: credential.id, teamId: 'T1', sourceId: 'L1', lastError: null });
    expect(cu.tokens[0]).toBe('pk_clickup_token_1234');
    expect(cu.lastSource?.query).toEqual([['assignees[]', '5'], ['include_closed', 'true']]);
    const tasks = await tasksOf(admin, res.body.project.id);
    expect(tasks).toHaveLength(2);
    const second = tasks.find((t) => t.title === 'Second');
    expect(second.statusId).toBe(res.body.statuses[1].id);
    expect(second.clickup).toMatchObject({ linked: true, descriptionDetached: false, url: 'https://app.clickup.com/t/a2' });
    expect((await admin.get(`/tasks/${second.id}`)).body.task.description).toBe('Body');
  });

  it('creates nothing when ClickUp refuses', async () => {
    await reset();
    cu.failFetch = 'ClickUp answered 401';
    const admin = await app.admin();
    const { res } = await linkedProject(admin);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('401');
    expect((await admin.get('/projects')).body.projects).toHaveLength(0);
  });

  it('refuses an unsupported filter and a Claude Credential', async () => {
    await reset();
    const admin = await app.admin();
    const claude = await createCredential(admin);
    const body = { key: 'XX', name: 'X', workerId: app.workerId, clickup: { credentialId: claude.id, teamId: 'T1', sourceType: 'list', sourceId: 'L1', query: '' } };
    expect((await admin.post('/projects', body)).status).toBe(400);
    const token = await createCredential(admin, { kind: 'clickup_token' });
    expect((await admin.post('/projects', { ...body, clickup: { ...body.clickup, credentialId: token.id, query: 'page=3' } })).status).toBe(400);
  });

  it('applies ClickUp changes on Sync now: name, description, Status', async () => {
    await reset();
    const t = cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    t.name = 'Renamed';
    t.description = 'New text';
    t.status = cu.statuses.find((s) => s.name === 'in review')!;
    cu.task('a3', 'closed');
    expect((await admin.post(`/projects/${bundle.project.id}/clickup/sync`)).status).toBe(200);
    const tasks = await tasksOf(admin, bundle.project.id);
    const one = tasks.find((x) => x.clickup.url.endsWith('/a1'));
    expect(one).toMatchObject({ title: 'Renamed', statusId: bundle.statuses[2].id });
    expect((await admin.get(`/tasks/${one.id}`)).body.task.description).toBe('New text');
    expect(tasks).toHaveLength(2);
  });

  it('mirrors Status changes of ClickUp and renames', async () => {
    await reset();
    cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    cu.statuses[1] = { ...cu.statuses[1]!, name: 'doing', color: '#111111' };
    cu.statuses.push({ id: 's6', name: 'blocked', color: '#ff0000', type: 'custom', orderindex: 9 });
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    const statuses = (await admin.get(`/projects/${bundle.project.id}/statuses`)).body.statuses;
    expect(statuses.map((s: any) => s.name)).toEqual(['to do', 'doing', 'in review', 'complete', 'closed', 'blocked']);
    expect(statuses[1]).toMatchObject({ id: bundle.statuses[1].id, color: '#111111' });
  });

  it('pushes a local Status change to ClickUp', async () => {
    await reset();
    cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    const [task] = await tasksOf(admin, bundle.project.id);
    const res = await admin.post(`/tasks/${task.id}/move`, { statusId: bundle.statuses[2].id });
    expect(res.status).toBe(200);
    await app.server.ctx.clickupSync.settle();
    expect(cu.statusPushes).toEqual([{ taskId: 'a1', status: 'in review' }]);
    const after = (await admin.get(`/tasks/${task.id}`)).body.task;
    expect(after.clickup).toMatchObject({ pushPending: false, error: null });
    // The next pass keeps it.
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    expect((await admin.get(`/tasks/${task.id}`)).body.task.statusId).toBe(bundle.statuses[2].id);
  });

  it('lets ClickUp win a conflict, and realigns after a failed push', async () => {
    await reset();
    const t = cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    const [task] = await tasksOf(admin, bundle.project.id);
    cu.failSetStatus = true;
    await admin.post(`/tasks/${task.id}/move`, { statusId: bundle.statuses[1].id });
    await app.server.ctx.clickupSync.settle();
    const failed = (await admin.get(`/tasks/${task.id}`)).body.task;
    expect(failed.statusId).toBe(bundle.statuses[1].id);
    expect(failed.clickup).toMatchObject({ pushPending: false, error: 'ClickUp answered 500' });
    // ClickUp still says "to do": the pass moves the Task back and clears the error.
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    const back = (await admin.get(`/tasks/${task.id}`)).body.task;
    expect(back.statusId).toBe(bundle.statuses[0].id);
    expect(back.clickup.error).toBeNull();

    // Both sides change: ClickUp's Status wins.
    cu.failSetStatus = false;
    t.status = cu.statuses.find((s) => s.name === 'complete')!;
    await admin.post(`/tasks/${task.id}/move`, { statusId: bundle.statuses[1].id });
    await app.server.ctx.clickupSync.settle();
    t.status = cu.statuses.find((s) => s.name === 'closed')!;
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    expect((await admin.get(`/tasks/${task.id}`)).body.task.statusId).toBe(bundle.statuses[4].id);
  });

  it('retries a failed push on request', async () => {
    await reset();
    cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    const [task] = await tasksOf(admin, bundle.project.id);
    cu.failSetStatus = true;
    await admin.post(`/tasks/${task.id}/move`, { statusId: bundle.statuses[1].id });
    await app.server.ctx.clickupSync.settle();
    cu.failSetStatus = false;
    const res = await admin.post(`/tasks/${task.id}/clickup/retry`);
    expect(res.status).toBe(200);
    expect(res.body.task.clickup).toMatchObject({ pushPending: false, error: null });
    expect(cu.statusPushes).toEqual([{ taskId: 'a1', status: 'in progress' }]);
  });

  it('unlinks tasks that leave the source, keeps them, and relinks them', async () => {
    await reset();
    cu.task('a1', 'to do');
    const second = cu.task('a2', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    cu.tasks = cu.tasks.filter((t) => t.id !== 'a2');
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    let tasks = await tasksOf(admin, bundle.project.id);
    expect(tasks).toHaveLength(2);
    const gone = tasks.find((t) => t.clickup.url.endsWith('/a2'));
    expect(gone.clickup.linked).toBe(false);
    // Local again: its title can be edited.
    expect((await admin.patch(`/tasks/${gone.id}`, { version: gone.version, title: 'Mine' })).status).toBe(200);
    cu.tasks.push(second);
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    tasks = await tasksOf(admin, bundle.project.id);
    expect(tasks.find((t) => t.id === gone.id).clickup.linked).toBe(true);
    expect(tasks.find((t) => t.id === gone.id).title).toBe('Task a2');
  });

  it('closes the Session when ClickUp closes the task', async () => {
    await reset();
    const t = cu.task('a1', 'to do');
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin);
    const { bundle } = await linkedProject(admin);
    await admin.patch(`/projects/${bundle.project.id}/agent-settings`, { defaultAgentId: agent.id });
    const created = await createTask(admin, bundle.project.id);
    expect(created.agentId).toBe(agent.id);
    // A task imported later gets the default Agent as well.
    cu.task('a9', 'to do');
    t.status = cu.statuses.find((s) => s.name === 'closed')!;
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    const tasks = await tasksOf(admin, bundle.project.id);
    expect(tasks.find((x) => x.clickup?.url.endsWith('/a9')).agentId).toBe(agent.id);
    const closed = tasks.find((x) => x.clickup?.url.endsWith('/a1'));
    expect(closed.statusId).toBe(bundle.statuses[4].id);
    // The local task has no ClickUp state.
    expect(tasks.find((x) => x.id === created.id).clickup).toBeNull();
  });
});

describe('locks and the description', () => {
  it('locks Statuses (except Category) and the title', async () => {
    await reset();
    cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    const status = bundle.statuses[1];
    expect((await admin.post(`/projects/${bundle.project.id}/statuses`, { name: 'X', color: '#aabbcc', category: 'open' })).status).toBe(403);
    expect((await admin.patch(`/statuses/${status.id}`, { name: 'Y' })).status).toBe(403);
    expect((await admin.patch(`/statuses/${status.id}`, { color: '#112233' })).status).toBe(403);
    expect((await admin.patch(`/statuses/${status.id}`, { category: 'active' })).status).toBe(200);
    expect((await admin.put(`/projects/${bundle.project.id}/statuses/order`, { statusIds: bundle.statuses.map((s: any) => s.id).reverse() })).status).toBe(403);
    expect((await admin.delete(`/statuses/${status.id}?targetStatusId=${bundle.statuses[0].id}`)).status).toBe(403);
    const [task] = await tasksOf(admin, bundle.project.id);
    const res = await admin.patch(`/tasks/${task.id}`, { version: task.version, title: 'Mine' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('clickup_managed');

    // A syncing Category survives later syncs.
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    const statuses = (await admin.get(`/projects/${bundle.project.id}/statuses`)).body.statuses;
    expect(statuses[1].category).toBe('active');
  });

  it('detaches an edited description and restores ClickUp\'s on request', async () => {
    await reset();
    const t = cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    const [task] = await tasksOf(admin, bundle.project.id);
    const edited = await admin.patch(`/tasks/${task.id}`, { version: task.version, description: 'My notes' });
    expect(edited.body.task.clickup.descriptionDetached).toBe(true);
    t.description = 'ClickUp changed';
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    expect((await admin.get(`/tasks/${task.id}`)).body.task.description).toBe('My notes');
    const restored = await admin.post(`/tasks/${task.id}/clickup/restore-description`);
    expect(restored.status).toBe(200);
    expect(restored.body.task).toMatchObject({ description: 'ClickUp changed', clickup: { descriptionDetached: false } });
    expect((await admin.post(`/tasks/${task.id}/clickup/restore-description`)).status).toBe(400);
    t.description = 'Later';
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    expect((await admin.get(`/tasks/${task.id}`)).body.task.description).toBe('Later');
  });

  it('copies ClickUp attachments, keeps local ones and drops those ClickUp removed', async () => {
    await reset();
    const t = cu.task('a1', 'to do', {});
    t.attachments = [cu.attachment('f1', 'spec.txt', 'hello')];
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    const [task] = await tasksOf(admin, bundle.project.id);
    let list = (await admin.get(`/tasks/${task.id}/attachments`)).body.attachments;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ filename: 'spec.txt', fromClickUp: true });
    const file = await admin.get(list[0].url.replace('/api/v1', ''));
    expect(file.status).toBe(200);

    const form = new FormData();
    form.append('files', new Blob(['mine']), 'mine.txt');
    expect((await admin.request('POST', `/tasks/${task.id}/attachments`, { form })).status).toBe(201);
    t.attachments = [cu.attachment('f2', 'other.txt', 'x')];
    await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    list = (await admin.get(`/tasks/${task.id}/attachments`)).body.attachments;
    expect(list.map((a: any) => a.filename).sort()).toEqual(['mine.txt', 'other.txt']);
  });
});

describe('the link', () => {
  it('lists pickers for any User and hides secrets', async () => {
    await reset();
    const admin = await app.admin();
    const credential = await createCredential(admin, { kind: 'clickup_token', secret: 'pk_clickup_token_1234' });
    const { client: member } = await createUser(app, admin);
    const creds = (await member.get('/clickup/credentials')).body.credentials;
    expect(creds).toEqual([{ id: credential.id, name: credential.name, last4: '1234' }]);
    expect((await member.get(`/clickup/teams?credentialId=${credential.id}`)).body.options).toEqual([{ id: 'T1', name: 'Workspace' }]);
    expect((await member.get(`/clickup/lists?credentialId=${credential.id}&spaceId=SP1`)).body.options).toHaveLength(1);
    expect((await member.get('/credentials')).status).toBe(403);
  });

  it('refuses a ClickUp token for an Agent and protects the Credential while linked', async () => {
    await reset();
    const admin = await app.admin();
    const { credential, bundle } = await linkedProject(admin);
    expect((await admin.post('/agents', { name: 'A', credentialId: credential.id })).status).toBe(400);
    const del = await admin.delete(`/credentials/${credential.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.message).toContain('Mirrored');
    await admin.delete(`/projects/${bundle.project.id}/clickup`);
    expect((await admin.delete(`/credentials/${credential.id}`)).status).toBe(204);
  });

  it('removes the link: Statuses unlock and tasks become local', async () => {
    await reset();
    cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    const res = await admin.delete(`/projects/${bundle.project.id}/clickup`);
    expect(res.body.project.clickup).toBeNull();
    const [task] = await tasksOf(admin, bundle.project.id);
    expect(task.clickup.linked).toBe(false);
    expect((await admin.patch(`/statuses/${bundle.statuses[0].id}`, { name: 'Renamed' })).status).toBe(200);
    expect((await admin.patch(`/tasks/${task.id}`, { version: task.version, title: 'Free' })).status).toBe(200);
    expect((await admin.post(`/projects/${bundle.project.id}/clickup/sync`)).status).toBe(400);
  });

  it('stores a sync failure on the link and keeps the Tasks', async () => {
    await reset();
    cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    cu.failFetch = 'ClickUp answered 500';
    const res = await admin.post(`/projects/${bundle.project.id}/clickup/sync`);
    expect(res.body.project.clickup.lastError).toContain('500');
    expect(await tasksOf(admin, bundle.project.id)).toHaveLength(1);
  });

  it('polls linked Projects on tick, and not archived ones', async () => {
    await reset();
    cu.task('a1', 'to do');
    const admin = await app.admin();
    const { bundle } = await linkedProject(admin);
    cu.task('a2', 'to do');
    await app.server.ctx.clickupSync.tick();
    expect(await tasksOf(admin, bundle.project.id)).toHaveLength(2);
    await admin.post(`/projects/${bundle.project.id}/archive`);
    cu.task('a3', 'to do');
    await app.server.ctx.clickupSync.tick();
    expect(await tasksOf(admin, bundle.project.id)).toHaveLength(2);
  });

  it('is invisible for plain Projects', async () => {
    await reset();
    const admin = await app.admin();
    const { project } = await createProject(admin);
    expect(project.clickup).toBeNull();
    const task = await createTask(admin, project.id);
    expect(task.clickup).toBeNull();
  });
});
