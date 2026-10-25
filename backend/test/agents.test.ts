import { DEFAULT_AGENT_DOCKERFILE, agentTopic } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import { assignAgent, createAgent, createCredential, createProject, createTask, createUser } from './helpers/fixtures';
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
    await app.settle();

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
    await admin.patch(`/agents/${agent.id}`, { dockerfile: `${DEFAULT_AGENT_DOCKERFILE}RUN false\n` });
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
    await assignAgent(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await runner.drain();

    await admin.post(`/agents/${agent.id}/rebuild`);
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
    await assignAgent(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    const s = new Stream(start.sessionId);
    await runner.play(start.jobId, [s.init(), s.text('Halfway')]);

    expect((await admin.post(`/agents/${agent.id}/recreate`, { force: true })).status).toBe(200);
    await app.settle();
    const fresh = await FakeRunner.connect(app, agent.id);
    expect(await fresh.next('job.start')).toMatchObject({ sessionId: start.sessionId, resumeInterrupted: true });
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
    const { agent } = await createAgent(app, admin, { body: { model: 'opus', systemPrompt: 'Be terse.' }, connect: false });
    const res = await admin.post(`/agents/${agent.id}/duplicate`, {});
    expect(res.status).toBe(201);
    expect(res.body.agent).toMatchObject({ name: `${agent.name} (copy)`, model: 'opus', systemPrompt: 'Be terse.', dockerfile: agent.dockerfile });
    await app.settle();
    expect(app.runtime.containers.has(res.body.agent.id)).toBe(true);
  });

  it('deletes an Agent without open Sessions, with its container, images and volume', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent, runner } = await createAgent(app, admin);
    const task = await createTask(admin, project.id);
    await assignAgent(admin, task.id, agent.id);
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

    expect((await member.put(`/projects/${project.id}/env/X`, { value: '1' })).status).toBe(403);
    expect((await member.delete(`/projects/${project.id}/env/NODE_ENV`)).status).toBe(403);
    expect((await admin.put(`/projects/${project.id}/env/ANTHROPIC_API_KEY`, { value: 'x' })).status).toBe(400);
    expect((await admin.delete(`/projects/${project.id}/env/NODE_ENV`)).status).toBe(200);
  });

  it('lets members write the Setup Script and Agent Instructions', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const { project } = await createProject(admin);
    const res = await member.patch(`/projects/${project.id}/agent-settings`, { setupScript: 'pnpm install', agentInstructions: 'Run pnpm test before review.' });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ setupScript: 'pnpm install', agentInstructions: 'Run pnpm test before review.' });
  });
});
