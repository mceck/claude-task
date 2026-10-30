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

/** A valid Argon2id hash of an unknown value, so the first probe needs no hash computation. */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$PxOK6poubJJA/S5/spCpEQ$Yo/qamDYCDVDvA646fTB1BZuqnfq4dOK9jbm2RF2zwc';

/** Spends the same time as a real check, so unknown emails aren't distinguishable by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, password);
}

/** Readable temporary passwords, e.g. for new users and resets. */
export function generateTemporaryPassword(): string {
  return randomBytes(12).toString('base64url');
}
