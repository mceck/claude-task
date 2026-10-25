import { describe, expect, it } from 'vitest';
import { ADMIN, useTestApp } from './helpers/app';
import { createUser } from './helpers/fixtures';
import { WsTestClient } from './helpers/ws';

describe('auth', () => {
  const app = useTestApp();

  it('lets the admin bootstrapped from ADMIN_EMAIL/ADMIN_PASSWORD log in', async () => {
    const client = app.client();
    const res = await client.post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: ADMIN.email, role: 'admin', mustChangePassword: false });

    const me = await client.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(ADMIN.email);
  });

  it('sets an httpOnly SameSite=Lax session cookie', async () => {
    const res = await app.client().post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('ct_login='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it('re-sends the cookie when activity extends the login, so it outlives 30 days of use', async () => {
    const client = await app.admin();
    // Time travel: pretend the last activity was two minutes ago (writes are throttled to once a minute).
    await app.server.ctx.db.$client.query(`update logins set last_seen_at = now() - interval '2 minutes'`);
    const res = await client.get('/auth/me');
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('ct_login='));
    expect(cookie).toMatch(/Max-Age=2592000/);
    // Within the throttle window nothing is re-sent.
    const again = await client.get('/auth/me');
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it('matches emails case-insensitively', async () => {
    const res = await app.client().post('/auth/login', { email: 'ADMIN@Example.com', password: ADMIN.password });
    expect(res.status).toBe(200);
  });

  it('rejects wrong passwords and unknown emails with the same error', async () => {
    const wrong = await app.client().post('/auth/login', { email: ADMIN.email, password: 'nope-nope' });
    const unknown = await app.client().post('/auth/login', { email: 'who@example.com', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('requires a session for the API', async () => {
    const res = await app.client().get('/projects');
    expect(res.status).toBe(401);
  });

  it('refuses mutating requests without the CSRF header', async () => {
    const client = await app.admin();
    const res = await client.post('/projects', { key: 'CSRF', name: 'x' }, { csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf');

    const login = await app.client().post('/auth/login', { email: ADMIN.email, password: ADMIN.password }, { csrf: false });
    expect(login.status).toBe(403);
  });

  it('logs out, ending the session', async () => {
    const client = await app.admin();
    const cookie = client.cookie;
    expect((await client.post('/auth/logout')).status).toBe(204);
    expect(client.cookie).toBeNull();

    const stale = app.client();
    stale.cookie = cookie;
    expect((await stale.get('/auth/me')).status).toBe(401);
  });

  it('closes the live connection of a session that logs out', async () => {
    const client = await app.admin();
    const ws = await WsTestClient.connect(app.url, client.cookie);
    await client.post('/auth/logout');
    expect((await ws.closed).code).toBe(4001);
  });

  describe('changing your password', () => {
    it('needs the current password', async () => {
      const client = await app.admin();
      const res = await client.post('/auth/password', { currentPassword: 'wrong-one', newPassword: 'brand-new-pass' });
      expect(res.status).toBe(400);
    });

    it('rejects passwords shorter than 8 characters', async () => {
      const client = await app.admin();
      const res = await client.post('/auth/password', { currentPassword: ADMIN.password, newPassword: 'short' });
      expect(res.status).toBe(400);
    });

    it('takes effect for the next login and logs out other sessions', async () => {
      const here = await app.admin();
      const elsewhere = await app.admin();
      const res = await here.post('/auth/password', { currentPassword: ADMIN.password, newPassword: 'brand-new-pass' });
      expect(res.status).toBe(200);

      expect((await here.get('/auth/me')).status).toBe(200);
      expect((await elsewhere.get('/auth/me')).status).toBe(401);
      expect((await app.client().post('/auth/login', { email: ADMIN.email, password: ADMIN.password })).status).toBe(401);
      expect((await app.client().post('/auth/login', { email: ADMIN.email, password: 'brand-new-pass' })).status).toBe(200);
    });
  });

  describe('temporary passwords', () => {
    it('forces new users to change their password before anything else', async () => {
      const admin = await app.admin();
      const created = await admin.post('/users', { email: 'new@example.com', displayName: 'New Person' });
      expect(created.status).toBe(201);
      const { temporaryPassword } = created.body;

      const client = app.client();
      const login = await client.post('/auth/login', { email: 'new@example.com', password: temporaryPassword });
      expect(login.status).toBe(200);
      expect(login.body.user.mustChangePassword).toBe(true);

      // Only "me", change-password and logout work.
      expect((await client.get('/auth/me')).status).toBe(200);
      const blocked = await client.get('/projects');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('password_change_required');
      expect((await client.post('/projects', { key: 'NOPE', name: 'x' })).status).toBe(403);
      await expect(WsTestClient.connect(app.url, client.cookie)).rejects.toThrow(/403/);

      const sameAgain = await client.post('/auth/password', { currentPassword: temporaryPassword, newPassword: temporaryPassword });
      expect(sameAgain.status).toBe(400);

      const changed = await client.post('/auth/password', { currentPassword: temporaryPassword, newPassword: 'my-own-password' });
      expect(changed.status).toBe(200);
      expect(changed.body.user.mustChangePassword).toBe(false);
      expect((await client.get('/projects')).status).toBe(200);
    });
  });

  it('keeps users of other sessions working when one logs out', async () => {
    const admin = await app.admin();
    const { client: a } = await createUser(app, admin);
    const second = app.client();
    second.cookie = a.cookie;
    await a.post('/auth/logout');
    expect((await second.get('/auth/me')).status).toBe(401);
    expect((await admin.get('/auth/me')).status).toBe(200);
  });
});

describe('login rate limiting', () => {
  // The limiter lives in the app's memory, so each case gets its own app.
  const limited = () =>
    useTestApp({ config: { loginRateLimit: { max: 10, windowMs: 15 * 60 * 1000 }, trustProxy: true } });
  const attempt = (app: ReturnType<typeof limited>, email: string, password: string, ip: string) =>
    app.client().post('/auth/login', { email, password }, { headers: { 'x-forwarded-for': ip } });

  describe('per email', () => {
    const app = limited();

    it('blocks an email after 10 failed attempts, even from other IPs and with the right password', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await attempt(app, ADMIN.email, 'wrong-password', `10.0.0.${i}`)).status).toBe(401);
      }
      const blocked = await attempt(app, ADMIN.email, ADMIN.password, '10.0.1.1');
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    });
  });

  describe('per IP', () => {
    const app = limited();

    it('blocks an IP after 10 failed attempts, even for other emails', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await attempt(app, `nobody${i}@example.com`, 'wrong-password', '10.0.2.1')).status).toBe(401);
      }
      expect((await attempt(app, ADMIN.email, ADMIN.password, '10.0.2.1')).status).toBe(429);
      expect((await attempt(app, ADMIN.email, ADMIN.password, '10.0.2.2')).status).toBe(200);
    });
  });
});
