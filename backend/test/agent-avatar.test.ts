import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { createAgent, createUser } from './helpers/fixtures';

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function putAvatar(client: ApiClient, agentId: string, data: Buffer | string, type = 'image/png') {
  const form = new FormData();
  form.set('file', new Blob([data], { type }), 'me.png');
  return client.request('PUT', `/agents/${agentId}/avatar`, { form });
}

describe('agent avatar image', () => {
  const app = useTestApp();

  it('uploads an image, serves it to any user and replaces it', async () => {
    const admin = await app.admin();
    const member = (await createUser(app, admin)).client;
    const { agent } = await createAgent(app, admin, { connect: false });
    expect(agent.avatarImageUrl).toBeNull();

    const res = await putAvatar(admin, agent.id, PNG);
    expect(res.status).toBe(200);
    const url: string = res.body.agent.avatarImageUrl;
    expect(url).toContain(`/agents/${agent.id}/avatar?v=`);

    const img = await member.get(url.replace('/api/v1', ''));
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(img.body as ArrayBuffer).equals(PNG)).toBe(true);
    expect((await admin.get('/agents')).body.agents.find((a: { id: string }) => a.id === agent.id).avatarImageUrl).toBe(url);

    const second = (await putAvatar(admin, agent.id, PNG)).body.agent.avatarImageUrl;
    expect(second).not.toBe(url);
  });

  it('removes the image and falls back to emoji and color', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    await putAvatar(admin, agent.id, PNG);
    const res = await admin.delete(`/agents/${agent.id}/avatar`);
    expect(res.status).toBe(200);
    expect(res.body.agent.avatarImageUrl).toBeNull();
    expect((await admin.get(`/agents/${agent.id}/avatar`)).status).toBe(404);
  });

  it('only accepts safe raster images from admins', async () => {
    const admin = await app.admin();
    const member = (await createUser(app, admin)).client;
    const { agent } = await createAgent(app, admin, { connect: false });
    expect((await putAvatar(admin, agent.id, '<svg/>', 'image/svg+xml')).status).toBe(400);
    expect((await putAvatar(admin, agent.id, Buffer.alloc(2 * 1024 * 1024 + 1, 1))).status).toBe(413);
    expect((await putAvatar(member, agent.id, PNG)).status).toBe(403);
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.avatarImageUrl).toBeNull();
  });

  it('gives a duplicated agent its own copy of the image', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    await putAvatar(admin, agent.id, PNG);
    const copy = (await admin.post(`/agents/${agent.id}/duplicate`, {})).body.agent;
    await app.settle();
    expect(copy.avatarImageUrl).toContain(`/agents/${copy.id}/avatar`);
    await admin.delete(`/agents/${agent.id}/avatar`);
    const img = await admin.get(copy.avatarImageUrl.replace('/api/v1', ''));
    expect(Buffer.from(img.body as ArrayBuffer).equals(PNG)).toBe(true);
    // End on a JSON response: closing the server right after a streamed one waits for the keep-alive socket.
    expect((await admin.get(`/agents/${copy.id}`)).status).toBe(200);
  });
});
