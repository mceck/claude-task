import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_DOCKERFILE } from '@claude-task/shared';
import { useTestApp } from './helpers/app';
import { connectController, waitForHost } from './helpers/controller';
import { createAgent, createProject, createTask, assignAndStart, comment, moveToStatus, statusByName } from './helpers/fixtures';
import { FakeRunner } from './helpers/runner';

describe('Workers on Remote Hosts', () => {
  const app = useTestApp();
  it('uses the Host URL for its Runner and Job and recreates free containers after connection settings change', async () => {
    const admin = await app.admin();
    const { host, token } = (await admin.post('/hosts', { name: 'Remote' })).body;
    const controller = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    const response = await admin.post('/workers', {
      name: 'Remote worker',
      hostId: host.id,
      dockerfile: DEFAULT_AGENT_DOCKERFILE,
      minimum: 1,
    });
    expect(response.status).toBe(201);
    const worker = response.body.worker;
    await app.settle();
    const runtime = app.runtimeFor(host.id);
    expect(runtime.container(worker!.id, 1)!.spec.env.CLAUDE_TASK_BACKEND_URL).toBe('wss://backend.example/api/v1/runner');
    const first = runtime.container(worker!.id, 1)!.created;
    expect((await admin.patch(`/hosts/${host.id}`, { backendUrlOverride: 'https://vpn.example', network: 'vpn' })).status).toBe(200);
    await app.settle();
    expect(runtime.container(worker!.id, 1)!.created).toBeGreaterThan(first);
    expect(runtime.container(worker!.id, 1)!.spec).toMatchObject({
      network: 'vpn',
      env: { CLAUDE_TASK_BACKEND_URL: 'wss://vpn.example/api/v1/runner' },
    });
    const runner = await FakeRunner.connect(
      app,
      { workerId: worker!.id, slot: 1 },
      { token: runtime.container(worker!.id, 1)!.spec.env.CLAUDE_TASK_RUNNER_TOKEN },
    );
    const { agent } = await createAgent(app, admin);
    const { project } = await createProject(admin, { workerId: worker!.id });
    await admin.put(`/projects/${project.id}/repository`, { connectionId: 'env-github', providerRepoId: '1' });
    const task = await createTask(admin, project.id);
    const form = new FormData();
    form.set('body', 'Attached specification');
    form.append('files', new Blob(['specification'], { type: 'text/plain' }), 'spec.txt');
    expect((await admin.request('POST', `/tasks/${task.id}/comments`, { form })).status).toBe(201);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    expect(JSON.parse(start.claudeArgs.mcpConfig).mcpServers['claude-task'].url).toBe('https://vpn.example/api/v1/mcp');
    expect(start.git!.cloneUrl).toBe(`https://vpn.example/git/${project.id}.git`);
    expect(start.attachmentsToFetch?.[0]?.url).toMatch(/^https:\/\/vpn.example\/api\/v1\/runner\/attachments\//);
    runner.accept(start.jobId);
    await runner.drain();
    const mcp = JSON.parse(start.claudeArgs.mcpConfig).mcpServers['claude-task'];
    const client = new Client({ name: 'remote-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url.replace('https://vpn.example', app.url)), {
        requestInit: { headers: mcp.headers },
      }),
    );
    const uploading = client.callTool({ name: 'send_files', arguments: { paths: ['output.txt'] } });
    const upload = await runner.next('job.upload');
    expect(upload.url).toMatch(/^https:\/\/vpn.example\/api\/v1\/runner\/uploads\//);
    const files = new FormData();
    files.set('manifest', JSON.stringify([{ path: 'output.txt', error: 'Fixture has no file' }]));
    await fetch(upload.url.replace('https://vpn.example', app.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${runtime.container(worker!.id, 1)!.spec.env.CLAUDE_TASK_RUNNER_TOKEN}` },
      body: files,
    });
    await uploading;
    await client.close();
    const busyCreated = runtime.container(worker!.id, 1)!.created;
    await admin.patch(`/hosts/${host.id}`, { network: 'later' });
    await app.settle();
    expect(runtime.container(worker!.id, 1)!.created).toBe(busyCreated);
    await runner.close();
    controller.close();
  });
  it('keeps the Host on duplicate and moves a free Worker with empty containers and volumes', async () => {
    const admin = await app.admin();
    const { host, token } = (await admin.post('/hosts', { name: 'Destination' })).body;
    const controller = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    const moving = await admin.patch(`/workers/${app.workerId}`, { hostId: host.id });
    expect(moving.status).toBe(200);
    await app.settle();
    expect(moving.body.worker.host.id).toBe(host.id);
    expect(app.runtime.removed).toContain(app.workerId);
    expect(app.runtimeFor(host.id).container(app.workerId, 1)).toBeDefined();
    const duplicate = await admin.post(`/workers/${app.workerId}/duplicate`, {});
    expect(duplicate.body.worker.host.id).toBe(host.id);
    const { project } = await createProject(admin, { workerId: app.workerId });
    const { agent } = await createAgent(app, admin, { connect: false });
    const runner = await FakeRunner.connect(app, app.workerId, {
      token: app.runtimeFor(host.id).container(app.workerId, 1)!.spec.env.CLAUDE_TASK_RUNNER_TOKEN,
    });
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    await runner.next('job.start');
    const local = (await admin.get('/hosts')).body.hosts.find((h: any) => h.kind === 'local');
    const refused = await admin.patch(`/workers/${app.workerId}`, { hostId: local.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain(task.key);
    await runner.close();
    controller.close();
  });

  it('keeps dispatching through a connected Runner while Docker work waits for the Controller', async () => {
    const admin = await app.admin();
    const { host, token } = (await admin.post('/hosts', { name: 'Intermittent' })).body;
    const controller = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    const worker = (await admin.post('/workers', { name: 'Resilient', hostId: host.id, dockerfile: DEFAULT_AGENT_DOCKERFILE, minimum: 1 }))
      .body.worker;
    await app.settle();
    const runner = await FakeRunner.connect(app, worker.id);
    const { agent } = await createAgent(app, admin);
    const { project } = await createProject(admin, { workerId: worker.id });
    const prepared = await createTask(admin, project.id);
    await assignAndStart(admin, prepared.id, agent.id);
    const first = await runner.next('job.start');
    const { Stream } = await import('./helpers/stream');
    const stream = new Stream(first.sessionId);
    runner.accept(first.jobId);
    await runner.play(first.jobId, [stream.init(), stream.result()]);
    await runner.next('job.end');
    await runner.exit(first.jobId);
    await app.settle();
    const runtime = app.runtimeFor(host.id);
    const original = runtime.container(worker.id, 1)!.created;
    controller.close();
    await waitForHost(app, host.id, 'disconnected');
    expect((await admin.get(`/workers/${worker.id}`)).body.worker).toMatchObject({ state: 'idle', host: { state: 'disconnected' } });
    for (const action of ['rebuild', 'containers/1/restart', 'containers/1/force-recreate'])
      expect((await admin.post(`/workers/${worker.id}/${action}`)).body.error.message).toBe('Host disconnected');
    expect((await admin.get(`/workers/${worker.id}/containers/1/logs`)).body.error.message).toBe('Host disconnected');
    await admin.patch(`/workers/${worker.id}`, { dockerfile: DEFAULT_AGENT_DOCKERFILE + '\n# changed' });
    await app.server.ctx.scheduler.reconcileAll();
    await app.settle();
    expect(runtime.container(worker.id, 1)!.created).toBe(original);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    expect((await runner.next('job.start', (m) => m.jobId !== first.jobId)).git).toBeNull();
    await runner.close();
    await app.settle();
    expect((await admin.get(`/workers/${worker.id}`)).body.worker.state).toBe('host_offline');
    const reconnected = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    await app.settle();
    expect(runtime.builds.at(-1)!.dockerfile).toContain('# changed');
    reconnected.close();
  });

  it('refuses a move while a closed Task\'s Job still runs, and points to wiki chats', async () => {
    const admin = await app.admin();
    const { host, token } = (await admin.post('/hosts', { name: 'Guarded' })).body;
    const controller = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    const { agent, runner } = await createAgent(app, admin);
    const bundle = await createProject(admin);
    const task = await createTask(admin, bundle.project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    runner.accept(start.jobId);
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    const busy = await admin.patch(`/workers/${app.workerId}`, { hostId: host.id });
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toBe(`An agent is still running a job of this worker: ${task.key}. Try again when it ends.`);
    await runner.exit(start.jobId);
    await app.settle();
    const wiki = (
      await admin.post('/wikis', { name: 'Docs', agentId: agent.id, workerId: app.workerId, repository: { connectionId: 'env-github', providerRepoId: '1' } })
    ).body.wiki;
    await comment(admin, wiki.taskId, 'Write the docs');
    const chat = await runner.next('job.start', (m) => m.jobId !== start.jobId);
    runner.accept(chat.jobId);
    const { Stream } = await import('./helpers/stream');
    await runner.play(chat.jobId, [new Stream(chat.sessionId).init()]);
    const open = await admin.patch(`/workers/${app.workerId}`, { hostId: host.id });
    expect(open.status).toBe(409);
    expect(open.body.error.message).toContain('(delete the chats of a wiki)');
    await runner.exit(chat.jobId);
    await runner.close();
    controller.close();
  });

  it('never recreates past the Runner reconnect timeout while disconnected, and applies a Recreate after reconnection', async () => {
    const admin = await app.admin();
    const { host, token } = (await admin.post('/hosts', { name: 'Recreating' })).body;
    const controller = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    const worker = (await admin.post('/workers', { name: 'Waiting', hostId: host.id, dockerfile: DEFAULT_AGENT_DOCKERFILE, minimum: 1 })).body.worker;
    await app.settle();
    const runtime = app.runtimeFor(host.id);
    const runner = await FakeRunner.connect(app, worker.id);
    await runner.close();
    await app.settle();
    const original = runtime.container(worker.id, 1)!.created;
    controller.close();
    await waitForHost(app, host.id, 'disconnected');
    const { agents } = app.server.ctx.config;
    const timeout = agents.runnerReconnectTimeoutMs;
    agents.runnerReconnectTimeoutMs = 0;
    try {
      await app.server.ctx.scheduler.reconcileAll();
      await app.settle();
      expect(runtime.container(worker.id, 1)!.created).toBe(original);
    } finally {
      agents.runnerReconnectTimeoutMs = timeout;
    }
    expect((await admin.post(`/workers/${worker.id}/recreate`)).status).toBe(200);
    await app.settle();
    expect(runtime.container(worker.id, 1)!.created).toBe(original);
    const reconnected = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    await app.settle();
    expect(runtime.container(worker.id, 1)!.created).toBeGreaterThan(original);
    reconnected.close();
  });

  it('fails a Build interrupted by a dropped Controller and rebuilds after reconnection', async () => {
    const admin = await app.admin();
    const { host, token } = (await admin.post('/hosts', { name: 'Build connection' })).body;
    const controller = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    const worker = (await admin.post('/workers', { name: 'Building', hostId: host.id, dockerfile: DEFAULT_AGENT_DOCKERFILE })).body.worker;
    await app.settle();
    const runtime = app.runtimeFor(host.id);
    let release!: () => void;
    runtime.scriptBuild({
      hold: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    await admin.post(`/workers/${worker.id}/rebuild`);
    controller.close();
    await waitForHost(app, host.id, 'disconnected');
    await app.settle();
    const builds = (await admin.get(`/workers/${worker.id}/builds`)).body.builds;
    expect(builds[0]).toMatchObject({ status: 'failed', log: expect.stringContaining('The Host disconnected during this build') });
    release();
    const reconnected = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    await app.settle();
    expect((await admin.get(`/workers/${worker.id}`)).body.worker.imageState).toBe('built');
    reconnected.close();
  });

  it.each([false, true])('repeats an Agent Profile synchronization after an in-flight move (return home: %s)', async (returnHome) => {
    const admin = await app.admin();
    const { host, token } = (await admin.post('/hosts', { name: 'New profile storage' })).body;
    const controller = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    const { agent, runner } = await createAgent(app, admin);
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    const localId = (await admin.get(`/workers/${app.workerId}`)).body.worker.host.id;
    let release!: () => void;
    const configure = app.runtime.configureProfile.bind(app.runtime);
    let syncing = false;
    app.runtime.configureProfile = async (...args) => {
      syncing = true;
      await configure(...args);
    };
    app.runtime.profileHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await assignAndStart(admin, task.id, agent.id);
    for (let i = 0; i < 100 && !syncing; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(syncing).toBe(true);
    expect((await admin.patch(`/workers/${app.workerId}`, { hostId: host.id })).status).toBe(200);
    if (returnHome) expect((await admin.patch(`/workers/${app.workerId}`, { hostId: localId })).status).toBe(200);
    release();
    app.runtime.profileHold = null;
    await app.settle();
    const remote = returnHome ? app.runtime : app.runtimeFor(host.id);
    const newRunner = await FakeRunner.connect(app, app.workerId);
    expect(await newRunner.next('job.start')).toMatchObject({ mode: 'new' });
    expect(remote.profileSyncs.filter((sync) => sync.workerId === app.workerId && sync.agentId === agent.id)).toHaveLength(
      returnHome ? 2 : 1,
    );
    app.runtime.configureProfile = configure;
    await newRunner.close();
    await runner.close();
    controller.close();
  });

  it('removes a container whose creation on the old Host completes after a move', async () => {
    const admin = await app.admin();
    const { host, token } = (await admin.post('/hosts', { name: 'Late create destination' })).body;
    const controller = await connectController(app, token);
    await waitForHost(app, host.id, 'connected');
    const create = app.runtime.createContainer.bind(app.runtime);
    let release!: () => void;
    let creating = false;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.runtime.createContainer = async (id, slot, spec) => {
      creating = true;
      await hold;
      await create(id, slot, spec);
    };
    const recreating = admin.post(`/workers/${app.workerId}/recreate`);
    for (let i = 0; i < 100 && !creating; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(creating).toBe(true);
    expect((await admin.patch(`/workers/${app.workerId}`, { hostId: host.id })).status).toBe(200);
    release();
    await recreating;
    await app.settle();
    app.runtime.createContainer = create;
    expect(app.runtime.container(app.workerId, 1)).toBeUndefined();
    expect(app.runtimeFor(host.id).container(app.workerId, 1)).toBeDefined();
    controller.close();
  });
});

describe('Host selection without a Local Host', () => {
  const app = useTestApp({ config: { localHost: false }, defaultWorker: false });
  it('requires a Host, defaults to the only Remote Host, and rejects the disabled Local Host', async () => {
    const admin = await app.admin();
    const body = { name: 'Worker', dockerfile: DEFAULT_AGENT_DOCKERFILE };
    expect((await admin.post('/workers', body)).body.error.message).toBe('Choose a host');
    const { hosts } = await import('../src/db/schema');
    const [local] = await app.server.ctx.db.select().from(hosts);
    expect((await admin.post('/workers', { ...body, hostId: local!.id })).body.error.message).toBe('Unknown host');
    expect((await admin.post('/workers', { ...body, hostId: '00000000-0000-4000-8000-000000000000' })).body.error.message).toBe(
      'Unknown host',
    );
    const { host } = (await admin.post('/hosts', { name: 'Only' })).body;
    expect((await admin.post('/workers', body)).body.worker.host.id).toBe(host.id);
    await admin.post('/hosts', { name: 'Second' });
    expect((await admin.post('/workers', { ...body, name: 'Ambiguous' })).body.error.message).toBe('Choose a host');
  });
});
