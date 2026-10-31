import { ATTACHMENT_MAX_BYTES } from '@claude-task/shared';
import type { Task } from '@claude-task/shared';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from './helpers/client';
import { useTestApp } from './helpers/app';
import { createProject, createTask, createUser } from './helpers/fixtures';

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function upload(client: ApiClient, taskId: string, body: string, files: { name: string; type: string; data: Buffer | string }[], internal = false) {
  const form = new FormData();
  form.set('body', body);
  form.set('internal', String(internal));
  for (const f of files) form.append('files', new Blob([f.data], { type: f.type }), f.name);
  return client.request('POST', `/tasks/${taskId}/comments`, { form });
}

describe('comments', () => {
  const app = useTestApp();
  let admin: ApiClient;
  let member: ApiClient;
  let task: Task;

  beforeEach(async () => {
    admin = await app.admin();
    member = (await createUser(app, admin, { displayName: 'Mia' })).client;
    task = await createTask(admin, (await createProject(admin)).project.id);
  });

  const timeline = async () => (await admin.get(`/tasks/${task.id}/timeline`)).body.items;

  it('posts a markdown comment authored by the user', async () => {
    const res = await member.post(`/tasks/${task.id}/comments`, { body: '**bold** and `code`' });
    expect(res.status).toBe(201);
    expect(res.body.comment).toMatchObject({
      taskId: task.id,
      kind: 'user',
      author: { type: 'user', displayName: 'Mia' },
      body: '**bold** and `code`',
      internal: false,
      attachments: [],
      editedAt: null,
      deletedAt: null,
    });
    expect((await timeline())[0].comment.id).toBe(res.body.comment.id);
  });

  it('flags internal notes in the API', async () => {
    const res = await member.post(`/tasks/${task.id}/comments`, { body: 'just between us', internal: true });
    expect(res.body.comment.internal).toBe(true);
    expect((await timeline())[0].comment.internal).toBe(true);
  });

  it('rejects an empty comment', async () => {
    expect((await member.post(`/tasks/${task.id}/comments`, { body: '  ' })).status).toBe(400);
    expect((await member.post(`/tasks/${task.id}/comments`, {})).status).toBe(400);
  });

  it('returns 404 for comments on a missing task', async () => {
    const res = await member.post('/tasks/00000000-0000-4000-8000-000000000000/comments', { body: 'x' });
    expect(res.status).toBe(404);
  });

  it('counts comments on the card', async () => {
    await member.post(`/tasks/${task.id}/comments`, { body: 'one' });
    const two = (await member.post(`/tasks/${task.id}/comments`, { body: 'two', internal: true })).body.comment;
    const count = async () => (await admin.get(`/tasks/${task.id}`)).body.task.commentCount;
    expect(await count()).toBe(2);
    await member.delete(`/comments/${two.id}`);
    expect(await count()).toBe(1);
  });

  describe('editing', () => {
    it('lets the author edit their comment, marking it edited', async () => {
      const c = (await member.post(`/tasks/${task.id}/comments`, { body: 'typo' })).body.comment;
      const res = await member.patch(`/comments/${c.id}`, { body: 'fixed' });
      expect(res.status).toBe(200);
      expect(res.body.comment.body).toBe('fixed');
      expect(res.body.comment.editedAt).not.toBeNull();
      expect((await timeline())[0].comment.body).toBe('fixed');
    });

    it('keeps whitespace-significant Markdown and treats the same body as unchanged', async () => {
      const body = '    indented code\n\ntext';
      const c = (await member.post(`/tasks/${task.id}/comments`, { body })).body.comment;
      const same = await member.patch(`/comments/${c.id}`, { body });
      expect(same.status).toBe(200);
      expect(same.body.comment.body).toBe(body);
      expect(same.body.comment.editedAt).toBeNull();
      expect((await member.patch(`/comments/${c.id}`, { body: '   ' })).status).toBe(400);
    });

    it('forbids editing someone else’s comment, even for admins', async () => {
      const c = (await member.post(`/tasks/${task.id}/comments`, { body: 'mine' })).body.comment;
      expect((await admin.patch(`/comments/${c.id}`, { body: 'hijacked' })).status).toBe(403);
    });

    it('does not let an edit turn a note into a comment or back', async () => {
      const c = (await member.post(`/tasks/${task.id}/comments`, { body: 'note', internal: true })).body.comment;
      expect((await member.patch(`/comments/${c.id}`, { body: 'note', internal: false })).status).toBe(400);
      expect((await timeline())[0].comment.internal).toBe(true);
    });
  });

  describe('deleting', () => {
    it('soft-deletes: the timeline keeps a deleted entry without its body', async () => {
      const c = (await member.post(`/tasks/${task.id}/comments`, { body: 'oops' })).body.comment;
      expect((await member.delete(`/comments/${c.id}`)).status).toBe(204);
      const [item] = await timeline();
      expect(item.comment).toMatchObject({ id: c.id, body: '', attachments: [] });
      expect(item.comment.deletedAt).not.toBeNull();
      expect((await member.patch(`/comments/${c.id}`, { body: 'back' })).status).toBe(404);
    });

    it('forbids members from deleting other people’s comments, but admins may', async () => {
      const c = (await admin.post(`/tasks/${task.id}/comments`, { body: 'admin says' })).body.comment;
      expect((await member.delete(`/comments/${c.id}`)).status).toBe(403);
      const m = (await member.post(`/tasks/${task.id}/comments`, { body: 'member says' })).body.comment;
      expect((await admin.delete(`/comments/${m.id}`)).status).toBe(204);
    });
  });

  describe('attachments', () => {
    it('attaches files to a comment and serves images inline', async () => {
      const res = await upload(member, task.id, 'see screenshot', [
        { name: 'shot.png', type: 'image/png', data: PNG },
        { name: 'build.log', type: 'text/plain', data: 'line 1\nline 2' },
      ]);
      expect(res.status).toBe(201);
      const [image, log] = res.body.comment.attachments;
      expect(image).toMatchObject({ filename: 'shot.png', contentType: 'image/png', size: PNG.length });
      expect(log).toMatchObject({ filename: 'build.log', contentType: 'text/plain', size: 13 });

      const img = await member.get(image.url.replace('/api/v1', ''));
      expect(img.status).toBe(200);
      expect(img.headers.get('content-type')).toBe('image/png');
      expect(img.headers.get('content-disposition')).toMatch(/^inline/);
      expect(Buffer.from(img.body as ArrayBuffer).equals(PNG)).toBe(true);

      const text = await member.get(log.url.replace('/api/v1', ''));
      expect(text.headers.get('content-disposition')).toMatch(/^attachment; filename="build.log"/);
      expect(text.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(text.body as ArrayBuffer).toString()).toBe('line 1\nline 2');
    });

    it('accepts an attachment-only comment and internal notes over multipart', async () => {
      const res = await upload(member, task.id, '', [{ name: 'a.png', type: 'image/png', data: PNG }], true);
      expect(res.status).toBe(201);
      expect(res.body.comment).toMatchObject({ body: '', internal: true });
    });

    it('never renders SVG inline', async () => {
      const res = await upload(member, task.id, 'svg', [{ name: 'x.svg', type: 'image/svg+xml', data: '<svg/>' }]);
      const svg = await member.get(res.body.comment.attachments[0].url.replace('/api/v1', ''));
      expect(svg.headers.get('content-disposition')).toMatch(/^attachment/);
      expect(svg.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('requires an authenticated user to download', async () => {
      const res = await upload(member, task.id, 'secret', [{ name: 'a.png', type: 'image/png', data: PNG }]);
      const anonymous = await app.client().get(res.body.comment.attachments[0].url.replace('/api/v1', ''));
      expect(anonymous.status).toBe(401);
    });

    it('rejects files over 25 MB and creates no comment', async () => {
      const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 1);
      const res = await upload(member, task.id, 'too big', [{ name: 'big.bin', type: 'application/octet-stream', data: big }]);
      expect(res.status).toBe(413);
      expect(await timeline()).toEqual([]);
    });

    it('rejects more than 10 files per comment', async () => {
      const files = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', data: 'x' }));
      const res = await upload(member, task.id, 'many', files);
      expect(res.status).toBe(413);
      expect(await timeline()).toEqual([]);
    });

    it('lists every file of the task, newest first, with its author or the description', async () => {
      const form = new FormData();
      form.append('files', new Blob(['spec'], { type: 'text/plain' }), 'spec.txt');
      const description = await member.request('POST', `/tasks/${task.id}/attachments`, { form });
      expect(description.status).toBe(201);
      // The description file is older than the Comment's one.
      await app.server.ctx.db.execute(sql`update attachments set created_at = now() - interval '2 days' where id = ${description.body.attachments[0].id}::uuid`);
      const comment = (await upload(admin, task.id, 'see the shot', [{ name: 'shot.png', type: 'image/png', data: PNG }])).body.comment;

      const res = await member.get(`/tasks/${task.id}/attachments`);
      expect(res.status).toBe(200);
      expect(res.body.attachments.map((a: { filename: string; author: { displayName: string } | null }) => [a.filename, a.author?.displayName ?? null])).toEqual([
        ['shot.png', 'Ada Admin'],
        ['spec.txt', null],
      ]);
      expect(res.body.attachments[0]).toMatchObject({ commentId: comment.id, contentType: 'image/png', size: PNG.length });
      expect(res.body.attachments[1]).toMatchObject({ commentId: null, contentType: 'text/plain', size: 4 });

      await admin.delete(`/comments/${comment.id}`);
      expect((await member.get(`/tasks/${task.id}/attachments`)).body.attachments.map((a: { filename: string }) => a.filename)).toEqual(['spec.txt']);
    });

    it('answers 404 for the attachments of a missing task', async () => {
      expect((await member.get('/tasks/00000000-0000-4000-8000-000000000000/attachments')).status).toBe(404);
    });

    it('stops serving attachments of a deleted comment', async () => {
      const res = await upload(member, task.id, 'temp', [{ name: 'a.png', type: 'image/png', data: PNG }]);
      const url = res.body.comment.attachments[0].url.replace('/api/v1', '');
      await member.delete(`/comments/${res.body.comment.id}`);
      expect((await member.get(url)).status).toBe(404);
    });

    it('strips paths from uploaded filenames', async () => {
      const res = await upload(member, task.id, 'x', [{ name: '../../etc/passwd', type: 'text/plain', data: 'x' }]);
      expect(res.body.comment.attachments[0].filename).toBe('passwd');
    });

    it('serves a file whose 255-character name would cut an emoji in half', async () => {
      // 254 ASCII characters put an emoji right at the truncation point.
      const filename = `${'a'.repeat(254)}😀png`;
      const form = new FormData();
      form.append('files', new Blob(['x'], { type: 'text/plain' }), filename);
      const res = await member.request('POST', `/tasks/${task.id}/attachments`, { form });
      expect(res.status).toBe(201);
      const attachment = res.body.attachments[0];
      expect(attachment.filename.endsWith('😀')).toBe(true);

      const download = await member.get(attachment.url.replace('/api/v1', ''));
      expect(download.status).toBe(200);
    });

    it('never keeps a dot-only filename, which would name a directory in the Worktree', async () => {
      for (const name of ['..', '.', 'a/..', ' .. ']) {
        const res = await upload(member, task.id, 'x', [{ name, type: 'text/plain', data: 'x' }]);
        expect(res.status).toBe(201);
        expect(res.body.comment.attachments[0].filename).toBe('file');
      }
    });
  });
});
