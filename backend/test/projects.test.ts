import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import { createAgent, createProject, createTask, createUser, getSession, statusByName } from './helpers/fixtures';

describe('projects', () => {
  const app = useTestApp();

  it('creates a project with the six default statuses', async () => {
    const admin = await app.admin();
    const res = await admin.post('/projects', { key: 'API', name: 'Public API', description: 'The REST API' });
    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({ key: 'API', name: 'Public API', description: 'The REST API', archivedAt: null });
    expect(res.body.statuses.map((s: { name: string; category: string }) => [s.name, s.category])).toEqual([
      ['Backlog', 'open'],
      ['Todo', 'open'],
      ['In Progress', 'active'],
      ['Ready for Review', 'review'],
      ['Done', 'done'],
      ['Closed', 'closed'],
    ]);
    expect(res.body.tags).toEqual([]);
  });

  it('lets a Member create a Project with its Repository and default Agent before the first Task', async () => {
    const admin = await app.admin();
    const { agent, runner } = await createAgent(app, admin);
    const { client } = await createUser(app, admin);
    app.git.branches.get('1')!.add('develop');
    const result = await client.post('/projects', {
      key: 'CFG', name: 'Configured', defaultAgentId: agent.id,
      repository: { connectionId: 'env-github', providerRepoId: '1', baseBranch: 'develop' },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const { project } = result.body;
    expect(project.repository).toMatchObject({ connectionId: 'env-github', providerRepoId: '1', baseBranch: 'develop', protection: { protected: true } });
    expect((await client.get(`/projects/${project.id}/agent-settings`)).body.settings.defaultAgentId).toBe(agent.id);
    const task = await createTask(client, project.id);
    expect(task.agentId).toBe(agent.id);
    expect(await getSession(client, task.id)).toMatchObject({ state: 'pending' });
    expect(await runner.none('job.start')).toBe(true);
  });

  it('accepts a Repository alone and uses its default Base Branch', async () => {
    const admin = await app.admin();
    const result = await admin.post('/projects', {
      key: 'REPO', name: 'Repository only',
      repository: { connectionId: 'env-github', providerRepoId: '1' },
    });
    expect(result.status).toBe(201);
    expect(result.body.project.repository.baseBranch).toBe('main');
    expect((await admin.get(`/projects/${result.body.project.id}/agent-settings`)).body.settings.defaultAgentId).toBeNull();
  });

  it('accepts a default Agent alone and explicit empty configuration', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin);
    const result = await admin.post('/projects', { key: 'AGENT', name: 'Agent only', defaultAgentId: agent.id });
    expect(result.status).toBe(201);
    expect(result.body.project.repository).toBeNull();
    expect((await createTask(admin, result.body.project.id)).agentId).toBe(agent.id);
    const empty = await admin.post('/projects', { key: 'EMPTY', name: 'Empty', defaultAgentId: null, repository: null });
    expect(empty.status).toBe(201);
    expect((await createTask(admin, empty.body.project.id)).agentId).toBeNull();
  });

  it.each([
    { defaultAgentId: randomUUID() },
    { repository: { connectionId: 'missing', providerRepoId: '1' } },
    { repository: { connectionId: 'env-github', providerRepoId: '999' } },
    { repository: { connectionId: 'env-github', providerRepoId: '1', baseBranch: 'missing' } },
  ])('rejects invalid initial configuration atomically: %j', async (configuration) => {
    const admin = await app.admin();
    const result = await admin.post('/projects', { key: 'RETRY', name: 'Invalid', ...configuration });
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    expect((await admin.get('/projects/RETRY')).status).toBe(404);
    expect((await admin.post('/projects', { key: 'RETRY', name: 'Corrected' })).status).toBe(201);
  });

  it.each(['A', 'TOOLONG', 'api', 'A1', 'AB-C', ''])('rejects the key %j', async (key) => {
    const admin = await app.admin();
    const res = await admin.post('/projects', { key, name: 'x' });
    expect(res.status).toBe(400);
  });

  it('keeps keys unique', async () => {
    const admin = await app.admin();
    await createProject(admin, { key: 'WEB' });
    const res = await admin.post('/projects', { key: 'WEB', name: 'Again' });
    expect(res.status).toBe(409);
  });

  it('keeps keys immutable', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin, { key: 'OLD' });
    const res = await admin.patch(`/projects/${project.id}`, { key: 'NEW' });
    expect(res.status).toBe(400);
    expect((await admin.get(`/projects/${project.id}`)).body.project.key).toBe('OLD');
  });

  it('edits the name and description', async () => {
    const { client } = await createUser(app, await app.admin());
    const { project } = await createProject(client, { name: 'Before' });
    const res = await client.patch(`/projects/${project.id}`, { name: 'After', description: 'Now described' });
    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({ name: 'After', description: 'Now described' });
  });

  it('finds a project by key as well as by id', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin, { key: 'FIND' });
    expect((await admin.get('/projects/FIND')).body.project.id).toBe(project.id);
    expect((await admin.get('/projects/find')).body.project.id).toBe(project.id);
    expect((await admin.get('/projects/NOPE')).status).toBe(404);
  });

  it('archives and unarchives, moving the project between lists', async () => {
    const { client } = await createUser(app, await app.admin());
    const { project } = await createProject(client, { key: 'ARC' });
    const keys = async (archived: boolean) =>
      (await client.get(`/projects?archived=${archived}`)).body.projects.map((p: { key: string }) => p.key);

    expect((await client.post(`/projects/${project.id}/archive`)).body.project.archivedAt).not.toBeNull();
    expect(await keys(false)).not.toContain('ARC');
    expect(await keys(true)).toContain('ARC');
    // History stays readable.
    expect((await client.get(`/projects/${project.id}`)).status).toBe(200);

    expect((await client.post(`/projects/${project.id}/unarchive`)).body.project.archivedAt).toBeNull();
    expect(await keys(false)).toContain('ARC');
    expect(await keys(true)).not.toContain('ARC');
  });

  it('lists projects with task counts per status category', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin, { key: 'CNT' });
    const id = bundle.project.id;
    await createTask(admin, id, { statusId: statusByName(bundle, 'Backlog').id });
    await createTask(admin, id, { statusId: statusByName(bundle, 'Todo').id });
    await createTask(admin, id, { statusId: statusByName(bundle, 'In Progress').id });
    await createTask(admin, id, { statusId: statusByName(bundle, 'Closed').id });
    await createProject(admin, { key: 'EMPTY' });

    const { projects } = (await admin.get('/projects')).body;
    expect(projects.find((p: { key: string }) => p.key === 'CNT').taskCounts).toEqual({
      open: 2,
      active: 1,
      review: 0,
      done: 0,
      closed: 1,
    });
    expect(projects.find((p: { key: string }) => p.key === 'EMPTY').taskCounts).toEqual({
      open: 0,
      active: 0,
      review: 0,
      done: 0,
      closed: 0,
    });
  });

  describe('permanent deletion', () => {
    it('requires the project to be archived first', async () => {
      const admin = await app.admin();
      const { project } = await createProject(admin);
      expect((await admin.delete(`/projects/${project.id}`)).status).toBe(400);
    });

    it('deletes an archived project with its tasks, comments and attachments', async () => {
      const admin = await app.admin();
      const { project } = await createProject(admin, { key: 'GONE' });
      const task = await createTask(admin, project.id);
      const form = new FormData();
      form.set('body', 'with a file');
      form.append('files', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
      const comment = (await admin.request('POST', `/tasks/${task.id}/comments`, { form })).body.comment;

      await admin.post(`/projects/${project.id}/archive`);
      expect((await admin.delete(`/projects/${project.id}`)).status).toBe(204);
      expect((await admin.get(`/projects/${project.id}`)).status).toBe(404);
      expect((await admin.get(`/tasks/${task.id}`)).status).toBe(404);
      expect((await admin.get(`/attachments/${comment.attachments[0].id}`)).status).toBe(404);
      // The key is free again.
      expect((await admin.post('/projects', { key: 'GONE', name: 'Reborn' })).status).toBe(201);
    });
  });
});

describe('statuses', () => {
  const app = useTestApp();

  it('adds a status at the end', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const res = await admin.post(`/projects/${project.id}/statuses`, { name: 'QA', color: '#123456', category: 'review' });
    expect(res.status).toBe(201);
    const { statuses } = (await admin.get(`/projects/${project.id}/statuses`)).body;
    expect(statuses.at(-1)).toMatchObject({ name: 'QA', color: '#123456', category: 'review' });
  });

  it('renames and recolors a status', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    const res = await admin.patch(`/statuses/${statusByName(bundle, 'Todo').id}`, { name: 'Ready', color: '#abcdef' });
    expect(res.body.status).toMatchObject({ name: 'Ready', color: '#abcdef', category: 'open' });
  });

  it('answers edits racing a deletion of the same status or tag with 404, never 500', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    const todo = statusByName(bundle, 'Backlog');
    for (let i = 0; i < 8; i++) {
      const status = (await admin.post(`/projects/${bundle.project.id}/statuses`, { name: `Race ${i}`, color: '#123456', category: 'open' })).body.status;
      const tag = (await admin.post(`/projects/${bundle.project.id}/tags`, { name: `race-${i}`, color: '#123456' })).body.tag;
      const results = await Promise.all([
        admin.patch(`/statuses/${status.id}`, { name: `Renamed ${i}` }),
        admin.delete(`/statuses/${status.id}?targetStatusId=${todo.id}`),
        admin.patch(`/tags/${tag.id}`, { name: `renamed-${i}` }),
        admin.delete(`/tags/${tag.id}`),
      ]);
      for (const r of results) expect([200, 204, 404]).toContain(r.status);
    }
  });

  it('keeps names unique within a project, ignoring case', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    const res = await admin.post(`/projects/${bundle.project.id}/statuses`, { name: 'todo', color: '#000000', category: 'open' });
    expect(res.status).toBe(409);
    const other = await createProject(admin);
    expect(
      (await admin.post(`/projects/${other.project.id}/statuses`, { name: 'Unique', color: '#000000', category: 'open' }))
        .status,
    ).toBe(201);
  });

  it('rejects invalid colors and categories', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    expect((await admin.post(`/projects/${project.id}/statuses`, { name: 'X', color: 'red', category: 'open' })).status).toBe(400);
    expect((await admin.post(`/projects/${project.id}/statuses`, { name: 'X', color: '#000000', category: 'wip' })).status).toBe(400);
  });

  it('reorders statuses', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    const ids = bundle.statuses.map((s) => s.id).reverse();
    const res = await admin.put(`/projects/${bundle.project.id}/statuses/order`, { statusIds: ids });
    expect(res.status).toBe(200);
    const { statuses } = (await admin.get(`/projects/${bundle.project.id}/statuses`)).body;
    expect(statuses.map((s: { id: string }) => s.id)).toEqual(ids);
  });

  it('rejects a reorder that is not a permutation of the statuses', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    const ids = bundle.statuses.map((s) => s.id);
    const statusesOrder = `/projects/${bundle.project.id}/statuses/order`;
    expect((await admin.put(statusesOrder, { statusIds: ids.slice(1) })).status).toBe(400);
    expect((await admin.put(statusesOrder, { statusIds: [...ids.slice(1), ids[1]] })).status).toBe(400);
  });

  it('refuses to delete the last open or the last closed status', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    const backlog = statusByName(bundle, 'Backlog');
    const todo = statusByName(bundle, 'Todo');
    const closed = statusByName(bundle, 'Closed');
    const done = statusByName(bundle, 'Done');

    expect((await admin.delete(`/statuses/${backlog.id}?targetStatusId=${todo.id}`)).status).toBe(204);
    const lastOpen = await admin.delete(`/statuses/${todo.id}?targetStatusId=${done.id}`);
    expect(lastOpen.status).toBe(400);
    expect(lastOpen.body.error.message).toMatch(/open/);
    const lastClosed = await admin.delete(`/statuses/${closed.id}?targetStatusId=${done.id}`);
    expect(lastClosed.status).toBe(400);
    expect(lastClosed.body.error.message).toMatch(/closed/);
  });

  it('refuses to recategorize the last open or closed status', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    expect((await admin.patch(`/statuses/${statusByName(bundle, 'Closed').id}`, { category: 'done' })).status).toBe(400);
    expect((await admin.patch(`/statuses/${statusByName(bundle, 'Backlog').id}`, { category: 'active' })).status).toBe(200);
    expect((await admin.patch(`/statuses/${statusByName(bundle, 'Todo').id}`, { category: 'active' })).status).toBe(400);
  });

  it('requires a target status when deleting', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    const inProgress = statusByName(bundle, 'In Progress');
    expect((await admin.delete(`/statuses/${inProgress.id}`)).status).toBe(400);
    expect((await admin.delete(`/statuses/${inProgress.id}?targetStatusId=${inProgress.id}`)).status).toBe(400);

    const other = await createProject(admin);
    const foreign = statusByName(other, 'Todo');
    expect((await admin.delete(`/statuses/${inProgress.id}?targetStatusId=${foreign.id}`)).status).toBe(404);
  });

  it('moves the deleted status’s tasks to the end of the target, in order, with revisions', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    const id = bundle.project.id;
    const review = statusByName(bundle, 'Ready for Review');
    const done = statusByName(bundle, 'Done');
    await createTask(admin, id, { title: 'done-1', statusId: done.id });
    const r1 = await createTask(admin, id, { title: 'review-1', statusId: review.id });
    await createTask(admin, id, { title: 'review-2', statusId: review.id });

    expect((await admin.delete(`/statuses/${review.id}?targetStatusId=${done.id}`)).status).toBe(204);

    const { statuses } = (await admin.get(`/projects/${id}/statuses`)).body;
    expect(statuses.map((s: { name: string }) => s.name)).not.toContain('Ready for Review');
    const tasks = (await admin.get(`/projects/${id}/tasks`)).body.tasks;
    expect(tasks.filter((t: { statusId: string }) => t.statusId === done.id).map((t: { title: string }) => t.title)).toEqual([
      'done-1',
      'review-1',
      'review-2',
    ]);

    const moved = (await admin.get(`/tasks/${r1.id}`)).body.task;
    expect(moved.version).toBe(r1.version + 1);
    const timeline = (await admin.get(`/tasks/${r1.id}/timeline`)).body.items;
    expect(timeline[0].revision.changes).toEqual([{ field: 'statusId', before: review.id, after: done.id }]);
  });
});
