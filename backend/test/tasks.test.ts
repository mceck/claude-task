import type { ProjectBundle, Task, TaskCard } from '@claude-task/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from './helpers/client';
import { useTestApp } from './helpers/app';
import { columnTitles, createTag, createProject, createTask, createUser, statusByName } from './helpers/fixtures';

describe('tasks', () => {
  const app = useTestApp();
  let admin: ApiClient;
  let bundle: ProjectBundle;
  let projectId: string;

  beforeEach(async () => {
    admin = await app.admin();
    bundle = await createProject(admin, { key: 'API' });
    projectId = bundle.project.id;
  });

  describe('creating', () => {
    it('numbers tasks sequentially per project and builds the Task Key', async () => {
      const a = await createTask(admin, projectId, { title: 'one' });
      const b = await createTask(admin, projectId, { title: 'two' });
      expect([a.number, a.key, b.number, b.key]).toEqual([1, 'API-1', 2, 'API-2']);

      const other = await createProject(admin, { key: 'WEB' });
      expect((await createTask(admin, other.project.id)).key).toBe('WEB-1');
    });

    it('assigns unique, gapless numbers to concurrently created tasks', async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => admin.post(`/projects/${projectId}/tasks`, { title: `t${i}` })),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const numbers = results.map((r) => r.body.task.number).sort((x: number, y: number) => x - y);
      expect(numbers).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    });

    it('fills in defaults: first open status, no priority, empty description', async () => {
      const task = await createTask(admin, projectId, { title: 'Defaults' });
      expect(task).toMatchObject({
        statusId: statusByName(bundle, 'Backlog').id,
        priority: 'none',
        description: '',
        tagIds: [],
        assigneeIds: [],
        commentCount: 0,
        version: 1,
      });
    });

    it('records who created the task and when', async () => {
      const { client, user } = await createUser(app, admin, { displayName: 'Creator' });
      const task = await createTask(client, projectId);
      expect(task.createdBy).toEqual({ type: 'user', id: user.id, displayName: 'Creator' });
      expect(Date.parse(task.createdAt)).toBeGreaterThan(Date.now() - 60_000);
      expect(task.updatedAt).toBe(task.createdAt);
    });

    it('adds a task to the end of the given column', async () => {
      const todo = statusByName(bundle, 'Todo');
      await createTask(admin, projectId, { title: 'first', statusId: todo.id });
      await createTask(admin, projectId, { title: 'second', statusId: todo.id });
      expect(await columnTitles(admin, projectId, todo.id)).toEqual(['first', 'second']);
    });

    it('rejects statuses and tags from another project, and unknown users', async () => {
      const other = await createProject(admin);
      const foreignTag = await createTag(admin, other.project.id, 'foreign');
      const post = (body: object) => admin.post(`/projects/${projectId}/tasks`, { title: 'x', ...body });
      expect((await post({ statusId: statusByName(other, 'Todo').id })).status).toBe(400);
      expect((await post({ tagIds: [foreignTag.id] })).status).toBe(400);
      expect((await post({ assigneeIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(400);
      expect((await post({ title: '   ' })).status).toBe(400);
      expect((await post({ priority: 'meh' })).status).toBe(400);
    });

    it('does not consume a number when creation fails', async () => {
      await admin.post(`/projects/${projectId}/tasks`, { title: 'x', assigneeIds: ['00000000-0000-4000-8000-000000000000'] });
      expect((await createTask(admin, projectId)).number).toBe(1);
    });
  });

  describe('reading', () => {
    it('gets a task by id or by Task Key', async () => {
      const task = await createTask(admin, projectId, { title: 'Find me', description: '# Hello' });
      expect((await admin.get(`/tasks/${task.id}`)).body.task).toMatchObject({ key: 'API-1', description: '# Hello' });
      expect((await admin.get('/tasks/API-1')).body.task.id).toBe(task.id);
      expect((await admin.get('/tasks/api-1')).body.task.id).toBe(task.id);
      expect((await admin.get('/tasks/API-2')).status).toBe(404);
      expect((await admin.get('/tasks/garbage')).status).toBe(404);
    });

    it('lists cards with key, title, priority, tags, assignees and comment count', async () => {
      const { user } = await createUser(app, admin);
      const tag = await createTag(admin, projectId, 'bug');
      const task = await createTask(admin, projectId, {
        title: 'Card',
        priority: 'high',
        tagIds: [tag.id],
        assigneeIds: [user.id],
      });
      await admin.post(`/tasks/${task.id}/comments`, { body: 'hi' });
      const [card] = (await admin.get(`/projects/${projectId}/tasks`)).body.tasks;
      expect(card).toMatchObject({
        key: 'API-1',
        title: 'Card',
        priority: 'high',
        tagIds: [tag.id],
        assigneeIds: [user.id],
        commentCount: 1,
      });
      expect(card).not.toHaveProperty('description');
    });

    it('leaves closed-category tasks out unless asked for', async () => {
      await createTask(admin, projectId, { title: 'open one' });
      await createTask(admin, projectId, { title: 'closed one', statusId: statusByName(bundle, 'Closed').id });
      const titles = async (query: string) =>
        (await admin.get(`/projects/${projectId}/tasks${query}`)).body.tasks.map((t: TaskCard) => t.title);
      expect(await titles('')).toEqual(['open one']);
      expect(await titles('?includeClosed=true')).toEqual(['open one', 'closed one']);
    });
  });

  describe('filtering', () => {
    let alice: string;
    let bob: string;
    let bug: string;
    let ui: string;

    beforeEach(async () => {
      alice = (await createUser(app, admin, { displayName: 'Alice' })).user.id;
      bob = (await createUser(app, admin, { displayName: 'Bob' })).user.id;
      bug = (await createTag(admin, projectId, 'bug')).id;
      ui = (await createTag(admin, projectId, 'ui')).id;
      await createTask(admin, projectId, { title: 'Login crashes', priority: 'urgent', tagIds: [bug], assigneeIds: [alice] });
      await createTask(admin, projectId, { title: 'Dark mode', priority: 'low', tagIds: [ui], assigneeIds: [bob] });
      await createTask(admin, projectId, { title: 'Button misaligned', priority: 'normal', tagIds: [bug, ui], assigneeIds: [alice, bob] });
      await createTask(admin, projectId, { title: 'Write docs', priority: 'none' });
    });

    const titles = async (query: string) =>
      (await admin.get(`/projects/${projectId}/tasks?${query}`)).body.tasks.map((t: TaskCard) => t.title).sort();

    it('filters by assignee, including unassigned', async () => {
      expect(await titles(`assignee=${alice}`)).toEqual(['Button misaligned', 'Login crashes']);
      expect(await titles('assignee=none')).toEqual(['Write docs']);
      expect(await titles(`assignee=${bob},none`)).toEqual(['Button misaligned', 'Dark mode', 'Write docs']);
    });

    it('filters by tag and priority', async () => {
      expect(await titles(`tag=${ui}`)).toEqual(['Button misaligned', 'Dark mode']);
      expect(await titles('priority=urgent&priority=low')).toEqual(['Dark mode', 'Login crashes']);
    });

    it('filters by text in the title or Task Key', async () => {
      expect(await titles('q=MODE')).toEqual(['Dark mode']);
      expect(await titles('q=api-4')).toEqual(['Write docs']);
      expect(await titles('q=100%25')).toEqual([]);
    });

    it('combines filters', async () => {
      expect(await titles(`assignee=${alice}&tag=${ui}`)).toEqual(['Button misaligned']);
      expect(await titles(`tag=${bug}&priority=urgent&q=login`)).toEqual(['Login crashes']);
      expect(await titles(`assignee=${bob}&priority=urgent`)).toEqual([]);
    });

    it('rejects malformed filters', async () => {
      expect((await admin.get(`/projects/${projectId}/tasks?priority=meh`)).status).toBe(400);
      expect((await admin.get(`/projects/${projectId}/tasks?tag=nope`)).status).toBe(400);
    });
  });

  describe('updating', () => {
    it('updates fields, bumps the version and records a revision with before and after', async () => {
      const { user } = await createUser(app, admin);
      const tag = await createTag(admin, projectId, 'bug');
      const task = await createTask(admin, projectId, { title: 'Old', description: 'old' });
      const res = await admin.patch(`/tasks/${task.id}`, {
        version: task.version,
        title: 'New',
        description: 'new',
        priority: 'urgent',
        tagIds: [tag.id],
        assigneeIds: [user.id],
      });
      expect(res.status).toBe(200);
      expect(res.body.task).toMatchObject({ title: 'New', description: 'new', priority: 'urgent', version: 2 });
      expect(Date.parse(res.body.task.updatedAt)).toBeGreaterThanOrEqual(Date.parse(task.updatedAt));

      const [item] = (await admin.get(`/tasks/${task.id}/timeline`)).body.items;
      expect(item.type).toBe('revision');
      expect(item.revision.version).toBe(2);
      expect(item.revision.actor).toMatchObject({ type: 'user', displayName: 'Ada Admin' });
      expect(item.revision.changes).toEqual(
        expect.arrayContaining([
          { field: 'title', before: 'Old', after: 'New' },
          { field: 'description', before: 'old', after: 'new' },
          { field: 'priority', before: 'none', after: 'urgent' },
          { field: 'tagIds', before: [], after: [tag.id] },
          { field: 'assigneeIds', before: [], after: [user.id] },
        ]),
      );
      expect(item.revision.changes).toHaveLength(5);
    });

    it('records nothing for a patch that changes nothing', async () => {
      const task = await createTask(admin, projectId, { title: 'Same' });
      const res = await admin.patch(`/tasks/${task.id}`, { version: 1, title: 'Same' });
      expect(res.body.task.version).toBe(1);
      expect((await admin.get(`/tasks/${task.id}/timeline`)).body.items).toEqual([]);
    });

    it('moves the task to the end of the new column when the patch changes its status', async () => {
      const todo = statusByName(bundle, 'Todo');
      await createTask(admin, projectId, { title: 'already there', statusId: todo.id });
      const task = await createTask(admin, projectId, { title: 'patched in' });
      const res = await admin.patch(`/tasks/${task.id}`, { version: 1, statusId: todo.id });
      expect(res.body.task.statusId).toBe(todo.id);
      expect(await columnTitles(admin, projectId, todo.id)).toEqual(['already there', 'patched in']);
    });

    describe('with a stale version', () => {
      it('returns 409 with the current task when the patch touches a field changed since', async () => {
        const task = await createTask(admin, projectId, { title: 'Original' });
        const { client: other } = await createUser(app, admin);
        await other.patch(`/tasks/${task.id}`, { version: 1, title: 'Theirs' });

        const res = await admin.patch(`/tasks/${task.id}`, { version: 1, title: 'Mine', priority: 'high' });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('conflict');
        expect(res.body.task).toMatchObject({ title: 'Theirs', version: 2, priority: 'none' });

        const current = (await admin.get(`/tasks/${task.id}`)).body.task;
        expect(current).toMatchObject({ title: 'Theirs', priority: 'none', version: 2 });
      });

      it('applies the patch when it only touches fields nobody changed', async () => {
        const task = await createTask(admin, projectId, { title: 'Original' });
        await admin.patch(`/tasks/${task.id}`, { version: 1, title: 'Renamed' });
        const res = await admin.patch(`/tasks/${task.id}`, { version: 1, description: 'Added later' });
        expect(res.status).toBe(200);
        expect(res.body.task).toMatchObject({ title: 'Renamed', description: 'Added later', version: 3 });
      });

      it('conflicts on a status patch after a move, but the move itself never conflicts', async () => {
        const task = await createTask(admin, projectId);
        const moved = await admin.post(`/tasks/${task.id}/move`, { statusId: statusByName(bundle, 'In Progress').id });
        expect(moved.status).toBe(200);
        expect(moved.body.task.version).toBe(2);

        const stale = await admin.patch(`/tasks/${task.id}`, { version: 1, statusId: statusByName(bundle, 'Done').id });
        expect(stale.status).toBe(409);
        const fine = await admin.patch(`/tasks/${task.id}`, { version: 1, title: 'Only the title' });
        expect(fine.status).toBe(200);
      });

      it('rejects a version from the future', async () => {
        const task = await createTask(admin, projectId);
        expect((await admin.patch(`/tasks/${task.id}`, { version: 7, title: 'x' })).status).toBe(409);
      });
    });
  });

  describe('moving and ordering', () => {
    let todo: string;
    let inProgress: string;
    let byTitle: Record<string, Task>;

    beforeEach(async () => {
      todo = statusByName(bundle, 'Todo').id;
      inProgress = statusByName(bundle, 'In Progress').id;
      byTitle = {};
      for (const title of ['a', 'b', 'c']) byTitle[title] = await createTask(admin, projectId, { title, statusId: todo });
      byTitle.x = await createTask(admin, projectId, { title: 'x', statusId: inProgress });
    });

    const move = (title: string, body: object) => admin.post(`/tasks/${byTitle[title]!.id}/move`, body);

    it('reorders within a column without a revision or a version bump', async () => {
      const res = await move('c', { statusId: todo, afterTaskId: byTitle.a!.id, beforeTaskId: byTitle.b!.id });
      expect(res.status).toBe(200);
      expect(res.body.task.version).toBe(1);
      expect(await columnTitles(admin, projectId, todo)).toEqual(['a', 'c', 'b']);
      expect((await admin.get(`/tasks/${byTitle.c!.id}/timeline`)).body.items).toEqual([]);
    });

    it('moves to the top, the end, or right above a task', async () => {
      await move('c', { statusId: todo, afterTaskId: null });
      expect(await columnTitles(admin, projectId, todo)).toEqual(['c', 'a', 'b']);
      await move('c', { statusId: todo });
      expect(await columnTitles(admin, projectId, todo)).toEqual(['a', 'b', 'c']);
      await move('c', { statusId: todo, beforeTaskId: byTitle.b!.id });
      expect(await columnTitles(admin, projectId, todo)).toEqual(['a', 'c', 'b']);
    });

    it('moves to another column at the given place, recording the status change', async () => {
      const res = await move('b', { statusId: inProgress, afterTaskId: null, beforeTaskId: byTitle.x!.id });
      expect(res.body.task).toMatchObject({ statusId: inProgress, version: 2 });
      expect(await columnTitles(admin, projectId, todo)).toEqual(['a', 'c']);
      expect(await columnTitles(admin, projectId, inProgress)).toEqual(['b', 'x']);
      const [item] = (await admin.get(`/tasks/${byTitle.b!.id}/timeline`)).body.items;
      expect(item.revision.changes).toEqual([{ field: 'statusId', before: todo, after: inProgress }]);
    });

    it('keeps the order across many moves into the same gap', async () => {
      // Repeatedly inserting right below "a" exercises fractional keys and their ordering in Postgres.
      for (let i = 0; i < 30; i++) {
        const t = await createTask(admin, projectId, { title: `n${i}`, statusId: inProgress });
        await admin.post(`/tasks/${t.id}/move`, { statusId: todo, afterTaskId: byTitle.a!.id });
      }
      const titles = await columnTitles(admin, projectId, todo);
      expect(titles.slice(0, 2)).toEqual(['a', 'n29']);
      expect(titles.slice(-3)).toEqual(['n0', 'b', 'c']);
    });

    it('settles concurrent moves into the same slot without losing tasks', async () => {
      const others = await Promise.all(
        Array.from({ length: 6 }, (_, i) => createTask(admin, projectId, { title: `m${i}`, statusId: inProgress })),
      );
      const results = await Promise.all(
        others.map((t) => admin.post(`/tasks/${t.id}/move`, { statusId: todo, afterTaskId: byTitle.a!.id, beforeTaskId: byTitle.b!.id })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const titles = await columnTitles(admin, projectId, todo);
      expect(titles).toHaveLength(9);
      expect(titles[0]).toBe('a');
      expect(titles.slice(-2)).toEqual(['b', 'c']);

      // Even with duplicate keys, a later move into the crowded gap lands where asked.
      const [first, second] = [titles[1]!, titles[2]!];
      const ids = (await admin.get(`/projects/${projectId}/tasks`)).body.tasks as TaskCard[];
      const id = (title: string) => ids.find((t) => t.title === title)!.id;
      await admin.post(`/tasks/${byTitle.c!.id}/move`, { statusId: todo, afterTaskId: id(first), beforeTaskId: id(second) });
      const after = await columnTitles(admin, projectId, todo);
      expect(after.slice(0, 3)).toEqual(['a', first, 'c']);
    });

    it('gives moves racing a status deletion a clean answer and loses no task', async () => {
      const review = statusByName(bundle, 'Ready for Review').id;
      const movers = await Promise.all(
        Array.from({ length: 8 }, (_, i) => createTask(admin, projectId, { title: `r${i}`, statusId: inProgress })),
      );
      const [deleted, ...moves] = await Promise.all([
        admin.delete(`/statuses/${review}?targetStatusId=${todo}`),
        ...movers.map((t) => admin.post(`/tasks/${t.id}/move`, { statusId: review })),
      ]);
      expect(deleted!.status).toBe(204);
      // A move either landed before the deletion (and was relocated) or found the status gone.
      for (const m of moves) expect([200, 400]).toContain(m.status);
      const cards = (await admin.get(`/projects/${projectId}/tasks?includeClosed=true`)).body.tasks as TaskCard[];
      expect(cards).toHaveLength(4 + movers.length);
      expect(cards.some((c) => c.statusId === review)).toBe(false);
    });

    it('rejects a move to a status of another project', async () => {
      const other = await createProject(admin);
      expect((await move('a', { statusId: statusByName(other, 'Todo').id })).status).toBe(400);
    });
  });

  describe('deleting', () => {
    it('deletes a task and everything on it', async () => {
      const task = await createTask(admin, projectId);
      await admin.post(`/tasks/${task.id}/comments`, { body: 'bye' });
      expect((await admin.delete(`/tasks/${task.id}`)).status).toBe(204);
      expect((await admin.get(`/tasks/${task.id}`)).status).toBe(404);
      expect((await admin.get(`/tasks/${task.id}/timeline`)).status).toBe(404);
      expect((await admin.get(`/projects/${projectId}/tasks`)).body.tasks).toEqual([]);
    });

    it('never reuses the number of a deleted task', async () => {
      const task = await createTask(admin, projectId);
      await admin.delete(`/tasks/${task.id}`);
      expect((await createTask(admin, projectId)).key).toBe('API-2');
    });
  });

  describe('timeline', () => {
    it('interleaves comments and revisions chronologically, newest first', async () => {
      const task = await createTask(admin, projectId, { title: 'v1' });
      await admin.post(`/tasks/${task.id}/comments`, { body: 'first comment' });
      await admin.patch(`/tasks/${task.id}`, { version: 1, title: 'v2' });
      await admin.post(`/tasks/${task.id}/comments`, { body: 'second comment' });
      await admin.post(`/tasks/${task.id}/move`, { statusId: statusByName(bundle, 'Done').id });

      const { items, nextCursor } = (await admin.get(`/tasks/${task.id}/timeline`)).body;
      expect(nextCursor).toBeNull();
      const describe = (i: { type: string; comment?: { body: string }; revision?: { changes: { field: string }[] } }) =>
        i.type === 'comment' ? i.comment!.body : i.revision!.changes.map((c) => c.field).join();
      expect(items.map(describe)).toEqual(['statusId', 'second comment', 'title', 'first comment']);
      const times = items.map((i: { createdAt: string }) => Date.parse(i.createdAt));
      expect([...times].sort((x, y) => y - x)).toEqual(times);
    });

    it('pages backwards with a cursor', async () => {
      const task = await createTask(admin, projectId);
      for (let i = 1; i <= 7; i++) await admin.post(`/tasks/${task.id}/comments`, { body: `c${i}` });

      const bodies: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor ? `?limit=3&before=${cursor}` : '?limit=3';
        const page = (await admin.get(`/tasks/${task.id}/timeline${query}`)).body;
        bodies.push(...page.items.map((i: { comment: { body: string } }) => i.comment.body));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(bodies).toEqual(['c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1']);
    });

    it('rejects a malformed cursor', async () => {
      const task = await createTask(admin, projectId);
      expect((await admin.get(`/tasks/${task.id}/timeline?before=nonsense`)).status).toBe(400);
    });
  });
});

describe('tags', () => {
  const app = useTestApp();

  it('creates, renames, recolors and deletes tags, detaching them from tasks', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const tag = await createTag(admin, project.id, 'bug', '#ff0000');
    const task = await createTask(admin, project.id, { tagIds: [tag.id] });

    const updated = await admin.patch(`/tags/${tag.id}`, { name: 'defect', color: '#00ff00' });
    expect(updated.body.tag).toMatchObject({ name: 'defect', color: '#00ff00' });
    expect((await admin.get(`/projects/${project.id}/tags`)).body.tags).toHaveLength(1);

    expect((await admin.delete(`/tags/${tag.id}`)).status).toBe(204);
    expect((await admin.get(`/projects/${project.id}/tags`)).body.tags).toEqual([]);
    expect((await admin.get(`/tasks/${task.id}`)).body.task.tagIds).toEqual([]);
  });

  it('records a revision on every task that loses a deleted tag', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const bug = await createTag(admin, project.id, 'bug');
    const ui = await createTag(admin, project.id, 'ui');
    const task = await createTask(admin, project.id, { tagIds: [bug.id, ui.id] });
    const untouched = await createTask(admin, project.id, { tagIds: [ui.id] });

    await admin.delete(`/tags/${bug.id}`);

    const after = (await admin.get(`/tasks/${task.id}`)).body.task;
    expect(after).toMatchObject({ tagIds: [ui.id], version: 2 });
    const [item] = (await admin.get(`/tasks/${task.id}/timeline`)).body.items;
    expect(item.revision.changes).toEqual([
      { field: 'tagIds', before: [bug.id, ui.id].sort(), after: [ui.id] },
    ]);
    expect((await admin.get(`/tasks/${untouched.id}`)).body.task.version).toBe(1);
  });

  it('keeps tag names unique within a project', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    await createTag(admin, project.id, 'bug');
    expect((await admin.post(`/projects/${project.id}/tags`, { name: 'BUG', color: '#000000' })).status).toBe(409);
  });
});
