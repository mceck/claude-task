import { sql } from 'drizzle-orm';
import { DEFAULT_AGENT_DOCKERFILE, workerTopic } from '@claude-task/shared';
import type { JobStartMessage, Worker } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { TestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { assignAgent, assignAndStart, comment, createAgent, createProject, createTask, createUser, createWorker, getSession, moveToStatus, statusByName } from './helpers/fixtures';
import { FakeRunner } from './helpers/runner';
import { Stream } from './helpers/stream';
import { WsTestClient } from './helpers/ws';

const getWorker = async (admin: ApiClient, id: string) => (await admin.get(`/workers/${id}`)).body.worker as Worker;

/** Connects a fake Runner to every running container of the Worker that has none yet. */
async function connectRunning(app: TestApp, workerId: string, known: Map<number, FakeRunner>): Promise<Map<number, FakeRunner>> {
  for (const slot of app.runtime.runningSlots(workerId)) {
    if (known.get(slot)?.open) continue;
    known.set(slot, await FakeRunner.connect(app, { workerId, slot }));
  }
  return known;
}

/** The first job.start any of the Runners received for a Job not seen yet. */
async function nextStart(runners: Map<number, FakeRunner>, seen: Set<string>): Promise<{ slot: number; start: JobStartMessage }> {
  for (let i = 0; i < 100; i++) {
    for (const [slot, runner] of runners) {
      const start = runner.messages('job.start').find((m) => !seen.has(m.jobId));
      if (start) {
        seen.add(start.jobId);
        return { slot, start };
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no job.start arrived');
}

async function finish(runner: FakeRunner, start: JobStartMessage): Promise<void> {
  runner.accept(start.jobId);
  const s = new Stream(start.sessionId);
  await runner.play(start.jobId, [s.init(), s.text('Done.'), s.result()]);
  await runner.next('job.end', (m) => m.jobId === start.jobId);
  await runner.exit(start.jobId);
}

describe('workers', () => {
  const app = useTestApp({ defaultWorker: false });

  it('builds the image, starts the slots up to the minimum with its limits, and goes idle once the Runner connects', async () => {
    const admin = await app.admin();
    const res = await admin.post('/workers', { name: 'Toolchain', dockerfile: DEFAULT_AGENT_DOCKERFILE, cpuLimit: 2, memoryMb: 4096, minimum: 1, cap: 3 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.worker.id;
    expect(res.body.worker).toMatchObject({ services: ['postgres', 'redis'], minimum: 1, cap: 3 });
    await app.settle();
    expect(app.runtime.builds[0]!.dockerfile).toContain('RUN /usr/local/bin/claude-task-install-services postgres redis\n');

    expect(app.runtime.runningSlots(id)).toEqual([1]);
    const container = app.runtime.container(id, 1)!;
    expect(container.spec).toMatchObject({ cpuLimit: 2, memoryMb: 4096, image: expect.stringContaining(`claude-task/worker-${id}:`) });
    expect(container.spec.env).toEqual({ CLAUDE_TASK_BACKEND_URL: 'ws://backend.test/api/v1/runner', CLAUDE_TASK_RUNNER_TOKEN: expect.any(String) });
    const worker = await getWorker(admin, id);
    expect(worker).toMatchObject({ state: 'offline', imageState: 'built', running: 1, busy: 0 });
    expect(worker.containers.map((c) => [c.slot, c.state])).toEqual([[1, 'starting'], [2, 'stopped'], [3, 'stopped']]);

    const builds = (await admin.get(`/workers/${id}/builds`)).body.builds;
    expect(builds).toMatchObject([{ status: 'succeeded', baseVersion: 'fake-1' }]);
    expect(builds[0].log).toContain('FROM claude-task/agent-base:fake-1');

    await FakeRunner.connect(app, id);
    expect(await getWorker(admin, id)).toMatchObject({ state: 'idle', containers: [{ slot: 1, state: 'idle', runnerConnected: true }, {}, {}] });
  });

  it('streams the build log live on the Worker topic', async () => {
    const admin = await app.admin();
    const ws = await WsTestClient.connect(app.url, admin.cookie);
    let release!: () => void;
    app.runtime.scriptBuild({ log: 'Step 1/3 : FROM claude-task/agent-base\n', hold: new Promise<void>((r) => (release = r)) });
    const res = await admin.post('/workers', { name: 'Streamer', dockerfile: DEFAULT_AGENT_DOCKERFILE });
    await ws.subscribe(workerTopic(res.body.worker.id));
    await new Promise((r) => setTimeout(r, 50));
    expect((await getWorker(admin, res.body.worker.id)).state).toBe('building');
    release();
    await app.settle();
    expect((await admin.get(`/workers/${res.body.worker.id}/builds`)).body.builds[0].log).toContain('Step 1/3');
    expect(ws.events('build.updated').map((e) => e.build.status)).toContain('succeeded');
    ws.close();
  });

  it('validates its fields: Dockerfile, services, minimum within the cap, cap up to 20 and a unique name', async () => {
    const admin = await app.admin();
    for (const dockerfile of ['FROM node:22\nUSER agent\n', 'RUN echo hi\nFROM claude-task/agent-base\n', 'FROM claude-task/agent-base-evil\n'])
      expect((await admin.post('/workers', { name: 'Bad', dockerfile })).status, dockerfile).toBe(400);
    for (const body of [{ services: ['mongo'] }, { services: ['redis', 'redis'] }, { minimum: 3, cap: 2 }, { cap: 21 }, { cap: 0 }, { minimum: -1 }])
      expect((await admin.post('/workers', { name: 'Bad', dockerfile: DEFAULT_AGENT_DOCKERFILE, ...body })).status, JSON.stringify(body)).toBe(400);
    const worker = await createWorker(app, admin, { name: 'Unique', services: ['rustfs', 'mysql', 'mailpit'], cap: 2 });
    expect(worker.services).toEqual(['mysql', 'mailpit', 'rustfs']);
    expect((await admin.post('/workers', { name: 'unique', dockerfile: DEFAULT_AGENT_DOCKERFILE })).status).toBe(409);
    expect((await admin.patch(`/workers/${worker.id}`, { minimum: 3 })).status).toBe(400);
    expect((await admin.patch(`/workers/${worker.id}`, { cap: 4, minimum: 3 })).status).toBe(200);
    const tagged = await admin.post('/workers', { name: 'Tagged', dockerfile: '# toolchains\nARG X=1\nFROM claude-task/agent-base:latest AS base\nUSER agent\n' });
    expect(tagged.status).toBe(201);
  });

  it('rebuilds only when the Dockerfile or the services change', async () => {
    const admin = await app.admin();
    const worker = await createWorker(app, admin, { minimum: 1 });
    const count = app.runtime.builds.length;
    await admin.patch(`/workers/${worker.id}`, { description: 'Updated', cap: 2 });
    await admin.patch(`/workers/${worker.id}`, { services: ['redis', 'postgres'] });
    await app.settle();
    expect(app.runtime.builds).toHaveLength(count);
    const oldImage = app.runtime.container(worker.id, 1)!.spec.image;
    await admin.patch(`/workers/${worker.id}`, { services: [] });
    await app.settle();
    expect(app.runtime.builds.at(-1)!.dockerfile).toContain('ENV CLAUDE_TASK_SERVICES=""');
    expect(app.runtime.container(worker.id, 1)!.spec.image).not.toBe(oldImage);
  });

  it('fails a build whose image does not end as USER agent, and keeps the previous image when a rebuild fails', async () => {
    const admin = await app.admin();
    app.runtime.scriptBuild({ user: 'root' });
    const broken = await createWorker(app, admin, { minimum: 1 });
    expect(broken).toMatchObject({ state: 'build_failed', imageState: 'failed' });
    expect((await admin.get(`/workers/${broken.id}/builds`)).body.builds[0].log).toContain('must end with `USER agent`');
    expect(app.runtime.container(broken.id, 1)).toBeUndefined();

    const worker = await createWorker(app, admin, { minimum: 1 });
    const before = app.runtime.container(worker.id, 1)!.spec.image;
    app.runtime.scriptBuild({ fail: 'apt-get: package not found' });
    await admin.patch(`/workers/${worker.id}`, { services: ['mysql'] });
    await app.settle();
    expect(app.runtime.container(worker.id, 1)!.spec.image).toBe(before);
    expect(await getWorker(admin, worker.id)).toMatchObject({ state: 'build_failed', containers: [{ containerState: 'running' }] });
  });

  it('recreates each container with a new image once it is free, and Force recreate interrupts its Job', async () => {
    const admin = await app.admin();
    const worker = await createWorker(app, admin, { minimum: 2, cap: 2 });
    const { project } = await createProject(admin, { workerId: worker.id });
    const { agent } = await createAgent(app, admin, { connect: false });
    const runners = await connectRunning(app, worker.id, new Map());
    const seen = new Set<string>();
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const { slot, start } = await nextStart(runners, seen);
    const runner = runners.get(slot)!;
    runner.accept(start.jobId);
    await runner.drain();
    const other = slot === 1 ? 2 : 1;
    const images = () => [app.runtime.container(worker.id, 1)!.spec.image, app.runtime.container(worker.id, 2)!.spec.image];
    const [oldImage] = images();

    await admin.patch(`/workers/${worker.id}`, { services: ['mysql'] });
    await app.settle();
    // The free container switches right away; the busy one waits for its Job.
    expect(app.runtime.container(worker.id, other)!.spec.image).not.toBe(oldImage);
    expect(app.runtime.container(worker.id, slot)!.spec.image).toBe(oldImage);
    expect((await getWorker(admin, worker.id)).containers.find((c) => c.slot === slot)).toMatchObject({ recreatePending: true, state: 'working' });

    expect((await admin.post(`/workers/${worker.id}/containers/${slot}/force-recreate`)).status).toBe(200);
    await app.settle();
    expect((await runner.closed).code).toBe(4002);
    expect(app.runtime.container(worker.id, slot)!.spec.image).not.toBe(oldImage);
    const fresh = await FakeRunner.connect(app, { workerId: worker.id, slot });
    const resumed = await fresh.next('job.start');
    expect(resumed).toMatchObject({ sessionId: start.sessionId });
  });

  it('restarts a Build interrupted by a backend restart, rebuilds on a new Platform Version and restarts a stopped container', async () => {
    const admin = await app.admin();
    const worker = await createWorker(app, admin, { minimum: 1 });
    const before = app.runtime.builds.length;
    await app.server.ctx.db.execute(sql`insert into worker_builds (worker_id, dockerfile, base_version, status)
      values (${worker.id}::uuid, 'FROM claude-task/agent-base', 'fake-1', 'building')`);
    const { resetInterruptedBuilds } = await import('../src/modules/workers/builds');
    await resetInterruptedBuilds(app.server.ctx.db);
    await app.server.ctx.scheduler.reconcileAll();
    await app.settle();
    expect(app.runtime.builds.length).toBeGreaterThan(before);

    app.runtime.upgrade('fake-2');
    await app.server.ctx.scheduler.reconcileAll();
    await app.settle();
    const builds = (await admin.get(`/workers/${worker.id}/builds`)).body.builds;
    expect(builds[0].baseVersion).toBe('fake-2');
    expect(app.runtime.container(worker.id, 1)!.spec.image).toContain(builds[0].id.slice(0, 12));

    app.runtime.setState(worker.id, 1, 'exited');
    await app.server.ctx.scheduler.reconcileAll();
    expect(app.runtime.container(worker.id, 1)!.state).toBe('running');
  });

  it('duplicates a Worker with its configuration and its own Build', async () => {
    const admin = await app.admin();
    const worker = await createWorker(app, admin, { name: 'Flutter', services: ['mysql'], minimum: 1, cap: 3, cpuLimit: 1.5 });
    const res = await admin.post(`/workers/${worker.id}/duplicate`, {});
    expect(res.status).toBe(201);
    expect(res.body.worker).toMatchObject({ name: 'Flutter (copy)', services: ['mysql'], minimum: 1, cap: 3, cpuLimit: 1.5, dockerfile: worker.dockerfile });
    await app.settle();
    expect(app.runtime.container(res.body.worker.id, 1)).toBeDefined();
    expect((await admin.post(`/workers/${worker.id}/duplicate`, { name: 'Flutter' })).status).toBe(409);
  });

  it('refuses deleting a Worker that runs Projects, and removes its containers and volumes otherwise', async () => {
    const admin = await app.admin();
    const worker = await createWorker(app, admin, { minimum: 1 });
    const { project } = await createProject(admin, { workerId: worker.id, name: 'Mobile' });
    const blocked = await admin.delete(`/workers/${worker.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Mobile');

    const other = await createWorker(app, admin);
    expect((await admin.patch(`/projects/${project.id}/agent-settings`, { workerId: other.id })).status).toBe(200);
    expect((await admin.delete(`/workers/${worker.id}`)).status).toBe(204);
    await app.settle();
    expect(app.runtime.removed).toContain(worker.id);
    expect((await admin.get(`/workers/${worker.id}`)).status).toBe(404);
  });

  it('lets members see Workers and their Queue but not change them', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const worker = await createWorker(app, admin, { minimum: 1 });
    expect((await member.get('/workers')).body.workers.map((w: Worker) => w.id)).toEqual([worker.id]);
    expect((await member.get(`/workers/${worker.id}/queue`)).status).toBe(200);
    expect((await member.get(`/workers/${worker.id}/builds`)).status).toBe(200);
    const attempts = [
      member.post('/workers', { name: 'X', dockerfile: DEFAULT_AGENT_DOCKERFILE }),
      member.patch(`/workers/${worker.id}`, { enabled: false }),
      member.delete(`/workers/${worker.id}`),
      member.post(`/workers/${worker.id}/rebuild`),
      member.post(`/workers/${worker.id}/recreate`),
      member.post(`/workers/${worker.id}/duplicate`, {}),
      member.post(`/workers/${worker.id}/containers/1/restart`),
      member.post(`/workers/${worker.id}/containers/1/force-recreate`),
      member.get(`/workers/${worker.id}/containers/1/logs`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
  });

  it('refuses unknown Runner tokens and drops a Runner that stops answering pings', async () => {
    const admin = await app.admin();
    const worker = await createWorker(app, admin, { minimum: 1 });
    await expect(FakeRunner.connect(app, worker.id, { token: 'nope' })).rejects.toThrow(/401/);
    const config = app.server.ctx.config.agents;
    config.runnerPingIntervalMs = 50;
    try {
      const runner = await FakeRunner.connect(app, worker.id, { autoPong: false });
      await expect(Promise.race([runner.closed, new Promise((r) => setTimeout(() => r('still open'), 2000))])).resolves.not.toBe('still open');
      await app.settle();
      expect((await getWorker(admin, worker.id)).containers[0]!.runnerConnected).toBe(false);
    } finally {
      delete config.runnerPingIntervalMs;
    }
  });
});

describe('autoscaling between the minimum and the cap', () => {
  const app = useTestApp({ defaultWorker: false, agents: { stopWhenUnused: true, idleStopMs: 60_000 } });

  async function scaled(opts: { minimum?: number; cap?: number } = {}) {
    const admin = await app.admin();
    const worker = await createWorker(app, admin, { minimum: opts.minimum ?? 0, cap: opts.cap ?? 2 });
    const bundle = await createProject(admin, { workerId: worker.id });
    const { agent } = await createAgent(app, admin, { connect: false });
    return { admin, worker, bundle, project: bundle.project, agent, runners: new Map<number, FakeRunner>(), seen: new Set<string>() };
  }

  /** Pretends the container has had no Job for longer than the idle timeout. */
  const idleFor = (app: TestApp, workerId: string, slot: number, ms: number) =>
    app.server.ctx.db.execute(sql`update worker_containers set idle_since = now() - ${ms} * interval '1 millisecond' where worker_id = ${workerId}::uuid and slot = ${slot}`);

  it('starts nothing for a pending Session, then one container per waiting Task up to the cap, for one Agent in parallel', async () => {
    const { admin, worker, project, agent, runners, seen } = await scaled();
    expect(app.runtime.runningSlots(worker.id)).toEqual([]);
    const tasks = [await createTask(admin, project.id), await createTask(admin, project.id), await createTask(admin, project.id)];
    await assignAgent(admin, tasks[0]!.id, agent.id);
    await app.settle();
    expect(app.runtime.runningSlots(worker.id)).toEqual([]);

    for (const t of tasks) await assignAndStart(admin, t.id, agent.id);
    await app.settle();
    expect(app.runtime.runningSlots(worker.id)).toEqual([1, 2]);
    await connectRunning(app, worker.id, runners);
    const first = await nextStart(runners, seen);
    const second = await nextStart(runners, seen);
    expect(new Set([first.slot, second.slot])).toEqual(new Set([1, 2]));
    expect(await getWorker(admin, worker.id)).toMatchObject({ state: 'working', busy: 2, running: 2, queueLength: 1 });
    expect((await admin.get(`/agents/${agent.id}`)).body.agent).toMatchObject({ state: 'working', activeJobs: 2 });

    // The third Task waits for a free container, then runs there.
    await finish(runners.get(first.slot)!, first.start);
    const third = await nextStart(runners, seen);
    expect(third.slot).toBe(first.slot);
  });

  it("prefers the container that worked the Task last, while it's free", async () => {
    const { admin, worker, project, agent, runners, seen } = await scaled({ minimum: 2 });
    await connectRunning(app, worker.id, runners);
    const a = await createTask(admin, project.id);
    const b = await createTask(admin, project.id);
    await assignAndStart(admin, a.id, agent.id);
    const onA = await nextStart(runners, seen);
    await assignAndStart(admin, b.id, agent.id);
    const onB = await nextStart(runners, seen);
    expect(onA.slot).toBe(1);
    expect(onB.slot).toBe(2);
    await finish(runners.get(1)!, onA.start);
    await finish(runners.get(2)!, onB.start);

    // Both are free: B goes back to slot 2 although slot 1 comes first.
    await comment(admin, b.id, 'One more thing.');
    const again = await nextStart(runners, seen);
    expect(again).toMatchObject({ slot: 2, start: { sessionId: onB.start.sessionId, mode: 'resume' } });
  });

  it('stops a container above the minimum after the idle timeout, and keeps the minimum running', async () => {
    const { admin, worker, project, agent, runners, seen } = await scaled({ minimum: 1, cap: 2 });
    await connectRunning(app, worker.id, runners);
    const tasks = [await createTask(admin, project.id), await createTask(admin, project.id)];
    for (const t of tasks) await assignAndStart(admin, t.id, agent.id);
    await app.settle();
    await connectRunning(app, worker.id, runners);
    const one = await nextStart(runners, seen);
    const two = await nextStart(runners, seen);
    await finish(runners.get(one.slot)!, one.start);
    await finish(runners.get(two.slot)!, two.start);
    await app.server.ctx.scheduler.reconcileAll();
    // Idle for less than the timeout: both stay up, the open Sessions keep nothing running.
    expect(app.runtime.runningSlots(worker.id)).toEqual([1, 2]);

    await idleFor(app, worker.id, 1, 120_000);
    await idleFor(app, worker.id, 2, 120_000);
    await app.server.ctx.scheduler.reconcileAll();
    expect(app.runtime.runningSlots(worker.id)).toEqual([1]);
    expect((await runners.get(2)!.closed).code).toBe(4003);
    expect(app.runtime.container(worker.id, 2)!.state).toBe('exited');
    expect(await getWorker(admin, worker.id)).toMatchObject({ running: 1, containers: [{ slot: 1, state: 'idle' }, { slot: 2, state: 'stopped' }] });

    // An idle Session wakes up through the Queue.
    await comment(admin, tasks[0]!.id, 'Back again');
    const resumed = await nextStart(runners, seen);
    expect(resumed.slot).toBe(1);
  });

  it('stops the slots above a lowered cap once they are free, keeping them for later', async () => {
    const { admin, worker } = await scaled({ minimum: 3, cap: 3 });
    expect(app.runtime.runningSlots(worker.id)).toEqual([1, 2, 3]);
    expect((await admin.patch(`/workers/${worker.id}`, { minimum: 1, cap: 1 })).status).toBe(200);
    await app.settle();
    expect(app.runtime.runningSlots(worker.id)).toEqual([1]);
    expect(app.runtime.container(worker.id, 3)!.state).toBe('exited');
    expect((await getWorker(admin, worker.id)).containers.map((c) => c.slot)).toEqual([1, 2, 3]);
  });

  it('starts nothing for a disabled Worker and dispatches once it is enabled again', async () => {
    const { admin, worker, project, agent, runners, seen } = await scaled();
    await admin.patch(`/workers/${worker.id}`, { enabled: false });
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    await app.settle();
    expect(app.runtime.runningSlots(worker.id)).toEqual([]);
    expect(await getWorker(admin, worker.id)).toMatchObject({ state: 'disabled', queueLength: 1 });
    await admin.patch(`/workers/${worker.id}`, { enabled: true });
    await app.settle();
    await connectRunning(app, worker.id, runners);
    expect((await nextStart(runners, seen)).slot).toBe(1);
  });

  it('runs the Chats of one Wiki one at a time, since they share a Worktree', async () => {
    const { admin, worker, agent, runners, seen } = await scaled({ minimum: 2 });
    await connectRunning(app, worker.id, runners);
    const created = await admin.post('/wikis', { name: 'Docs', agentId: agent.id, workerId: worker.id, repository: { connectionId: 'env-github', providerRepoId: '1' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const wiki = created.body.wiki;
    await comment(admin, wiki.taskId, 'First chat');
    const chat = (await admin.post(`/wikis/${wiki.id}/chats`)).body.chat;
    await comment(admin, chat.id, 'Second chat');
    const first = await nextStart(runners, seen);
    await app.settle();
    expect([...runners.values()].flatMap((r) => r.messages('job.start'))).toHaveLength(1);
    expect(await getWorker(admin, worker.id)).toMatchObject({ busy: 1, queueLength: 1 });
    await finish(runners.get(first.slot)!, first.start);
    const second = await nextStart(runners, seen);
    expect(second.start.worktreePath).toBe(first.start.worktreePath);
  });

  it('moves the Task to another slot when its own is busy, and the Session still resumes there', async () => {
    const { admin, worker, project, agent, runners, seen } = await scaled({ minimum: 2 });
    await connectRunning(app, worker.id, runners);
    const a = await createTask(admin, project.id);
    const b = await createTask(admin, project.id);
    await assignAndStart(admin, a.id, agent.id);
    const onA = await nextStart(runners, seen);
    await finish(runners.get(onA.slot)!, onA.start);
    await assignAndStart(admin, b.id, agent.id);
    const onB = await nextStart(runners, seen);
    expect(onB.slot).toBe(onA.slot);
    await comment(admin, a.id, 'Meanwhile');
    const moved = await nextStart(runners, seen);
    expect(moved.slot).not.toBe(onA.slot);
    expect(moved.start).toMatchObject({ sessionId: onA.start.sessionId, mode: 'resume', worktreePath: onA.start.worktreePath });
  });
});

describe('assigning Workers to Projects', () => {
  const app = useTestApp();

  it('requires an existing Worker to create a Project', async () => {
    const admin = await app.admin();
    expect((await admin.post('/projects', { key: 'NOWRK', name: 'No worker' })).status).toBe(400);
    expect((await admin.post('/projects', { key: 'BADWK', name: 'Bad worker', workerId: crypto.randomUUID() })).status).toBe(400);
    const { project } = await createProject(admin, { workerId: app.workerId });
    expect(project.workerId).toBe(app.workerId);
    expect((await admin.get(`/projects/${project.id}/agent-settings`)).body.settings.workerId).toBe(app.workerId);
  });

  it('refuses a new Worker while a Session has started, and moves the Queue Entries of the others along', async () => {
    const admin = await app.admin();
    const { client: member } = await createUser(app, admin);
    const bundle = await createProject(admin);
    const { agent, runner } = await createAgent(app, admin);
    const other = await createWorker(app, admin, { name: 'Other' });
    const started = await createTask(admin, bundle.project.id);
    await assignAndStart(admin, started.id, agent.id);
    await runner.runJob([new Stream().init(), new Stream().result()]);
    // Busy elsewhere, so this one waits in the Queue without having started.
    const busy = await createTask(admin, bundle.project.id);
    await assignAndStart(admin, busy.id, agent.id);
    const busyStart = await runner.next('job.start', (m) => m.jobId !== runner.messages('job.start')[0]!.jobId);
    const waiting = await createTask(admin, bundle.project.id);

    const refused = await member.patch(`/projects/${bundle.project.id}/agent-settings`, { workerId: other.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain(started.key);

    runner.accept(busyStart.jobId);
    await runner.exit(busyStart.jobId);
    for (const t of [started, busy]) await moveToStatus(admin, t.id, statusByName(bundle, 'Closed').id);
    await app.settle();
    const blocker = await createTask(admin, bundle.project.id);
    await assignAndStart(admin, blocker.id, agent.id);
    const blockerStart = await runner.next('job.start', (m) => m.jobId !== busyStart.jobId && !runner.messages('job.start').slice(0, 2).some((s) => s.jobId === m.jobId));
    await assignAndStart(admin, waiting.id, agent.id, 'Waiting for my turn.');
    // A Job of the Project still runs: the change waits for it.
    expect((await member.patch(`/projects/${bundle.project.id}/agent-settings`, { workerId: other.id })).status).toBe(409);
    // The waiting Task never starts on this Worker while it is disabled.
    expect((await admin.patch(`/workers/${app.workerId}`, { enabled: false })).status).toBe(200);
    runner.accept(blockerStart.jobId);
    await runner.exit(blockerStart.jobId);
    await moveToStatus(admin, blocker.id, statusByName(bundle, 'Closed').id);
    // The waiting Task never started: its entry follows the Project to the new Worker.
    const moved = await member.patch(`/projects/${bundle.project.id}/agent-settings`, { workerId: other.id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await admin.get(`/workers/${other.id}/queue`)).body.entries).toMatchObject([{ task: { id: waiting.id }, agent: { id: agent.id } }]);
    expect((await admin.get(`/workers/${app.workerId}/queue`)).body.entries).toEqual([]);
    expect((await admin.get(`/projects/${bundle.project.id}`)).body.project.workerId).toBe(other.id);
    expect(await getSession(admin, waiting.id)).toMatchObject({ state: 'pending', queuePosition: 1 });
  });
});

describe('Agent Profiles', () => {
  const app = useTestApp();

  it("synchronizes an Agent's Profile before its first Job on a Worker, and runs claude with it", async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent, runner } = await createAgent(app, admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    const start = await runner.next('job.start');
    expect(start.agentProfilePath).toBe(`.claude-agents/${agent.id}`);
    expect(app.runtime.profileSyncs.filter((p) => p.agentId === agent.id)).toEqual([expect.objectContaining({ workerId: app.workerId, slot: 1 })]);
    expect(app.runtime.profiles.get(`${app.workerId}:${agent.id}`)).toMatchObject({ agentId: agent.id, slot: 1 });
  });

  it("holds only the failing Agent's work while its Profile cannot synchronize, and shows the error", async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent: broken, runner } = await createAgent(app, admin, { name: 'Broken Bot' });
    const { agent: healthy } = await createAgent(app, admin, { name: 'Healthy Bot' });
    app.runtime.profileFailure = (agentId) => (agentId === broken.id ? 'Plugin missing@market: install failed' : null);
    try {
      const first = await createTask(admin, project.id);
      const second = await createTask(admin, project.id);
      await assignAndStart(admin, first.id, broken.id);
      await assignAndStart(admin, second.id, healthy.id);
      const start = await runner.next('job.start');
      expect(start.agentProfilePath).toBe(`.claude-agents/${healthy.id}`);
      expect((await admin.get(`/agents/${broken.id}`)).body.agent).toMatchObject({
        extensionsError: 'Plugin missing@market: install failed',
        extensionErrors: [{ workerId: app.workerId, error: 'Plugin missing@market: install failed' }],
      });
      expect((await admin.get(`/workers/${app.workerId}`)).body.worker.profileErrors).toMatchObject([{ agentId: broken.id, agentName: 'Broken Bot' }]);
      expect(await getSession(admin, first.id)).toMatchObject({ state: 'pending', queuePosition: 1 });

      app.runtime.profileFailure = null;
      runner.accept(start.jobId);
      await runner.exit(start.jobId);
      await app.server.ctx.scheduler.reconcileAll();
      await app.settle();
      const next = await runner.next('job.start', (m) => m.jobId !== start.jobId);
      expect(next.agentProfilePath).toBe(`.claude-agents/${broken.id}`);
      expect((await admin.get(`/agents/${broken.id}`)).body.agent.extensionErrors).toEqual([]);
    } finally {
      app.runtime.profileFailure = null;
    }
  });

  it('keeps the Profiles across a container recreation, since they live on the Worker Volume', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const { agent, runner } = await createAgent(app, admin);
    const task = await createTask(admin, project.id);
    await assignAndStart(admin, task.id, agent.id);
    await runner.runJob([new Stream().init(), new Stream().result()]);
    const syncs = app.runtime.profileSyncs.length;
    expect((await admin.post(`/workers/${app.workerId}/recreate`)).status).toBe(200);
    await app.settle();
    const fresh = await FakeRunner.connect(app, app.workerId);
    await comment(admin, task.id, 'After the recreation');
    await fresh.next('job.start');
    expect(app.runtime.profileSyncs).toHaveLength(syncs);
  });
});
