import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { useTestApp } from './helpers/app';
import { createWorker } from './helpers/fixtures';

it('defaults to stopping local containers, keeps production containers alive and accepts overrides', () => {
  const env = { DATABASE_URL: 'postgres://localhost/test', SECRETS_MASTER_KEY: Buffer.alloc(32).toString('base64') };
  expect(loadConfig(env).agents.stopOnShutdown).toBe(true);
  expect(loadConfig({ ...env, NODE_ENV: 'production' }).agents.stopOnShutdown).toBe(false);
  expect(loadConfig({ ...env, WORKER_STOP_ON_SHUTDOWN: 'false' }).agents.stopOnShutdown).toBe(false);
  expect(loadConfig({ ...env, NODE_ENV: 'production', WORKER_STOP_ON_SHUTDOWN: 'true' }).agents.stopOnShutdown).toBe(true);
  // The Agent-era names are no longer read.
  expect(loadConfig({ ...env, AGENT_STOP_ON_SHUTDOWN: 'false' }).agents.stopOnShutdown).toBe(true);
  expect(loadConfig({ ...env, WORKER_IDLE_MINUTES: '3' }).agents.idleStopMs).toBe(3 * 60_000);
  expect(loadConfig(env).agents.idleStopMs).toBe(10 * 60_000);
});

for (const stopOnShutdown of [true, false]) {
  describe(`backend shutdown with container stops ${stopOnShutdown ? 'enabled' : 'disabled'}`, () => {
    const app = useTestApp();

    it('applies the configured lifecycle only to its Worker Containers and preserves containers and images', async () => {
      app.server.ctx.config.agents.stopOnShutdown = stopOnShutdown;
      const admin = await app.admin();
      const two = await createWorker(app, admin, { minimum: 2, cap: 2 });
      const disabled = await createWorker(app, admin, { minimum: 1 });
      await admin.patch(`/workers/${disabled.id}`, { enabled: false });
      const image = app.runtime.container(two.id, 1)!.spec.image;
      app.runtime.setState(app.workerId, 1, 'exited');
      await app.runtime.createContainer('another-installation', 1, app.runtime.container(two.id, 1)!.spec);

      await Promise.all([app.server.close(), app.server.close()]);
      for (const [workerId, slot] of [[two.id, 1], [two.id, 2], [disabled.id, 1]] as const) {
        expect((await app.runtime.inspect(workerId, slot)).state).toBe(stopOnShutdown ? 'exited' : 'running');
      }
      expect((await app.runtime.inspect(app.workerId, 1)).state).toBe('exited');
      expect((await app.runtime.inspect('another-installation', 1)).state).toBe('running');
      expect(app.runtime.container(two.id, 1)!.spec.image).toBe(image);
      expect(app.runtime.removed).toEqual([]);
      // Notifications arriving during teardown cannot restart containers or dispatch more work.
      app.server.ctx.scheduler.kick(two.id);
      await app.server.ctx.scheduler.reconcileAll();
      expect((await app.runtime.inspect(two.id, 1)).state).toBe(stopOnShutdown ? 'exited' : 'running');
    });
  });
}

describe('shutdown during a Build', () => {
  const app = useTestApp();

  it('drains the Build and leaves containers stopped without a late recreation', async () => {
    app.server.ctx.config.agents.stopOnShutdown = true;
    const admin = await app.admin();
    const existing = app.runtime.container(app.workerId, 1)!;
    let release!: () => void;
    app.runtime.scriptBuild({ hold: new Promise<void>((resolve) => { release = resolve; }) });
    expect((await admin.post(`/workers/${app.workerId}/rebuild`)).status).toBe(200);
    const closing = app.server.close();
    release();
    await closing;
    expect((await app.runtime.inspect(app.workerId, 1)).state).toBe('exited');
    expect(app.runtime.container(app.workerId, 1)).toBe(existing);
    expect(app.runtime.removed).toEqual([]);
  });
});

describe('shutdown while a Build is still running', () => {
  const app = useTestApp();

  it('stops containers within the grace period instead of waiting for the Build', async () => {
    app.server.ctx.config.agents.stopOnShutdown = true;
    const admin = await app.admin();
    let release!: () => void;
    app.runtime.scriptBuild({ hold: new Promise<void>((resolve) => { release = resolve; }) });
    expect((await admin.post(`/workers/${app.workerId}/rebuild`)).status).toBe(200);
    const closing = app.server.close();
    // The Build is still held, but the container must already be stopping.
    for (let i = 0; i < 100 && (await app.runtime.inspect(app.workerId, 1)).state !== 'exited'; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await app.runtime.inspect(app.workerId, 1)).state).toBe('exited');
    release();
    await closing;
  });
});

for (const trigger of ['rebuild', 'recreate'] as const) describe(`shutdown during container recreation from ${trigger}`, () => {
  const app = useTestApp();

  it('stops a container whose creation completes after the early shutdown stop', async () => {
    app.server.ctx.config.agents.stopOnShutdown = true;
    const admin = await app.admin();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let creating = false, stopped = false;
    const create = app.runtime.createContainer.bind(app.runtime);
    app.runtime.createContainer = async (id, slot, spec) => {
      creating = true;
      await hold;
      await create(id, slot, spec);
    };
    const stop = app.runtime.stopContainer.bind(app.runtime);
    app.runtime.stopContainer = async (id, slot) => { await stop(id, slot); stopped = true; };
    const action = trigger === 'recreate'
      ? admin.post(`/workers/${app.workerId}/containers/1/force-recreate`)
      : admin.post(`/workers/${app.workerId}/rebuild`);
    let closing: Promise<void> | undefined;
    try {
      await expect.poll(() => creating).toBe(true);
      closing = app.server.close();
      await expect.poll(() => stopped).toBe(true);
    } finally { release(); }
    try {
      expect((await action).status).toBe(200);
      // The request may have left a keepalive connection open after HTTP close began.
      // Container stops must finish independently of that connection's idle timeout.
      await expect.poll(async () => (await app.runtime.inspect(app.workerId, 1)).state).toBe('exited');
    } finally {
      app.server.app.server.closeAllConnections();
      await closing;
    }
  });
});

describe('shutdown with a Docker failure', () => {
  const app = useTestApp();

  it('attempts every container stop and reports the error after closing backend resources', async () => {
    app.server.ctx.config.agents.stopOnShutdown = true;
    const admin = await app.admin();
    const second = await createWorker(app, admin, { minimum: 1 });
    const stop = app.runtime.stopContainer.bind(app.runtime);
    app.runtime.stopContainer = async (id, slot) => {
      if (id === app.workerId) throw new Error('Docker refused the stop');
      await stop(id, slot);
    };
    const closing = app.server.close();
    // The fixture's later teardown reuses this already asserted shutdown result.
    app.server.close = () => closing.catch(() => {});
    await expect(closing).rejects.toThrow('Some Worker Containers could not be stopped');
    expect((await app.runtime.inspect(app.workerId, 1)).state).toBe('running');
    expect((await app.runtime.inspect(second.id, 1)).state).toBe('exited');
    expect(app.server.app.server.listening).toBe(false);
  });
});
