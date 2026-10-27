import { describe, expect, it } from 'vitest';
import { PROJECT_LOGO_MAX_BYTES } from '@claude-task/shared';
import { eq } from 'drizzle-orm';
import { projects } from '../src/db/schema';
import { useTestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { createProject, createUser } from './helpers/fixtures';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function upload(client: ApiClient, id: string, bytes = PNG, type = 'image/png') {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type }), 'logo.png');
  return client.request('PUT', `/projects/${id}/logo`, { form });
}

describe('project logos', () => {
  const app = useTestApp();

  it('lets members upload, read, replace and remove logos, including by project key', async () => {
    const admin = await app.admin();
    const member = (await createUser(app, admin)).client;
    const { project } = await createProject(member, { key: 'LOGO' });
    expect(project.logoUrl).toBeNull();
    expect((await member.get('/projects/LOGO/logo')).status).toBe(404);

    const first = await upload(member, 'logo');
    expect(first.status).toBe(200);
    const url: string = first.body.project.logoUrl;
    expect(url).toContain(`/projects/${project.id}/logo?v=`);
    const image = await admin.get(url.replace('/api/v1', ''));
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(image.body as ArrayBuffer)).toEqual(PNG);
    expect((await member.get(`/projects/${project.id}`)).body.project.logoUrl).toBe(url);
    expect((await member.get('/projects')).body.projects[0].logoUrl).toBe(url);

    const second = await upload(member, project.id);
    expect(second.body.project.logoUrl).not.toBe(url);
    expect((await member.delete('/projects/LOGO/logo')).body.project.logoUrl).toBeNull();
    expect((await member.get(`/projects/${project.id}/logo`)).status).toBe(404);
    expect((await member.delete('/projects/LOGO/logo')).status).toBe(200);
  });

  it('keeps the current logo when the upload is unsupported, empty, missing or too large', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const url = (await upload(admin, project.id)).body.project.logoUrl;
    expect((await upload(admin, project.id, Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(400);
    expect((await upload(admin, project.id, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(admin, project.id, Buffer.alloc(PROJECT_LOGO_MAX_BYTES + 1, 1))).status).toBe(413);
    expect((await admin.put(`/projects/${project.id}/logo`, {})).status).toBe(400);
    const form = new FormData();
    form.set('name', 'no file');
    expect((await admin.request('PUT', `/projects/${project.id}/logo`, { form })).status).toBe(400);
    const multiple = new FormData();
    multiple.append('file', new Blob([PNG], { type: 'image/png' }), 'one.png');
    multiple.append('file', new Blob([PNG], { type: 'image/png' }), 'two.png');
    expect((await admin.request('PUT', `/projects/${project.id}/logo`, { form: multiple })).status).toBe(413);
    expect((await admin.get(`/projects/${project.id}`)).body.project.logoUrl).toBe(url);
  });

  it('requires a Login and a project of the ordinary kind', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    expect((await upload(app.client(), project.id)).status).toBe(401);
    expect((await app.client().get(`/projects/${project.id}/logo`)).status).toBe(401);
    expect((await app.client().delete(`/projects/${project.id}/logo`)).status).toBe(401);
    expect((await upload(admin, 'MISSING')).status).toBe(404);
    await app.server.ctx.db.update(projects).set({ kind: 'wiki' }).where(eq(projects.id, project.id));
    expect((await upload(admin, project.id)).status).toBe(404);
    expect((await admin.delete(`/projects/${project.id}/logo`)).status).toBe(404);
  });

  it('deletes stored logos after replacement, removal and permanent project deletion', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const blobId = (url: string) => url.split('?v=')[1]!;
    const isDeleted = async (id: string) => {
      const blob = await app.server.ctx.blobs.get(id);
      // Cleanup can remove the file between reading its metadata and opening it.
      blob?.stream.on('error', () => {}).destroy();
      return blob === null;
    };
    const first = blobId((await upload(admin, project.id)).body.project.logoUrl);
    const second = blobId((await upload(admin, project.id)).body.project.logoUrl);
    await expect.poll(() => isDeleted(first)).toBe(true);
    await admin.delete(`/projects/${project.id}/logo`);
    await expect.poll(() => isDeleted(second)).toBe(true);
    const third = blobId((await upload(admin, project.id)).body.project.logoUrl);
    await admin.post(`/projects/${project.id}/archive`);
    expect((await admin.get(`/projects/${project.id}/logo`)).status).toBe(200);
    await admin.delete(`/projects/${project.id}`);
    await expect.poll(() => isDeleted(third)).toBe(true);
  });
});
