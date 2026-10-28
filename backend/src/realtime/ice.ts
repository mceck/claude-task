import { createHmac, randomUUID } from 'node:crypto';
import { DEFAULT_VOICE_STUN_URLS } from '@claude-task/shared';
import type { VoiceIceConfiguration } from '@claude-task/shared';
import type { Config } from '../config';

/** Coturn REST credentials: the shared secret stays off the signaling connection. */
export function voiceIceConfiguration(config: Config, userId: string): VoiceIceConfiguration {
  const urls = config.voiceStunUrls ?? DEFAULT_VOICE_STUN_URLS;
  const ice: VoiceIceConfiguration = { iceServers: urls.length ? [{ urls }] : [], iceExpiresAt: null };
  const turn = config.voiceTurn;
  if (!turn) return ice;
  const expires = Math.floor(Date.now() / 1000) + turn.ttlSeconds;
  const username = `${expires}:${userId}:${randomUUID()}`;
  ice.iceExpiresAt = new Date(expires * 1000).toISOString();
  ice.iceServers.push({
    urls: [
      `turn:${turn.host}:${turn.port}?transport=udp`,
      `turn:${turn.host}:${turn.port}?transport=tcp`,
      ...(turn.tlsPort ? [`turns:${turn.host}:${turn.tlsPort}?transport=tcp`] : []),
    ],
    username,
    credential: createHmac('sha1', turn.secret).update(username).digest('base64'),
  });
  return ice;
}
