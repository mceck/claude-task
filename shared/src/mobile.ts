import { z } from 'zod';

/** Private, per-User state. Position strings avoid loss of bigint precision. */
export interface TaskPreference {
  taskId: string;
  following: boolean;
  muted: boolean;
  readPosition: string;
  latestPosition: string;
  unread: boolean;
  /** Non-deleted Comments newer than the read position. */
  unreadComments: number;
}
export const taskPreferenceBody = z.strictObject({
  following: z.boolean().optional(),
  muted: z.boolean().optional(),
}).refine((v) => v.following !== undefined || v.muted !== undefined, 'A preference is required');
export const readPositionBody = z.strictObject({ itemId: z.uuid() });
export const deviceRegistrationBody = z.strictObject({
  deviceId: z.uuid(),
  platform: z.enum(['ios', 'android']),
  token: z.string().trim().min(16).max(4096),
});
export type NotificationKind = 'turn.completed' | 'turn.failed' | 'session.intervention' | 'comment.mentioned' | 'schedule.run_failed' | 'schedule.blocked';
export interface PushStatus { configured: boolean; provider: 'fcm'; }
/** What an Alert shows: its conversation, who it is from and what happened (docs/specs/conversation.md#alert-content). */
export interface PushAlert {
  title: string;
  /** The Agent or User the Alert is from; null for Schedule Alerts. */
  sender: string | null;
  senderKind: 'agent' | 'user' | null;
  text: string;
}
export type UserEvent = { type: 'task.preference'; preference: TaskPreference };
