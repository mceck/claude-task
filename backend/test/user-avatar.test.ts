import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { createUser } from './helpers/fixtures';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function upload(client: ApiClient, id: string, data: Buffer | string = PNG, type = 'image/png') {
  const form = new FormData();
  form.set('file', new Blob([data], { type }), 'photo.png');
  return client.request('PUT', `/users/${id}/avatar`, { form });
}

describe('User avatars', () => {
  const app = useTestApp();

  it('lets a Member set their photo, exposes it in User responses and serves it to signed-in Users', async () => {
    const admin = await app.admin();
    const { user, client } = await createUser(app, admin);
    expect(user.avatarImageUrl).toBeNull();
    const result = await upload(client, user.id);
    expect(result.status).toBe(200);
    const url: string = result.body.user.avatarImageUrl;
    expect(url).toContain(`/users/${user.id}/avatar?v=`);
    expect((await client.get('/auth/me')).body.user.avatarImageUrl).toBe(url);
    expect((await admin.get('/users')).body.users.find((u: { id: string }) => u.id === user.id).avatarImageUrl).toBe(url);
    const image = await admin.get(url.replace('/api/v1', ''));
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('cache-control')).toContain('private');
    expect(Buffer.from(image.body as ArrayBuffer).equals(PNG)).toBe(true);
    expect((await app.client().get(url.replace('/api/v1', ''))).status).toBe(401);
    expect((await client.get('/auth/me')).status).toBe(200);
  });

  it('lets Admins replace and remove a photo, changing the URL and restoring initials metadata', async () => {
    const admin = await app.admin();
    const { user, client } = await createUser(app, admin);
    const first = (await upload(client, user.id)).body.user.avatarImageUrl;
    const second = await upload(admin, user.id);
    expect(second.status).toBe(200);
    expect(second.body.user.avatarImageUrl).not.toBe(first);
    expect((await admin.delete(`/users/${user.id}/avatar`)).body.user.avatarImageUrl).toBeNull();
    expect((await client.get(`/users/${user.id}/avatar`)).status).toBe(404);
    expect((await client.delete(`/users/${user.id}/avatar`)).status).toBe(200);
  });

  it('restricts changes to the User and Admins and applies authentication and CSRF checks', async () => {
    const admin = await app.admin();
    const { user, client } = await createUser(app, admin);
    const other = await createUser(app, admin);
    expect((await upload(other.client, user.id)).status).toBe(403);
    expect((await other.client.delete(`/users/${user.id}/avatar`)).status).toBe(403);
    expect((await upload(app.client(), user.id)).status).toBe(401);
    expect((await client.delete(`/users/${user.id}/avatar`, { csrf: false })).status).toBe(403);
    expect((await client.get('/auth/me')).body.user.avatarImageUrl).toBeNull();
  });

  it('rejects unsupported, oversized, missing and multiple files while preserving the previous photo', async () => {
    const admin = await app.admin();
    const { user, client } = await createUser(app, admin);
    const url = (await upload(client, user.id)).body.user.avatarImageUrl;
    expect((await upload(client, user.id, '<svg/>', 'image/svg+xml')).status).toBe(400);
    expect((await upload(client, user.id, Buffer.alloc(2 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await client.put(`/users/${user.id}/avatar`, {})).status).toBe(400);
    const missing = new FormData();
    missing.set('name', 'photo');
    expect((await client.request('PUT', `/users/${user.id}/avatar`, { form: missing })).status).toBe(400);
    const multiple = new FormData();
    multiple.append('file', new Blob([PNG], { type: 'image/png' }), 'one.png');
    multiple.append('file', new Blob([PNG], { type: 'image/png' }), 'two.png');
    expect((await client.request('PUT', `/users/${user.id}/avatar`, { form: multiple })).status).toBe(413);
    expect((await client.get('/auth/me')).body.user.avatarImageUrl).toBe(url);
  });
});
