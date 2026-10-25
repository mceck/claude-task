import { createPrivateKey } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { GitHubAppSettings } from '@claude-task/shared';
import type { Config } from '../config';
import type { Executor } from '../db/client';
import { gitSettings } from '../db/schema';
import { badRequest, conflict } from '../errors';

export interface GitHubCredentials {
  appId: string;
  privateKey: string;
}
export async function readGitHubConfig(db: Executor, config: Config): Promise<GitHubCredentials | null> {
  if (config.github?.appId && config.github.privateKey) return config.github;
  const [row] = await db.select().from(gitSettings).where(eq(gitSettings.id, 'github'));
  return row ? { appId: row.appId, privateKey: config.secrets.decrypt(row.privateKeyCiphertext) } : null;
}
export async function githubSettings(db: Executor, config: Config): Promise<GitHubAppSettings> {
  const value = await readGitHubConfig(db, config);
  return {
    appId: value?.appId ?? null,
    configured: !!value,
    privateKeyConfigured: !!value,
    source: config.github ? 'environment' : value ? 'database' : 'none',
  };
}
export async function saveGitHubSettings(db: Executor, config: Config, body: { appId: string; privateKey?: string }): Promise<void> {
  if (config.github) throw conflict('GitHub App credentials are managed through the environment');
  const before = await readGitHubConfig(db, config);
  const privateKey = body.privateKey ?? before?.privateKey;
  if (!privateKey) throw badRequest('The GitHub App private key is required');
  try {
    if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error();
  } catch {
    throw badRequest('The private key must be a valid RSA PEM private key');
  }
  const values = { appId: body.appId, privateKeyCiphertext: config.secrets.encrypt(privateKey), updatedAt: new Date() };
  await db
    .insert(gitSettings)
    .values({ id: 'github', ...values })
    .onConflictDoUpdate({ target: gitSettings.id, set: values });
}
