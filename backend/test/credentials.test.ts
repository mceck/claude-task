import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadConfig } from '../src/config';
import { useTestApp } from './helpers/app';
import { createAgent, createCredential, createUser } from './helpers/fixtures';

describe('credentials', () => {
  const app = useTestApp();

  it('never returns the secret, only its last 4 characters', async () => {
    const admin = await app.admin();
    const created = await createCredential(admin, { name: 'Team token', secret: 'sk-ant-oat01-very-secret-WXYZ' });
    expect(created).toMatchObject({ name: 'Team token', kind: 'claude_oauth_token', last4: 'WXYZ', usedBy: [] });

    const responses = [await admin.get('/credentials'), await admin.get(`/credentials/${created.id}`)];
    for (const res of responses) expect(JSON.stringify(res.body)).not.toContain('very-secret');
  });

  it('stores secrets encrypted at rest', async () => {
    const admin = await app.admin();
    await createCredential(admin, { secret: 'sk-ant-api03-plaintext-check-0001' });
    const db = new pg.Client({ connectionString: app.server.ctx.config.databaseUrl });
    await db.connect();
    const { rows } = await db.query('select * from credentials');
    await db.end();
    expect(JSON.stringify(rows)).not.toContain('plaintext-check');
  });

  it('rotates the secret in place, keeping the agents that use it', async () => {
    const admin = await app.admin();
    const credential = await createCredential(admin);
    const { agent } = await createAgent(app, admin, { credentialId: credential.id, connect: false });
    const res = await admin.patch(`/credentials/${credential.id}`, { secret: 'sk-ant-oat01-rotated-ABCD' });
    expect(res.status).toBe(200);
    expect(res.body.credential).toMatchObject({ id: credential.id, last4: 'ABCD', usedBy: [{ id: agent.id, name: agent.name }] });
  });

  it('refuses to delete a credential in use', async () => {
    const admin = await app.admin();
    const used = await createCredential(admin);
    const { agent } = await createAgent(app, admin, { credentialId: used.id, connect: false });
    const res = await admin.delete(`/credentials/${used.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain(agent.name);

    const unused = await createCredential(admin);
    expect((await admin.delete(`/credentials/${unused.id}`)).status).toBe(204);
  });

  it('is admin-only', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const credential = await createCredential(admin);
    const attempts = [
      member.get('/credentials'),
      member.post('/credentials', { name: 'x', kind: 'anthropic_api_key', secret: 'sk-ant-12345678' }),
      member.patch(`/credentials/${credential.id}`, { secret: 'sk-ant-12345678' }),
      member.delete(`/credentials/${credential.id}`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
  });
});

describe('SECRETS_MASTER_KEY', () => {
  it('is required to start the backend', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y' })).toThrow(/SECRETS_MASTER_KEY/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y', SECRETS_MASTER_KEY: Buffer.alloc(32).toString('base64') })).not.toThrow();
  });
});
