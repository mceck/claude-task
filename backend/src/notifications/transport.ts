import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import type { App, ServiceAccount } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { NotificationKind } from '@claude-task/shared';

export interface PushMessage {
  token: string;
  eventId: string;
  taskId: string;
  kind: NotificationKind;
}
export class PushTransportError extends Error {
  constructor(readonly retryable: boolean) { super('Push transport failed'); }
}

export interface PushTransport {
  readonly configured: boolean;
  send(message: PushMessage): Promise<'sent' | 'invalid'>;
  close?(): Promise<void>;
}

/** FCM HTTP v1, including APNs alert delivery while the phone app is terminated. */
export class FirebasePushTransport implements PushTransport {
  private readonly app: App | null;
  constructor(serviceAccountFile?: string) {
    this.app = serviceAccountFile ? initializeApp({
      credential: cert(JSON.parse(readFileSync(serviceAccountFile, 'utf8')) as ServiceAccount),
    }, `push-${randomUUID()}`) : null;
  }
  get configured(): boolean { return this.app !== null; }
  async send(message: PushMessage): Promise<'sent' | 'invalid'> {
    if (!this.app) throw new Error('Phone push is not configured');
    // Collapse per Task, so a burst of events on one Task shows a single alert.
    const taskKey = createHash('sha256').update(message.taskId).digest('hex');
    try {
      await getMessaging(this.app).send({
        token: message.token,
        // No title, body, Project name or generated prose from a Task on the lock screen.
        notification: { title: 'Claude Task', body: 'A Task you follow has an update.' },
        data: { taskId: message.taskId, eventId: message.eventId, kind: message.kind },
        android: { priority: 'high', collapseKey: taskKey, notification: { tag: taskKey } },
        apns: { headers: { 'apns-collapse-id': taskKey, 'apns-push-type': 'alert', 'apns-priority': '10' },
          payload: { aps: { sound: 'default', 'thread-id': message.taskId } } },
      });
      return 'sent';
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') return 'invalid';
      // Never propagate provider errors: they can embed a device token.
      throw new PushTransportError(code === 'messaging/server-unavailable' || code === 'messaging/internal-error' || code === 'messaging/quota-exceeded');
    }
  }
  async close(): Promise<void> { if (this.app) await deleteApp(this.app); }
}
