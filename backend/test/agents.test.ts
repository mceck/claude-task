import { sql } from 'drizzle-orm';
import { DEFAULT_AGENT_DOCKERFILE, agentTopic, projectTopic } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import { assignAgent, assignAndStart, createAgent, createCredential, createProject, createTask, createUser } from './helpers/fixtures';
import { FakeRunner } from './helpers/runner';
import { Stream } from './helpers/stream';
import { WsTestClient } from './helpers/ws';

describe('agents', () => {
  const app = useTestApp();

  it('builds the image, creates the container with its limits, and goes idle once the Runner connects', async () => {
    const admin = await app.admin();
    const credential = await createCredential(admin);
    const res = await admin.post('/agents', {
      name: 'Ada Bot',
      avatarEmoji: '🦊',
      avatarColor: '#ff8800',
      dockerfile: DEFAULT_AGENT_DOCKERFILE,
      credentialId: credential.id,
      cpuLimit: 2,
      memoryMb: 4096,
    });
    expect(res.status).toBe(201);
    const id = res.body.agent.id;
    expect(res.body.agent.services).toEqual(['postgres', 'redis']);
    await app.settle();
    expect(app.runtime.builds[0]!.dockerfile).toContain('RUN /usr/local/bin/claude-task-install-services postgres redis\n');

    const container = app.runtime.containers.get(id)!;
    expect(container.spec).toMatchObject({ cpuLimit: 2, memoryMb: 4096, image: expect.stringContaining(`claude-task/agent-${id}:`) });
    expect(container.spec.env).toEqual({ CLAUDE_TASK_BACKEND_URL: 'ws://backend.test/api/v1/runner', CLAUDE_TASK_RUNNER_TOKEN: expect.any(String) });
    expect((await admin.get(`/agents/${id}`)).body.agent).toMatchObject({ state: 'offline', imageState: 'built', containerState: 'running' });

    const builds = (await admin.get(`/agents/${id}/builds`)).body.builds;
    expect(builds).toMatchObject([{ status: 'succeeded', baseVersion: 'fake-1' }]);
    expect(builds[0].log).toContain('FROM claude-task/agent-base:fake-1');

    await FakeRunner.connect(app, id);
    expect((await admin.get(`/agents/${id}`)).body.agent).toMatchObject({ state: 'idle', runnerConnected: true, credentialName: credential.name });
  });

  it('streams the build log live', async () => {
    const admin = await app.admin();
    const ws = await WsTestClient.connect(app.url, admin.cookie);
    let release!: () => void;
    app.runtime.scriptBuild({ log: 'Step 1/3 : FROM claude-task/agent-base\n', hold: new Promise<void>((r) => (release = r)) });
    const { agent } = await (async () => {
      const credential = await createCredential(admin);
      const res = await admin.post('/agents', { name: 'Streamer', dockerfile: DEFAULT_AGENT_DOCKERFILE, credentialId: credential.id });
      return { agent: res.body.agent };
    })();
    await ws.subscribe(agentTopic(agent.id));
    // The build is held, so the Agent shows as building.
    await new Promise((r) => setTimeout(r, 50));
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.state).toBe('building');
    release();
    await app.settle();
    const logs = (await admin.get(`/agents/${agent.id}/builds`)).body.builds[0].log;
    expect(logs).toContain('Step 1/3');
    expect(ws.events('build.updated').map((e) => e.build.status)).toContain('succeeded');
    ws.close();
  });

  it('installs only selected services, accepts no services and preserves selection on unrelated edits', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { body: { services: ['rustfs', 'mysql', 'mailpit'] }, connect: false });
    expect(agent.services).toEqual(['mysql', 'mailpit', 'rustfs']);
    expect(app.runtime.builds.at(-1)!.dockerfile).toContain('RUN /usr/local/bin/claude-task-install-services mysql mailpit rustfs\n');
    expect(app.runtime.builds.at(-1)!.dockerfile).toContain('ENV CLAUDE_TASK_SERVICES="mysql mailpit rustfs"');
    const count = app.runtime.builds.length;
    await admin.patch(`/agents/${agent.id}`, { description: 'Updated description' });
    await admin.patch(`/agents/${agent.id}`, { services: ['mailpit', 'rustfs', 'mysql'] });
    await app.settle();
    expect(app.runtime.builds).toHaveLength(count);
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.services).toEqual(agent.services);
    expect((await admin.get('/agents')).body.agents[0].services).toEqual(agent.services);

    const oldImage = app.runtime.containers.get(agent.id)!.spec.image;
    expect((await admin.patch(`/agents/${agent.id}`, { services: [] })).status).toBe(200);
    await app.settle();
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.services).toEqual([]);
    expect(app.runtime.builds.at(-1)!.dockerfile).toContain('ENV CLAUDE_TASK_SERVICES=""');
    expect(app.runtime.containers.get(agent.id)!.spec.image).not.toBe(oldImage);

    const empty = await createAgent(app, admin, { body: { services: [] }, connect: false });
    expect(empty.agent.services).toEqual([]);
  });

  it('rejects unknown or duplicate services on creation and update', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    for (const services of [['mongo'], ['redis', 'redis'], 'postgres', null]) {
      expect((await admin.patch(`/agents/${agent.id}`, { services })).status).toBe(400);
      expect((await admin.post('/agents', { name: 'Invalid services', credentialId: agent.credentialId, dockerfile: DEFAULT_AGENT_DOCKERFILE, services })).status).toBe(400);
    }
    expect((await admin.get(`/agents/${agent.id}`)).body.agent.services).toEqual(['postgres', 'redis']);
  });

  it('stores Agent environment variables, validates their names and reserves the platform ones', async () => {
    const admin = await app.admin();
    const credential = await createCredential(admin);
    const env = {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_MODEL: 'openrouter/model',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'openrouter/opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'openrouter/sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'openrouter/haiku',
      CLAUDE_CODE_SUBAGENT_MODEL: 'openrouter/subagent',
      ENABLE_TOOL_SEARCH: 'false',
    };
    const created = await admin.post('/agents', { name: 'Env agent', credentialId: credential.id, dockerfile: DEFAULT_AGENT_DOCKERFILE, env });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.agent.env).toEqual(env);

    const patched = await admin.patch(`/agents/${created.body.agent.id}`, { env: { ANTHROPIC_MODEL: 'other/model' } });
    expect(patched.status).toBe(200);
    expect(patched.body.agent.env).toEqual({ ANTHROPIC_MODEL: 'other/model' });

    for (const invalid of [
      { 'BAD-NAME': 'x' },
      { '1BAD': 'x' },
      { ANTHROPIC_API_KEY: 'x' },
      { ANTHROPIC_AUTH_TOKEN: 'x' },
      { CLAUDE_CODE_OAUTH_TOKEN: 'x' },
      { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1' },
      { CLAUDE_TASK_RUNNER_TOKEN: 'x' },
      { HOME: '/tmp' },
      { LONG: 'x'.repeat(100_001) },
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`KEY_${i}`, 'value'])),
    ]) {
      const res = await admin.patch(`/agents/${created.body.agent.id}`, { env: invalid });
      expect(res.status, JSON.stringify(invalid).slice(0, 80)).toBe(400);
    }
    expect((await admin.get(`/agents/${created.body.agent.id}`)).body.agent.env).toEqual({ ANTHROPIC_MODEL: 'other/model' });

    const rejected = await admin.post('/agents', {
      name: 'Invalid env agent',
      credentialId: credential.id,
      dockerfile: DEFAULT_AGENT_DOCKERFILE,
      env: { 'BAD-NAME': 'x' },
    });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body.error.details)).toContain('environment variable name');
  });

  it('rejects Dockerfiles not based on the Base Image', async () => {
    const admin = await app.admin();
    const credential = await createCredential(admin);
    for (const dockerfile of ['FROM node:22\nUSER agent\n', 'RUN echo hi\nFROM claude-task/agent-base\n', 'FROM claude-task/agent-base-evil\n']) {
      const res = await admin.post('/agents', { name: 'Bad', dockerfile, credentialId: credential.id });
      expect(res.status, dockerfile).toBe(400);
    }
    const ok = await admin.post('/agents', { name: 'Tagged', dockerfile: '# toolchains\nARG X=1\nFROM claude-task/agent-base:latest AS base\nUSER agent\n', credentialId: credential.id });
    expect(ok.status).toBe(201);
  });

  it('fails a build whose image does not end as USER agent', async () => {
    const admin = await app.admin();
    app.runtime.scriptBuild({ user: 'root' });
    const { agent } = await createAgent(app, admin, { connect: false });
    expect(agent).toMatchObject({ state: 'build_failed', imageState: 'failed' });
    const [build] = (await admin.get(`/agents/${agent.id}/builds`)).body.builds;
    expect(build.status).toBe('failed');
    expect(build.log).toContain('must end with `USER agent`');
    expect(app.runtime.containers.has(agent.id)).toBe(false);
  });

  it('keeps the previous container running when a rebuild fails', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin);
    const before = app.runtime.containers.get(agent.id)!.spec.image;
    app.runtime.scriptBuild({ fail: 'apt-get: package not found' });
    await admin.patch(`/agents/${agent.id}`, { services: ['mysql'] });
    await app.settle();
    expect(app.runtime.containers.get(agent.id)!.spec.image).toBe(before);
    expect((await admin.get(`/agents/${agent.id}`)).body.agent).toMatchObject({ state: 'build_failed', containerState: 'running' });
  });

  it('recreates the container after a rebuild only once the Agent is idle, unless forced', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent, runner } = await createAgent(app, admin);
    const oldImage = app.runtime.containers.get(agent.id)!.spec.image;
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();

    await admin.patch(`/agents/${agent.id}`, { services: ['mysql', 'mailpit', 'rustfs'] });
    await app.settle();
    expect(app.runtime.containers.get(agent.id)!.spec.image).toBe(oldImage);
    expect((await admin.get(`/agents/${agent.id}`)).body.agent).toMatchObject({ recreatePending: true, state: 'working' });

    const s = new Stream();
    await runner.play(start.jobId, [s.init(), s.result()]);
    await runner.exit(start.jobId);
    await app.settle();
    const recreated = app.runtime.containers.get(agent.id)!;
    expect(recreated.spec.image).not.toBe(oldImage);
    // The old Runner token no longer works.
    expect((await runner.closed).code).toBe(4002);
    await expect(FakeRunner.connect(app, agent.id, { token: FakeRunner.token(app, agent.id) })).resolves.toBeTruthy();
  });

  it('force-recreates a busy Agent; its Job resumes after the restart', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent, runner } = await createAgent(app, admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [s.init(), s.text('Halfway')]);

    expect((await admin.post(`/agents/${agent.id}/recreate`, { force: true })).status).toBe(200);
    await app.settle();
    const fresh = await FakeRunner.connect(app, agent.id);
    expect(await fresh.next('job.start')).toMatchObject({ sessionId: start.sessionId, resumeInterrupted: true });
  });

  it('restarts a Build interrupted before the Agent reached building state', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    const before = app.runtime.builds.length;
    await app.server.ctx.db.execute(sql`insert into agent_builds (agent_id, dockerfile, base_version, status)
      values (${agent.id}::uuid, 'FROM claude-task/agent-base', 'fake-1', 'building')`);
    const { resetInterruptedBuilds } = await import('../src/modules/agents/builds');
    await resetInterruptedBuilds(app.server.ctx.db);
    await app.server.ctx.scheduler.reconcileAll();
    await app.settle();
    expect(app.runtime.builds.length).toBeGreaterThan(before);
    expect((await admin.get(`/agents/${agent.id}/builds`)).body.builds[0].status).toBe('succeeded');
  });

  it('rebuilds every Agent when the platform version changes', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    app.runtime.upgrade('fake-2');
    await app.server.ctx.scheduler.reconcileAll();
    await app.settle();
    const builds = (await admin.get(`/agents/${agent.id}/builds`)).body.builds;
    expect(builds.map((b: { baseVersion: string }) => b.baseVersion)).toEqual(['fake-2', 'fake-1']);
    expect(app.runtime.containers.get(agent.id)!.spec.image).toContain(builds[0].id.slice(0, 12));
  });

  it('restarts a container that stopped', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    app.runtime.setState(agent.id, 'exited');
    await app.server.ctx.scheduler.reconcileAll();
    expect(app.runtime.containers.get(agent.id)!.state).toBe('running');
  });

  it('duplicates an Agent with the same environment', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, {
      body: { model: 'opus', systemPrompt: 'Be terse.', services: ['mysql', 'rustfs'], env: { ANTHROPIC_MODEL: 'openrouter/model' } },
      connect: false,
    });
    const res = await admin.post(`/agents/${agent.id}/duplicate`, {});
    expect(res.status).toBe(201);
    expect(res.body.agent).toMatchObject({
      name: `${agent.name} (copy)`,
      model: 'opus',
      systemPrompt: 'Be terse.',
      dockerfile: agent.dockerfile,
      services: ['mysql', 'rustfs'],
      env: { ANTHROPIC_MODEL: 'openrouter/model' },
    });
    await app.settle();
    expect(app.runtime.containers.has(res.body.agent.id)).toBe(true);
  });

  it('duplicates an Agent repeatedly with unique names that fit, without leaking avatar copies', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { name: 'A'.repeat(100), connect: false });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
    expect((await admin.request('PUT', `/agents/${agent.id}/avatar`, { form })).status).toBeLessThan(300);
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await admin.post(`/agents/${agent.id}/duplicate`, {});
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      names.push(res.body.agent.name);
    }
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(100);
    const blobs = await app.server.ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from agents where avatar_blob_id is not null`);
    expect(blobs.rows[0]!.n).toBe(4);
    expect((await admin.post(`/agents/${agent.id}/duplicate`, { name: names[0] })).status).toBe(409);
  });

  it('deletes an Agent without open Sessions, with its container, images and volume', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent, runner } = await createAgent(app, admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    await runner.next('job.start');
    const blocked = await admin.delete(`/agents/${agent.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain(task.key);

    await assignAgent(admin, task.id, null);
    expect((await admin.delete(`/agents/${agent.id}`)).status).toBe(204);
    await app.settle();
    expect(app.runtime.removed).toContain(agent.id);
    expect((await admin.get(`/tasks/${task.id}`)).body.task.agentId).toBeNull();
  });

  it('deleting an Agent left on closed Tasks unassigns them visibly, with a Revision', async () => {
    const admin = await app.admin();
    const bundle = await createProject(admin);
    const { agent, runner } = await createAgent(app, admin);
    const task = await createTask(admin, bundle.project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    const closed = bundle.statuses.find((s) => s.category === 'closed')!;
    expect((await admin.post(`/tasks/${task.id}/move`, { statusId: closed.id })).status).toBe(200);
    await runner.exit(start.jobId, null, 'SIGTERM');
    const before = (await admin.get(`/tasks/${task.id}`)).body.task;

    const ws = await WsTestClient.connect(app.url, admin.cookie);
    await ws.subscribe(projectTopic(bundle.project.id));
    expect((await admin.delete(`/agents/${agent.id}`)).status).toBe(204);
    const { event } = await ws.next('task.updated', (e) => e.task.id === task.id);
    expect(event.task.agentId).toBeNull();
    ws.close();
    const after = (await admin.get(`/tasks/${task.id}`)).body.task;
    expect(after).toMatchObject({ agentId: null, version: before.version + 1 });
    const items = (await admin.get(`/tasks/${task.id}/timeline`)).body.items;
    expect(items.some((i: { type: string; revision?: { changes: { field: string }[] } }) => i.type === 'revision' && i.revision!.changes.some((c) => c.field === 'agentId' ))).toBe(true);
  });

  it('lets members see Agents and their Queue but not change them', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const { agent } = await createAgent(app, admin, { connect: false });
    expect((await member.get('/agents')).body.agents.map((a: { id: string }) => a.id)).toEqual([agent.id]);
    expect((await member.get(`/agents/${agent.id}/queue`)).status).toBe(200);
    const credential = await createCredential(admin);
    const attempts = [
      member.post('/agents', { name: 'X', dockerfile: DEFAULT_AGENT_DOCKERFILE, credentialId: credential.id }),
      member.patch(`/agents/${agent.id}`, { enabled: false }),
      member.delete(`/agents/${agent.id}`),
      member.post(`/agents/${agent.id}/rebuild`),
      member.post(`/agents/${agent.id}/recreate`, {}),
      member.post(`/agents/${agent.id}/duplicate`, {}),
      member.get(`/agents/${agent.id}/logs`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
  });

  it('refuses unknown or stale Runner tokens', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    await expect(FakeRunner.connect(app, agent.id, { token: 'nope' })).rejects.toThrow(/401/);
  });

  it('drops a Runner connection that stops answering pings, so its Jobs can be recovered', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    const config = app.server.ctx.config.agents;
    config.runnerPingIntervalMs = 50;
    try {
      const runner = await FakeRunner.connect(app, agent.id, { autoPong: false });
      await expect(Promise.race([runner.closed, new Promise((r) => setTimeout(() => r('still open'), 2000))])).resolves.not.toBe('still open');
      await app.settle();
      expect((await admin.get(`/agents/${agent.id}`)).body.agent.runnerConnected).toBe(false);
    } finally {
      delete config.runnerPingIntervalMs;
    }
  });
});

describe('project settings for Agents', () => {
  const app = useTestApp();

  it('keeps secret env vars write-only and admin-managed', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const { project } = await createProject(admin);
    await admin.put(`/projects/${project.id}/env/NODE_ENV`, { value: 'test' });
    const res = await admin.put(`/projects/${project.id}/env/DB_PASSWORD`, { value: 'hunter2-secret', secret: true });
    expect(res.status).toBe(200);
    const settings = (await member.get(`/projects/${project.id}/agent-settings`)).body.settings;
    expect(settings.env).toEqual([
      { id: expect.any(String), name: 'DB_PASSWORD', secret: true, value: null, last4: 'cret' },
      { id: expect.any(String), name: 'NODE_ENV', secret: false, value: 'test', last4: null },
    ]);
    expect(JSON.stringify(settings)).not.toContain('hunter2');
    // A short secret would be (almost) fully revealed by its last 4 characters.
    await admin.put(`/projects/${project.id}/env/PIN`, { value: '12345678', secret: true });
    const pin = (await member.get(`/projects/${project.id}/agent-settings`)).body.settings.env.find((e: { name: string }) => e.name === 'PIN');
    expect(pin).toMatchObject({ secret: true, value: null, last4: '' });
    await admin.delete(`/projects/${project.id}/env/PIN`);

    expect((await member.put(`/projects/${project.id}/env/X`, { value: '1' })).status).toBe(403);
    expect((await member.delete(`/projects/${project.id}/env/NODE_ENV`)).status).toBe(403);
    expect((await admin.put(`/projects/${project.id}/env/ANTHROPIC_API_KEY`, { value: 'x' })).status).toBe(400);
    expect((await admin.put(`/projects/${project.id}/env/ANTHROPIC_AUTH_TOKEN`, { value: 'x' })).status).toBe(400);
    expect((await admin.delete(`/projects/${project.id}/env/NODE_ENV`)).status).toBe(200);
  });

  it('merges an imported .env file into the existing variables', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const { project } = await createProject(admin);
    await admin.put(`/projects/${project.id}/env/KEEP_ME`, { value: 'kept' });
    await admin.put(`/projects/${project.id}/env/API_URL`, { value: 'https://old.example.com' });
    await admin.put(`/projects/${project.id}/env/DB_PASSWORD`, { value: 'old-secret', secret: true });
    const content = [
      '﻿# Staging',
      'API_URL=https://staging.example.com/#frag # comment',
      'export NODE_ENV = "production"',
      "SINGLE='a \\n b'",
      'MULTI="line1\\nline2',
      'line3"',
      'EMPTY=',
      'DB_PASSWORD=new-secret-value',
      'NODE_ENV=test',
      '',
    ].join('\r\n');
    const res = await admin.post(`/projects/${project.id}/env/import`, { content });
    expect(res.status).toBe(200);
    expect(res.body.settings.env).toEqual([
      { id: expect.any(String), name: 'API_URL', secret: false, value: 'https://staging.example.com/#frag', last4: null },
      // A secret is never downgraded to plain by an import.
      { id: expect.any(String), name: 'DB_PASSWORD', secret: true, value: null, last4: 'alue' },
      { id: expect.any(String), name: 'EMPTY', secret: false, value: '', last4: null },
      { id: expect.any(String), name: 'KEEP_ME', secret: false, value: 'kept', last4: null },
      { id: expect.any(String), name: 'MULTI', secret: false, value: 'line1\nline2\nline3', last4: null },
      { id: expect.any(String), name: 'NODE_ENV', secret: false, value: 'test', last4: null },
      { id: expect.any(String), name: 'SINGLE', secret: false, value: 'a \\n b', last4: null },
    ]);

    const secrets = await admin.post(`/projects/${project.id}/env/import`, { content: 'TOKEN=tok_abcdef1234\nKEEP_ME=now-secret', secret: true });
    const env = secrets.body.settings.env;
    expect(env.find((e: { name: string }) => e.name === 'TOKEN')).toMatchObject({ secret: true, value: null, last4: '1234' });
    expect(env.find((e: { name: string }) => e.name === 'KEEP_ME')).toMatchObject({ secret: true, value: null });
    expect(JSON.stringify(secrets.body)).not.toContain('tok_abcdef');

    const bad = await admin.post(`/projects/${project.id}/env/import`, { content: 'OK=1\nnot a variable\n1BAD=x\nQ="open' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.errors).toEqual(['Line 2: expected NAME=value', 'Line 3: 1BAD is not a valid variable name', 'Line 4: unterminated " quote']);
    expect((await admin.post(`/projects/${project.id}/env/import`, { content: 'OK=1\nANTHROPIC_API_KEY=x' })).status).toBe(400);
    expect((await admin.post(`/projects/${project.id}/env/import`, { content: '# nothing' })).status).toBe(400);
    expect((await member.post(`/projects/${project.id}/env/import`, { content: 'X=1' })).status).toBe(403);
    // Rejected imports write nothing.
    const after = (await admin.get(`/projects/${project.id}/agent-settings`)).body.settings.env;
    expect(after.map((e: { name: string }) => e.name)).not.toContain('OK');
  });

  it('lets members write the Setup Script and Agent Instructions', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const { project } = await createProject(admin);
    const res = await member.patch(`/projects/${project.id}/agent-settings`, { setupScript: 'pnpm install', agentInstructions: 'Run pnpm test before review.' });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ setupScript: 'pnpm install', agentInstructions: 'Run pnpm test before review.' });
  });

  it('assigns the Project default Agent to new tasks, and creates them without when it is disabled or removed', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent } = await createAgent(app, admin);
    expect((await admin.patch(`/projects/${project.id}/agent-settings`, { defaultAgentId: crypto.randomUUID() })).status).toBe(400);
    const set = await admin.patch(`/projects/${project.id}/agent-settings`, { defaultAgentId: agent.id });
    expect(set.body.settings.defaultAgentId).toBe(agent.id);
    const task = await createTask(admin, project.id);
    expect(task.agentId).toBe(agent.id);
    expect((await admin.get(`/tasks/${task.id}/session`)).body.session).toMatchObject({ state: 'pending' });
    await admin.patch(`/agents/${agent.id}`, { enabled: false });
    expect((await createTask(admin, project.id)).agentId).toBeNull();
    await admin.patch(`/agents/${agent.id}`, { enabled: true });
    await admin.patch(`/tasks/${task.id}`, { version: task.version, agentId: null });
    expect((await admin.delete(`/agents/${agent.id}`)).status).toBe(204);
    expect((await createTask(admin, project.id)).agentId).toBeNull();
    expect((await admin.get(`/projects/${project.id}/agent-settings`)).body.settings.defaultAgentId).toBeNull();
  });
});
