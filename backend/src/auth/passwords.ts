import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 defaults to argon2id.
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Spends the same time as a real check, so unknown emails aren't distinguishable by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyHash, password);
}

/** Readable temporary passwords, e.g. for new users and resets. */
export function generateTemporaryPassword(): string {
  return randomBytes(12).toString('base64url');
}
