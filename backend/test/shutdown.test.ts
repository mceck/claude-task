import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { useTestApp } from './helpers/app';
import { createAgent } from './helpers/fixtures';

it('defaults to stopping local containers, keeps production containers alive and accepts overrides', () => {
  const env = { DATABASE_URL: 'postgres://localhost/test', SECRETS_MASTER_KEY: Buffer.alloc(32).toString('base64') };
  expect(loadConfig(env).agents.stopOnShutdown).toBe(true);
  expect(loadConfig({ ...env, NODE_ENV: 'production' }).agents.stopOnShutdown).toBe(false);
  expect(loadConfig({ ...env, AGENT_STOP_ON_SHUTDOWN: 'false' }).agents.stopOnShutdown).toBe(false);
  expect(loadConfig({ ...env, NODE_ENV: 'production', AGENT_STOP_ON_SHUTDOWN: 'true' }).agents.stopOnShutdown).toBe(true);
});

for (const stopOnShutdown of [true, false]) {
  describe(`backend shutdown with container stops ${stopOnShutdown ? 'enabled' : 'disabled'}`, () => {
    const app = useTestApp();

    it('applies the configured lifecycle only to its Agents and preserves containers and images', async () => {
      app.server.ctx.config.agents.stopOnShutdown = stopOnShutdown;
      const admin = await app.admin();
      const first = await createAgent(app, admin, { connect: false });
      const second = await createAgent(app, admin, { body: { enabled: false }, connect: false });
      const image = app.runtime.containers.get(first.agent.id)!.spec.image;
      const stopped = await createAgent(app, admin, { connect: false });
      app.runtime.setState(stopped.agent.id, 'exited');
      await app.runtime.createContainer('another-installation', app.runtime.containers.get(first.agent.id)!.spec);

      await Promise.all([app.server.close(), app.server.close()]);
      for (const id of [first.agent.id, second.agent.id]) {
        expect((await app.runtime.inspect(id)).state).toBe(stopOnShutdown ? 'exited' : 'running');
      }
      expect((await app.runtime.inspect(stopped.agent.id)).state).toBe('exited');
      expect((await app.runtime.inspect('another-installation')).state).toBe('running');
      expect(app.runtime.containers.get(first.agent.id)!.spec.image).toBe(image);
      expect(app.runtime.removed).toEqual([]);
      // Notifications arriving during teardown cannot restart containers or dispatch more work.
      app.server.ctx.scheduler.kick(first.agent.id);
      await app.server.ctx.scheduler.reconcileAll();
      expect((await app.runtime.inspect(first.agent.id)).state).toBe(stopOnShutdown ? 'exited' : 'running');
    });
  });
}

describe('shutdown during a Build', () => {
  const app = useTestApp();

  it('drains the Build and leaves containers stopped without a late recreation', async () => {
    app.server.ctx.config.agents.stopOnShutdown = true;
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    const existing = app.runtime.containers.get(agent.id)!;
    let release!: () => void;
    app.runtime.scriptBuild({ hold: new Promise<void>((resolve) => { release = resolve; }) });
    expect((await admin.post(`/agents/${agent.id}/rebuild`)).status).toBe(200);
    const closing = app.server.close();
    release();
    await closing;
    expect((await app.runtime.inspect(agent.id)).state).toBe('exited');
    expect(app.runtime.containers.get(agent.id)).toBe(existing);
    expect(app.runtime.removed).toEqual([]);
  });
});

describe('shutdown with a Docker failure', () => {
  const app = useTestApp();

  it('attempts every container stop and reports the error after closing backend resources', async () => {
    app.server.ctx.config.agents.stopOnShutdown = true;
    const admin = await app.admin();
    const first = await createAgent(app, admin, { connect: false });
    const second = await createAgent(app, admin, { connect: false });
    const stop = app.runtime.stopContainer.bind(app.runtime);
    app.runtime.stopContainer = async (id) => {
      if (id === first.agent.id) throw new Error('Docker refused the stop');
      await stop(id);
    };
    const closing = app.server.close();
    // The fixture's later teardown reuses this already asserted shutdown result.
    app.server.close = () => closing.catch(() => {});
    await expect(closing).rejects.toThrow('Some Agent Containers could not be stopped');
    expect((await app.runtime.inspect(first.agent.id)).state).toBe('running');
    expect((await app.runtime.inspect(second.agent.id)).state).toBe('exited');
    expect(app.server.app.server.listening).toBe(false);
  });
});
