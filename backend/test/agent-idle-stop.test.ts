import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers/app';
import type { TestApp } from './helpers/app';
import { assignAgent, assignAndStart, comment, createAgent, createProject, createTask, moveToStatus, statusByName } from './helpers/fixtures';
import { FakeRunner } from './helpers/runner';
import { Stream } from './helpers/stream';

const state = (app: TestApp, agentId: string) => app.runtime.inspect(agentId).then((i) => i.state);

async function setup(app: TestApp) {
  const admin = await app.admin();
  const bundle = await createProject(admin, { name: 'Payments' });
  const { agent } = await createAgent(app, admin, { connect: false });
  const task = await createTask(admin, bundle.project.id, { title: 'Ship it' });
  const stream = new Stream();
  /** Wakes the container with the first Comment and plays one quiet Turn. */
  const work = async () => {
    await assignAndStart(admin, task.id, agent.id);
    await app.settle();
    const runner = await FakeRunner.connect(app, agent.id);
    await runner.runJob([stream.init(), stream.text('On it.'), stream.result()]);
    await app.settle();
    return runner;
  };
  return { admin, bundle, agent, task, work };
}

describe('stopping Agent Containers that have no work', () => {
  const app = useTestApp({ agents: { stopWhenUnused: true } });

  it('keeps an Agent with no Session off, and a pending Session does not start it', async () => {
    const { admin, agent, task } = await setup(app);
    expect(await state(app, agent.id)).toBe('missing');
    await assignAgent(admin, task.id, agent.id);
    await app.settle();
    expect(await state(app, agent.id)).toBe('missing');
  });

  it('starts on the first Comment, stays on while the Task is open, stops when it is closed', async () => {
    const { admin, bundle, agent, task, work } = await setup(app);
    const runner = await work();
    expect(await state(app, agent.id)).toBe('running');

    // `done` still takes Comments, so the container stays up.
    await moveToStatus(admin, task.id, statusByName(bundle, 'Done').id);
    await app.settle();
    expect(await state(app, agent.id)).toBe('running');

    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    await app.settle();
    expect(await state(app, agent.id)).toBe('exited');
    expect((await admin.get(`/agents/${agent.id}`)).body.agent).toMatchObject({ containerState: 'exited', runnerConnected: false });
    await runner.closed;

    // The next 30-second pass leaves a stopped, unused container alone.
    await app.server.ctx.scheduler.reconcileAll();
    expect(await state(app, agent.id)).toBe('exited');
    expect(app.runtime.removed).toEqual([]);
  });

  it('starts again when the Task is reopened and a Comment arrives', async () => {
    const { admin, bundle, agent, task, work } = await setup(app);
    await work();
    await moveToStatus(admin, task.id, statusByName(bundle, 'Closed').id);
    await app.settle();
    expect(await state(app, agent.id)).toBe('exited');

    await moveToStatus(admin, task.id, statusByName(bundle, 'Todo').id);
    await app.settle();
    expect(await state(app, agent.id)).toBe('running');

    const runner = await FakeRunner.connect(app, agent.id);
    await comment(admin, task.id, 'One more thing.');
    await runner.next('job.start');
  });

  it('stops after unassigning the last Task', async () => {
    const { admin, agent, task, work } = await setup(app);
    await work();
    await assignAgent(admin, task.id, null);
    await app.settle();
    expect(await state(app, agent.id)).toBe('exited');
  });
});

describe('Agent Containers with stopping disabled', () => {
  const app = useTestApp({ agents: { stopWhenUnused: false } });

  it('keeps an Agent without work running', async () => {
    const admin = await app.admin();
    const { agent } = await createAgent(app, admin, { connect: false });
    await app.server.ctx.scheduler.reconcileAll();
    expect(await state(app, agent.id)).toBe('running');
  });
});

describe('Restart and Recreate on an Agent without work', () => {
  const app = useTestApp({ agents: { stopWhenUnused: true } });

  it('answers Restart with 409, and applies Recreate when work arrives', async () => {
    const { admin, agent, work } = await setup(app);
    expect((await admin.post(`/agents/${agent.id}/restart`)).status).toBe(409);
    expect((await admin.post(`/agents/${agent.id}/recreate`, {})).status).toBe(200);
    expect(await state(app, agent.id)).toBe('missing');
    await work();
    expect(await state(app, agent.id)).toBe('running');
  });
});
