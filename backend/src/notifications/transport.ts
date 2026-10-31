import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import type { App, ServiceAccount } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { NotificationKind, PushAlert } from '@claude-task/shared';
import type { Message } from 'firebase-admin/messaging';

export interface PushMessage {
  token: string;
  eventId: string;
  /** Null for a Schedule event that reports no Task. */
  taskId: string | null;
  kind: NotificationKind;
  alert: PushAlert;
}

/**
 * Android gets data only, so the app draws a conversation notification per Task; iOS gets an alert stacked
 * by a thread per Task. Neither collapses, so every event reaches the phone.
 */
export function fcmMessage(message: PushMessage): Message {
  const { alert } = message;
  const thread = message.taskId ?? message.eventId;
  return {
    token: message.token,
    data: {
      taskId: message.taskId ?? '', eventId: message.eventId, kind: message.kind,
      title: alert.title, sender: alert.sender ?? '', senderKind: alert.senderKind ?? '', text: alert.text,
    },
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-push-type': 'alert', 'apns-priority': '10' },
      payload: { aps: { alert: { title: alert.title, body: alert.sender ? `${alert.sender}: ${alert.text}` : alert.text }, sound: 'default', 'thread-id': thread } },
    },
  };
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
    try {
      await getMessaging(this.app).send(fcmMessage(message));
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
