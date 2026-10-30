import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ADMIN, useTestApp } from './helpers/app';
import { createProject, createUser } from './helpers/fixtures';
import { WsTestClient } from './helpers/ws';

const run = promisify(execFile);

describe('user management', () => {
  const app = useTestApp();

  it('lets an admin create a user with a generated temporary password', async () => {
    const admin = await app.admin();
    const res = await admin.post('/users', { email: 'sam@example.com', displayName: 'Sam', role: 'member' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'sam@example.com', role: 'member', active: true, mustChangePassword: true });
    expect(res.body.temporaryPassword).toEqual(expect.any(String));
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('accepts a temporary password chosen by the admin', async () => {
    const admin = await app.admin();
    await admin.post('/users', { email: 'kim@example.com', displayName: 'Kim', temporaryPassword: 'chosen-temp-1' });
    expect((await app.client().post('/auth/login', { email: 'kim@example.com', password: 'chosen-temp-1' })).status).toBe(200);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const admin = await app.admin();
    await admin.post('/users', { email: 'dup@example.com', displayName: 'One' });
    const res = await admin.post('/users', { email: 'DUP@example.com', displayName: 'Two' });
    expect(res.status).toBe(409);
  });

  it('lets everyone list team members', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin, { displayName: 'Mo' });
    const res = await member.get('/users');
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: { displayName: string }) => u.displayName).sort()).toEqual([ADMIN.displayName, 'Mo']);
  });

  it('returns 403 to members for user management and permanent project deletion', async () => {
    const admin = await app.admin();
    const { client: member, user } = await createUser(app, admin);
    const { project } = await createProject(member);
    await member.post(`/projects/${project.id}/archive`);

    const attempts = [
      member.post('/users', { email: 'x@example.com', displayName: 'X' }),
      member.patch(`/users/${user.id}`, { role: 'admin' }),
      member.post(`/users/${user.id}/reset-password`),
      member.delete(`/projects/${project.id}`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
    expect((await member.get('/auth/me')).body.user.role).toBe('member');
  });

  it('lets an admin promote a member to admin', async () => {
    const admin = await app.admin();
    const { client: member, user } = await createUser(app, admin);
    const res = await admin.patch(`/users/${user.id}`, { role: 'admin' });
    expect(res.body.user.role).toBe('admin');
    expect((await member.post('/users', { email: 'z@example.com', displayName: 'Z' })).status).toBe(201);
  });

  it('logs a deactivated user out everywhere and blocks their login', async () => {
    const admin = await app.admin();
    const { client: member, user, password } = await createUser(app, admin);
    const ws = await WsTestClient.connect(app.url, member.cookie);

    const res = await admin.patch(`/users/${user.id}`, { active: false });
    expect(res.status).toBe(200);
    expect(res.body.user.active).toBe(false);

    expect((await member.get('/auth/me')).status).toBe(401);
    expect((await ws.closed).code).toBe(4001);
    const login = await app.client().post('/auth/login', { email: user.email, password });
    expect(login.status).toBe(401);
  });

  it('keeps a deactivated user on the team list and their history', async () => {
    const admin = await app.admin();
    const { client: member, user } = await createUser(app, admin, { displayName: 'Leaver' });
    const { project } = await createProject(member);
    const task = (await member.post(`/projects/${project.id}/tasks`, { title: 'Theirs' })).body.task;
    await member.post(`/tasks/${task.id}/comments`, { body: 'bye' });
    await admin.patch(`/users/${user.id}`, { active: false });

    const list = await admin.get('/users');
    expect(list.body.users.find((u: { id: string }) => u.id === user.id).active).toBe(false);
    const timeline = await admin.get(`/tasks/${task.id}/timeline`);
    expect(timeline.body.items[0].comment.author).toMatchObject({ type: 'user', id: user.id, displayName: 'Leaver' });
    expect((await admin.get(`/tasks/${task.id}`)).body.task.createdBy.displayName).toBe('Leaver');
  });

  it('lets a reactivated user log in again', async () => {
    const admin = await app.admin();
    const { user, password } = await createUser(app, admin);
    await admin.patch(`/users/${user.id}`, { active: false });
    await admin.patch(`/users/${user.id}`, { active: true });
    expect((await app.client().post('/auth/login', { email: user.email, password })).status).toBe(200);
  });

  it('resets a password to a new temporary one and ends the user’s sessions', async () => {
    const admin = await app.admin();
    const { client: member, user, password } = await createUser(app, admin);
    const res = await admin.post(`/users/${user.id}/reset-password`);
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);

    expect((await member.get('/auth/me')).status).toBe(401);
    expect((await app.client().post('/auth/login', { email: user.email, password })).status).toBe(401);
    const fresh = app.client();
    await fresh.login(user.email, res.body.temporaryPassword);
    expect((await fresh.get('/projects')).body.error.code).toBe('password_change_required');
  });

  it('never leaves the team without an active admin', async () => {
    const admin = await app.admin();
    const me = (await admin.get('/auth/me')).body.user;
    expect((await admin.patch(`/users/${me.id}`, { role: 'member' })).status).toBe(400);
    expect((await admin.patch(`/users/${me.id}`, { active: false })).status).toBe(400);

    const { user: other } = await createUser(app, admin, { role: 'admin' });
    expect((await admin.patch(`/users/${other.id}`, { active: false })).status).toBe(200);
    expect((await admin.patch(`/users/${me.id}`, { role: 'member' })).status).toBe(400);
  });

  it('handles concurrent demotions without errors or losing the last admin', async () => {
    const admin = await app.admin();
    const { user: b } = await createUser(app, admin, { role: 'admin' });
    const { user: c } = await createUser(app, admin, { role: 'admin' });
    const me = (await admin.get('/auth/me')).body.user;
    const results = await Promise.all([b, c, me].map((u) => admin.patch(`/users/${u.id}`, { role: 'member' })));
    // Exactly one admin must remain, and every request gets a clean answer.
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 400]);
    const { users } = (await admin.get('/users')).body;
    expect(users.filter((u: { role: string; active: boolean }) => u.role === 'admin' && u.active)).toHaveLength(1);
  });

  it('returns 404 for an unknown user', async () => {
    const admin = await app.admin();
    const res = await admin.patch('/users/00000000-0000-4000-8000-000000000000', { displayName: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('first boot without ADMIN_EMAIL', () => {
  const app = useTestApp({ config: { bootstrapAdmin: null } });
  const cli = path.resolve(import.meta.dirname, '../src/cli.ts');
  const tsx = path.resolve(import.meta.dirname, '../node_modules/.bin/tsx');
  const createAdmin = (...args: string[]) =>
    run(tsx, [cli, 'create-admin', ...args], {
      env: { ...process.env, DATABASE_URL: app.server.ctx.config.databaseUrl, ADMIN_PASSWORD: '' },
    });

  it('creates no user, so nobody can log in', async () => {
    const res = await app.client().post('/auth/login', { email: ADMIN.email, password: ADMIN.password });
    expect(res.status).toBe(401);
  });

  it('refuses credentials the app could never accept', async () => {
    await expect(createAdmin('--email', 'not-an-email')).rejects.toThrow(/email/);
    await expect(createAdmin('--email', 'ops@example.com', '--password', 'x'.repeat(201))).rejects.toThrow(/password/);
    await expect(createAdmin('--email', 'ops@example.com', '--password', 'cli-password', '--name', 'x'.repeat(101))).rejects.toThrow(/name/);
    await expect(createAdmin('--email', 'ops@example.com', '--password', 'cli-password', '--name', '   ')).rejects.toThrow(/name/);
  });

  it('ending every Login when the CLI replaces a password', async () => {
    await createAdmin('--email', 'reset@example.com', '--password', 'first-password');
    const first = app.client();
    const second = app.client();
    await first.login('reset@example.com', 'first-password');
    await second.login('reset@example.com', 'first-password');
    const sockets = await Promise.all([first, second].map((client) => WsTestClient.connect(app.url, client.cookie)));
    try {
      await createAdmin('--email', 'reset@example.com', '--password', 'second-password');
      expect(await Promise.all(sockets.map((ws) => ws.closed))).toEqual([{ code: 4001 }, { code: 4001 }]);
      expect((await first.get('/auth/me')).status).toBe(401);
      expect((await second.get('/auth/me')).status).toBe(401);
      expect((await app.client().post('/auth/login', { email: 'reset@example.com', password: 'first-password' })).status).toBe(401);
      const fresh = app.client();
      await fresh.login('reset@example.com', 'second-password');
      const ws = await WsTestClient.connect(app.url, fresh.cookie);
      try {
        const { project } = await createProject(fresh);
        await ws.subscribe(`project:${project.id}`);
      } finally { ws.close(); }
    } finally { for (const ws of sockets) ws.close(); }
  });

  it('closes sockets when revocation monitoring disconnects and accepts fresh connections after it recovers', async () => {
    await createAdmin('--email', 'listener@example.com', '--password', 'listener-password');
    const client = app.client();
    await client.login('listener@example.com', 'listener-password');
    const ws = await WsTestClient.connect(app.url, client.cookie);
    try {
      await app.server.ctx.db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity
        where datname = current_database() and application_name = 'claude-task-login-revocations'`);
      expect((await ws.closed).code).toBe(1001);
      await expect.poll(() => app.server.ctx.loginRevocations.ready, { timeout: 5000 }).toBe(true);
      const fresh = await WsTestClient.connect(app.url, client.cookie);
      try { await fresh.subscribe('agents'); } finally { fresh.close(); }
    } finally { ws.close(); }
  });

  it('creates an admin with the CLI', async () => {
    const { stdout } = await createAdmin('--email', 'ops@example.com', '--password', 'cli-password', '--name', 'Ops');
    expect(stdout).toContain('Created admin ops@example.com');

    const client = app.client();
    const login = await client.post('/auth/login', { email: 'ops@example.com', password: 'cli-password' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ role: 'admin', displayName: 'Ops', mustChangePassword: false });
  });

  it('prints a temporary password when none is given', async () => {
    const { stdout } = await createAdmin('--email', 'temp@example.com');
    const temp = /Temporary password.*: (\S+)/.exec(stdout)?.[1];
    expect(temp).toBeTruthy();
    const login = await app.client().post('/auth/login', { email: 'temp@example.com', password: temp });
    expect(login.body.user.mustChangePassword).toBe(true);
  });

  it('recovers access by promoting and reactivating an existing user', async () => {
    await createAdmin('--email', 'first@example.com', '--password', 'first-password');
    const first = app.client();
    await first.login('first@example.com', 'first-password');
    const { user } = await createUser(app, first, { email: 'locked@example.com' });
    await first.patch(`/users/${user.id}`, { active: false });

    const { stdout } = await createAdmin('--email', 'LOCKED@example.com', '--password', 'recovered-pass');
    expect(stdout).toContain('Promoted admin');
    const login = await app.client().post('/auth/login', { email: 'locked@example.com', password: 'recovered-pass' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ role: 'admin', active: true });
  });
});
