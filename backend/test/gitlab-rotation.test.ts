// GitLab tokens saved from the UI are rotated before they expire, one rotation at a time
// (rotating an already-revoked token makes GitLab revoke the whole token family).
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { gitConnections } from '../src/db/schema';
import { cachedProviderFactory, rotateExpiringTokens } from '../src/git/connections';
import { useTestApp } from './helpers/app';
import { startFakeGitLab } from './helpers/fake-gitlab';
import type { GitLabOverride } from './helpers/fake-gitlab';

const day = (offset: number) => new Date(Date.now() + offset * 24 * 3600000).toISOString().slice(0, 10);

describe('GitLab token rotation', () => {
  const app = useTestApp({ git: cachedProviderFactory(), config: { github: null } });
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    app.server.ctx.config.gitlab = null;
    await stop?.();
    stop = undefined;
  });
  async function connection(override?: GitLabOverride, expiresInDays = 5) {
    const gitlab = await startFakeGitLab(override);
    stop = gitlab.close;
    gitlab.state.tokens.get('glpat-valid')!.expires_at = day(expiresInDays);
    const admin = await app.admin();
    const created = await admin.post('/git/connections', { provider: 'gitlab', name: 'GitLab', baseUrl: gitlab.url, token: 'glpat-valid' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const find = async () => (await admin.get('/git/connections')).body.connections.find((c: { id: string }) => c.id === created.body.connection.id);
    return { gitlab, admin, connection: created.body.connection, find };
  }

  it('rotates tokens expiring within 14 days exactly once under concurrency, and keeps working with the new token', async () => {
    const { gitlab, connection: created, find } = await connection();
    expect(created.health).toEqual({ state: 'ok' });
    await Promise.all([rotateExpiringTokens(app.server.ctx), rotateExpiringTokens(app.server.ctx)]);
    expect(gitlab.state.rotations).toBe(1);
    expect(gitlab.requests.find((r) => r.path === '/personal_access_tokens/self/rotate')!.body).toEqual({ expires_at: day(90) });
    const rotated = await find();
    expect(rotated).toMatchObject({ secretLast4: 'ed-1', health: { state: 'ok' }, expiresAt: `${day(90)}T00:00:00.000Z` });
    expect(gitlab.requests.at(-1)!.token).toBe('glpat-rotated-1');
    await rotateExpiringTokens(app.server.ctx);
    expect(gitlab.state.rotations).toBe(1);
  });

  it('keeps the token an admin saves while a rotation is in flight, and renaming keeps the token details', async () => {
    const { gitlab, admin, connection: created, find } = await connection();
    gitlab.state.tokens.set('glpat-admin-chosen-0042', { scopes: ['api', 'write_repository'], expires_at: day(200), revoked: false });
    const renamed = await admin.patch(`/git/connections/${created.id}`, { name: 'GitLab EU' });
    expect(renamed.body.connection).toMatchObject({ name: 'GitLab EU', expiresAt: created.expiresAt, access: created.access });

    // A rotation holds the connection's lock and is about to store its token.
    const { db, config } = app.server.ctx;
    let saved!: Promise<{ status: number }>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-connection:${created.id}`}))`);
      saved = admin.patch(`/git/connections/${created.id}`, { token: 'glpat-admin-chosen-0042' });
      await new Promise((r) => setTimeout(r, 300));
      await tx.update(gitConnections).set({ secretCiphertext: config.secrets.encrypt('glpat-rotated-9'), secretLast4: 'ed-9' }).where(eq(gitConnections.id, created.id));
    });
    expect((await saved).status).toBe(200);
    expect((await find()).secretLast4).toBe('0042');
  });

  it('leaves tokens with a distant expiry alone', async () => {
    const { gitlab } = await connection(undefined, 60);
    await rotateExpiringTokens(app.server.ctx);
    expect(gitlab.state.rotations).toBe(0);
  });

  it('falls back to the default expiry when the instance caps token lifetimes', async () => {
    const { gitlab, find } = await connection((r) =>
      r.path === '/personal_access_tokens/self/rotate' && r.body?.expires_at ? { status: 400, body: { message: 'expiry too far' } } : undefined,
    );
    await rotateExpiringTokens(app.server.ctx);
    expect(gitlab.state.rotations).toBe(1);
    expect((await find()).health).toEqual({ state: 'ok' });
  });

  it('shows a failed rotation as an expiry warning', async () => {
    const { find } = await connection((r) => (r.path === '/personal_access_tokens/self/rotate' ? { status: 500, body: { message: 'boom' } } : undefined));
    await rotateExpiringTokens(app.server.ctx);
    expect((await find()).health).toMatchObject({ state: 'expiring', message: expect.stringContaining('automatic rotation failed') });
  });

  it('warns about expiring environment tokens and never rotates them', async () => {
    const gitlab = await startFakeGitLab();
    stop = gitlab.close;
    gitlab.state.tokens.get('glpat-valid')!.expires_at = day(3);
    app.server.ctx.config.gitlab = { baseUrl: gitlab.url, token: 'glpat-valid' };
    await rotateExpiringTokens(app.server.ctx);
    expect(gitlab.state.rotations).toBe(0);
    const env = (await (await app.admin()).get('/git/connections')).body.connections.find((c: { id: string }) => c.id === 'env-gitlab');
    expect(env).toMatchObject({ source: 'environment', health: { state: 'expiring', message: expect.stringContaining('GITLAB_TOKEN') } });
  });
});
