import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Encrypts Credentials and secret env values at rest (AES-256-GCM). */
export class SecretBox {
  /** Key versions allow rotating `SECRETS_MASTER_KEY` later; only v1 exists today. */
  private static readonly VERSION = 'v1';

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('SECRETS_MASTER_KEY must be 32 bytes (base64 or hex)');
  }

  static fromEnv(raw: string | undefined): SecretBox {
    if (!raw) throw new Error('SECRETS_MASTER_KEY is required (32 random bytes, base64 or hex): generate one with `openssl rand -base64 32`');
    const trimmed = raw.trim();
    const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
    return new SecretBox(key);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [SecretBox.VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  decrypt(ciphertext: string): string {
    const [version, iv, tag, data] = ciphertext.split(':');
    if (version !== SecretBox.VERSION || !iv || !tag || data === undefined) throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** The hint shown for a stored secret; none for short ones, which it would (almost) reveal. */
export function last4(secret: string): string {
  return secret.length >= 12 ? secret.slice(-4) : '';
}

/** Random bearer tokens (Runner, Job): only their hash is stored. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
