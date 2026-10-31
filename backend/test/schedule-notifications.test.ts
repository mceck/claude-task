import { randomUUID } from 'node:crypto';
import type { Schedule, ScheduleRun } from '@claude-task/shared';
import { describe, expect, it } from 'vitest';
import type { PushMessage, PushTransport } from '../src/notifications/transport';
import { useTestApp } from './helpers/app';
import type { ApiClient } from './helpers/client';
import { createAgent, createUser } from './helpers/fixtures';
import { Stream } from './helpers/stream';

class RecordingPush implements PushTransport {
  configured = true;
  messages: (PushMessage & { token: string })[] = [];
  async send(message: PushMessage): Promise<'sent' | 'invalid'> {
    this.messages.push(message);
    return 'sent';
  }
}
const push = new RecordingPush();

describe('Schedule alerts', () => {
  const app = useTestApp({ push });

  async function setup() {
    app.server.ctx.pushDispatcher.stop();
    await app.server.ctx.pushDispatcher.settle();
    push.messages = [];
    const admin = await app.admin();
    const second = await createUser(app, admin, { role: 'admin' });
    const phone = async (client: ApiClient, token: string) =>
      expect((await client.put('/notifications/devices', { deviceId: randomUUID(), platform: 'ios', token })).status).toBe(204);
    await phone(admin, 'creator-phone-token-0001');
    await phone(second.client, 'other-admin-phone-token-02');
    const { agent, runner } = await createAgent(app, admin);
    const schedule = (
      await admin.post('/schedules', { name: 'Alerts', agentId: agent.id, cron: '*/10 * * * *', prompt: 'Work.' })
    ).body.schedule as Schedule;
    return { admin, agent, runner, schedule };
  }
  const flush = async () => {
    await app.settle();
    await app.server.ctx.pushDispatcher.dispatch();
  };
  const kinds = () => push.messages.map((m) => m.kind);

  it('alerts the creator, and only the creator, when a run fails', async () => {
    const { admin, runner, schedule } = await setup();
    const run = (await admin.post(`/schedules/${schedule.id}/run`)).body.run as ScheduleRun;
    const start = await runner.next('job.start');
    runner.sendJob({ type: 'job.failed', jobId: start.jobId, stage: 'setup', message: 'boom' });
    await runner.drain();
    await flush();
    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]).toMatchObject({ kind: 'schedule.run_failed', taskId: run.taskId });
  });

  it('sends no alert when a run succeeds', async () => {
    const { admin, runner, schedule } = await setup();
    await admin.post(`/schedules/${schedule.id}/run`);
    const s = new Stream();
    await runner.runJob([s.init(), s.text('Done.'), s.result()]);
    await flush();
    expect(kinds()).not.toContain('schedule.run_failed');
    expect(push.messages).toEqual([]);
  });

  it('alerts the creator once when the Schedule is skipped three times in a row', async () => {
    const { admin, agent, schedule } = await setup();
    expect((await admin.patch(`/agents/${agent.id}`, { enabled: false })).status).toBe(200);
    let current = schedule;
    for (let i = 0; i < 4; i++) {
      await app.server.ctx.scheduler.runSchedules(new Date(new Date(current.nextRunAt!).getTime() + 5_000));
      current = (await admin.get(`/schedules/${schedule.id}`)).body.schedule as Schedule;
      await flush();
      expect(push.messages).toHaveLength(i < 2 ? 0 : 1);
    }
    expect(push.messages[0]).toMatchObject({ kind: 'schedule.blocked', taskId: null });
    expect(current.consecutiveSkips).toBe(4);
  });
});
