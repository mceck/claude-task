import { z } from 'zod';

export const VOICE_ROOM_LIMIT = 6;
export const VOICE_CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_VOICE_STUN_URLS = ['stun:stun.l.google.com:19302'];

export interface VoiceParticipant {
  id: string;
  user: { id: string; displayName: string };
  muted: boolean;
}
export interface VoiceRoom {
  taskId: string;
  taskKey: string;
  participants: VoiceParticipant[];
}
const id = z.uuid();
const requestId = z.string().min(1).max(64);
export const voiceSignalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('offer'), exchangeId: id, sdp: z.string().min(1).max(16 * 1024) }).strict(),
  z.object({ type: z.literal('answer'), exchangeId: id, sdp: z.string().min(1).max(16 * 1024) }).strict(),
  z.object({ type: z.literal('candidate'), exchangeId: id, candidate: z.string().min(1).max(2048).refine((value) => !/\btyp\s+relay\b/.test(value)), sdpMid: z.string().max(256).nullable(), sdpMLineIndex: z.number().int().min(0).max(65535).nullable() }).strict(),
  z.object({ type: z.literal('retry') }).strict(),
]);
export type VoiceSignal = z.infer<typeof voiceSignalSchema>;
export const voiceCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('voice.join'), requestId, taskId: id, replace: id.optional() }).strict(),
  z.object({ type: z.literal('voice.leave'), participantId: id }).strict(),
  z.object({ type: z.literal('voice.mute'), participantId: id, muted: z.boolean() }).strict(),
  z.object({ type: z.literal('voice.signal'), participantId: id, targetId: id, signal: voiceSignalSchema }).strict(),
]);
export type VoiceCommand = z.infer<typeof voiceCommandSchema>;
export type VoiceServerMessage =
  | { type: 'voice.joined'; requestId: string; participantId: string; room: VoiceRoom; iceServers: { urls: string[] }[] }
  | { type: 'voice.room'; room: VoiceRoom }
  | { type: 'voice.signal'; fromId: string; toId: string; signal: VoiceSignal }
  | { type: 'voice.left'; participantId: string; reason: 'left' | 'transferred' | 'disconnected' | 'task_deleted' }
  | { type: 'voice.error'; requestId?: string; code: 'invalid' | 'full' | 'already_joined' | 'stale' | 'not_found' | 'rate_limited'; message: string; current?: { participantId: string; taskKey: string } };
