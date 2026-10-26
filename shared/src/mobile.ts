import { z } from 'zod';

/** Private, per-User state. Position strings avoid loss of bigint precision. */
export interface TaskPreference {
  taskId: string;
  following: boolean;
  muted: boolean;
  readPosition: string;
  latestPosition: string;
  unread: boolean;
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
export type NotificationKind = 'turn.completed' | 'turn.failed' | 'session.intervention';
export interface PushStatus { configured: boolean; provider: 'fcm'; }
export type UserEvent = { type: 'task.preference'; preference: TaskPreference };
