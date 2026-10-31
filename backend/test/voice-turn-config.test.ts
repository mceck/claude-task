import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = { DATABASE_URL: 'postgres://localhost/test', SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') };
const secret = 'turn-startup-test-secret-000000000000000000';

describe('TURN environment configuration', () => {
  it('has no default hostname and leaves TURN disabled when unconfigured', () => {
    expect(loadConfig(base).voiceTurn).toBeUndefined();
    expect(loadConfig({ ...base, VOICE_TURN_HOST: '', VOICE_TURN_SECRET: '' }).voiceTurn).toBeUndefined();
  });
  it('requires an explicit host and a secret together', () => {
    expect(() => loadConfig({ ...base, VOICE_TURN_SECRET: secret })).toThrow(/VOICE_TURN_HOST/);
    expect(() => loadConfig({ ...base, VOICE_TURN_HOST: 'turn.example.test' })).toThrow(/VOICE_TURN_SECRET/);
    expect(() => loadConfig({ ...base, VOICE_TURN_TLS_PORT: '443' })).toThrow(/VOICE_TURN_HOST/);
  });
  it('rejects a lone TURN port or lifetime as a partial configuration', () => {
    for (const env of [
      { VOICE_TURN_PORT: 'abc' },
      { VOICE_TURN_PORT: '99999' },
      { VOICE_TURN_TTL_SECONDS: '299' },
      { VOICE_TURN_TTL_SECONDS: '86401' },
    ]) {
      expect(() => loadConfig({ ...base, ...env }), JSON.stringify(env)).toThrow(/VOICE_TURN/);
    }
  });
  it.each(['https://turn.example.test', 'turn.example.test:3478', 'turn.example.test/path', 'bad\nhost', 'bad..host'])(
    'rejects a non-hostname value: %s', (host) => {
      expect(() => loadConfig({ ...base, VOICE_TURN_HOST: host, VOICE_TURN_SECRET: secret })).toThrow(/VOICE_TURN_HOST/);
    },
  );
  it('accepts explicit ports and lifetime while rejecting invalid values', () => {
    const configured = { ...base, VOICE_TURN_HOST: 'turn.example.test', VOICE_TURN_SECRET: secret };
    expect(loadConfig({ ...configured, VOICE_TURN_PORT: '4000', VOICE_TURN_TLS_PORT: '443', VOICE_TURN_TTL_SECONDS: '300' }).voiceTurn).toMatchObject({ host: 'turn.example.test', port: 4000, tlsPort: 443, ttlSeconds: 300 });
    for (const invalid of [{ VOICE_TURN_PORT: '65536' }, { VOICE_TURN_PORT: '0' }, { VOICE_TURN_TLS_PORT: 'abc' }, { VOICE_TURN_TTL_SECONDS: '299' }, { VOICE_TURN_TTL_SECONDS: '86401' }, { VOICE_TURN_SECRET: 'short' }]) {
      expect(() => loadConfig({ ...configured, ...invalid })).toThrow(/VOICE_TURN/);
    }
  });
});
