import type { Credential, RateLimitObservation } from '@claude-task/shared';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { agents, credentials, rateLimitObservations } from '../../db/schema';
import { conflict, notFound } from '../../errors';
import { last4 } from '../../secrets';
import type { SecretBox } from '../../secrets';

type CredentialRow = typeof credentials.$inferSelect;

export async function loadCredentials(db: Executor, ids?: string[]): Promise<Credential[]> {
  const rows = ids
    ? ids.length === 0
      ? []
      : await db.select().from(credentials).where(inArray(credentials.id, ids)).orderBy(asc(credentials.name))
    : await db.select().from(credentials).orderBy(asc(sql`lower(${credentials.name})`));
  if (rows.length === 0) return [];
  const credentialIds = rows.map((r) => r.id);
  const users = await db
    .select({ id: agents.id, name: agents.name, credentialId: agents.credentialId })
    .from(agents)
    .where(inArray(agents.credentialId, credentialIds))
    .orderBy(asc(agents.name));
  const limits = await latestRateLimits(db, credentialIds);
  return rows.map((r) => serializeCredential(r, users.filter((u) => u.credentialId === r.id), limits.get(r.id) ?? null));
}

export async function loadCredential(db: Executor, id: string): Promise<Credential> {
  const [credential] = await loadCredentials(db, [id]);
  if (!credential) throw notFound('Credential');
  return credential;
}

function serializeCredential(r: CredentialRow, usedBy: { id: string; name: string }[], rateLimit: RateLimitObservation | null): Credential {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    last4: r.secretLast4,
    usedBy: usedBy.map(({ id, name }) => ({ id, name })),
    rateLimit,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function latestRateLimits(db: Executor, credentialIds: string[]): Promise<Map<string, RateLimitObservation>> {
  if (credentialIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([rateLimitObservations.credentialId])
    .from(rateLimitObservations)
    .where(inArray(rateLimitObservations.credentialId, credentialIds))
    .orderBy(rateLimitObservations.credentialId, desc(rateLimitObservations.observedAt), desc(rateLimitObservations.id));
  return new Map(
    rows.map((r) => [r.credentialId, { agentId: r.agentId, info: r.payload, observedAt: r.observedAt.toISOString() }]),
  );
}

export async function createCredential(
  db: Executor,
  box: SecretBox,
  input: { name: string; kind: CredentialRow['kind']; secret: string },
): Promise<Credential> {
  const [row] = await db
    .insert(credentials)
    .values({ name: input.name, kind: input.kind, secretCiphertext: box.encrypt(input.secret), secretLast4: last4(input.secret) })
    .returning();
  return loadCredential(db, row!.id);
}

/** Rotating keeps the id, so every Agent using it gets the new secret on its next Job. */
export async function updateCredential(
  db: Executor,
  box: SecretBox,
  id: string,
  input: { name?: string; secret?: string },
): Promise<Credential> {
  const [row] = await db
    .update(credentials)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.secret !== undefined ? { secretCiphertext: box.encrypt(input.secret), secretLast4: last4(input.secret) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(credentials.id, id))
    .returning();
  if (!row) throw notFound('Credential');
  return loadCredential(db, row.id);
}

export async function deleteCredential(db: Executor, id: string): Promise<void> {
  const [row] = await db.select().from(credentials).where(eq(credentials.id, id)).for('update');
  if (!row) throw notFound('Credential');
  const users = await db.select({ name: agents.name }).from(agents).where(eq(agents.credentialId, id));
  if (users.length > 0) {
    throw conflict(`The credential is used by ${users.map((u) => u.name).join(', ')}`);
  }
  await db.delete(credentials).where(eq(credentials.id, id));
}

/** The environment variable `claude` reads the secret from, per Credential kind. */
export const CREDENTIAL_ENV: Record<CredentialRow['kind'], string> = {
  claude_oauth_token: 'CLAUDE_CODE_OAUTH_TOKEN',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  anthropic_auth_token: 'ANTHROPIC_AUTH_TOKEN',
};

/** The decrypted secret as the Job environment variable `claude` reads. */
export async function credentialEnv(db: Executor, box: SecretBox, id: string): Promise<{ name: string; env: Record<string, string> }> {
  const [row] = await db.select().from(credentials).where(eq(credentials.id, id));
  if (!row) throw notFound('Credential');
  const secret = box.decrypt(row.secretCiphertext);
  return { name: row.name, env: { [CREDENTIAL_ENV[row.kind]]: secret } };
}
