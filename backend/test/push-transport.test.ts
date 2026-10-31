import { describe, expect, it } from 'vitest';
import { fcmMessage } from '../src/notifications/transport';

const base = {
  token: 'device-token', eventId: 'turn:job:1', taskId: 'task-1', kind: 'turn.completed' as const,
  alert: { title: 'API-42 · Fix login', sender: 'Opus', senderKind: 'agent' as const, text: 'Tests are green.' },
};

describe('FCM message', () => {
  it('sends Android data only, without collapsing, so the app draws the conversation', () => {
    const m = fcmMessage(base);
    expect(m).not.toHaveProperty('notification');
    expect(m.android).toEqual({ priority: 'high' });
    expect(m.data).toEqual({
      taskId: 'task-1', eventId: 'turn:job:1', kind: 'turn.completed',
      title: 'API-42 · Fix login', sender: 'Opus', senderKind: 'agent', text: 'Tests are green.',
    });
  });

  it('sends iOS an alert stacked by a thread per Task, without a collapse id', () => {
    const m = fcmMessage(base);
    expect(m.apns?.headers).toEqual({ 'apns-push-type': 'alert', 'apns-priority': '10' });
    expect(m.apns?.payload?.aps).toEqual({
      alert: { title: 'API-42 · Fix login', body: 'Opus: Tests are green.' }, sound: 'default', 'thread-id': 'task-1',
    });
  });

  it('threads a Schedule alert without a Task by its event, with no sender', () => {
    const m = fcmMessage({
      ...base, taskId: null, eventId: 'schedule-blocked:run', kind: 'schedule.blocked',
      alert: { title: 'Nightly', sender: null, senderKind: null, text: 'Schedule "Nightly": keeps being skipped' },
    });
    expect(m.apns?.payload?.aps).toMatchObject({ alert: { body: 'Schedule "Nightly": keeps being skipped' }, 'thread-id': 'schedule-blocked:run' });
    expect(m.data).toMatchObject({ taskId: '', sender: '', senderKind: '' });
  });
});
