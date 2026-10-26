import { createHash, createPrivateKey } from 'node:crypto';
import type { CreateGitConnectionBody, GitConnection, GitConnectionHealth, GitProviderKind, RepositoryGroup, UpdateGitConnectionBody } from '@claude-task/shared';
import { eq, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { AppContext } from '../context';
import type { Executor } from '../db/client';
import { gitConnections, projects } from '../db/schema';
import type { GitConnectionConfig } from '../db/schema';
import { badRequest, conflict, notFound } from '../errors';
import { last4 } from '../secrets';
import { GitHubProvider } from './github';
import { GitLabProvider } from './gitlab';
import { GitProviderError } from './provider';
import type { GitProvider } from './provider';

export interface GitHubCredentials {
  appId: string;
  privateKey: string;
}
/** A Git Connection with its decrypted secret. Backend-only. */
export interface ConnectionRecord {
  id: string;
  provider: GitProviderKind;
  name: string;
  source: 'database' | 'environment';
  appId: string | null;
  baseUrl: string | null;
  secret: string;
  secretLast4: string | null;
  expiresAt: string | null;
  rotationError: string | null;
  /** Changes whenever anything the provider is built from changes. */
  fingerprint: string;
}
export type ProviderFactory = (record: ConnectionRecord) => GitProvider;

export const ENV_GITHUB = 'env-github';
export const ENV_GITLAB = 'env-gitlab';
/** Tokens expiring within this window are rotated (database) or warned about (environment). */
export const EXPIRY_WINDOW_MS = 14 * 24 * 3600000;
const ROTATION_RETRY_MS = 3600000;
const ROTATED_LIFETIME_DAYS = 90;

const digest = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');
const hostOf = (record: Pick<ConnectionRecord, 'provider' | 'baseUrl'>) => (record.baseUrl ? new URL(record.baseUrl).host : 'github.com');

/** Real providers, rebuilt only when their connection changes (so token caches survive). */
export function cachedProviderFactory(): ProviderFactory {
  const cache = new Map<string, { fingerprint: string; provider: GitProvider }>();
  return (record) => {
    const hit = cache.get(record.id);
    if (hit?.fingerprint === record.fingerprint) return hit.provider;
    const provider =
      record.provider === 'github'
        ? new GitHubProvider(record.id, async () => ({ appId: record.appId!, privateKey: record.secret }))
        : new GitLabProvider(record.id, record.baseUrl!, record.secret);
    cache.set(record.id, { fingerprint: record.fingerprint, provider });
    return provider;
  };
}

/** The Git Connections of the installation: environment ones first, then stored ones. */
export class GitConnections {
  constructor(
    private readonly db: Executor,
    private readonly config: Config,
    private readonly factory: ProviderFactory,
  ) {}

  private environment(): ConnectionRecord[] {
    const records: ConnectionRecord[] = [];
    const { github, gitlab } = this.config;
    if (github)
      records.push({
        id: ENV_GITHUB,
        provider: 'github',
        name: 'GitHub',
        source: 'environment',
        appId: github.appId,
        baseUrl: null,
        secret: github.privateKey,
        secretLast4: null,
        expiresAt: null,
        rotationError: null,
        fingerprint: digest(github.appId, github.privateKey),
      });
    if (gitlab) {
      const baseUrl = normalizeGitLabUrl(gitlab.baseUrl, true);
      records.push({
        id: ENV_GITLAB,
        provider: 'gitlab',
        name: 'GitLab',
        source: 'environment',
        appId: null,
        baseUrl,
        secret: gitlab.token,
        secretLast4: last4(gitlab.token),
        expiresAt: null,
        rotationError: null,
        fingerprint: digest(baseUrl, gitlab.token),
      });
    }
    return records;
  }
  private stored(row: typeof gitConnections.$inferSelect): ConnectionRecord {
    const config = row.config as GitConnectionConfig;
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      source: 'database',
      appId: 'appId' in config ? config.appId : null,
      baseUrl: 'baseUrl' in config ? config.baseUrl : null,
      secret: this.config.secrets.decrypt(row.secretCiphertext),
      secretLast4: row.secretLast4,
      expiresAt: 'expiresAt' in config ? config.expiresAt : null,
      rotationError: row.rotationError,
      fingerprint: digest(row.id, row.updatedAt.toISOString(), row.secretCiphertext),
    };
  }
  async list(db: Executor = this.db): Promise<ConnectionRecord[]> {
    const rows = await db.select().from(gitConnections).orderBy(gitConnections.createdAt);
    return [...this.environment(), ...rows.map((r) => this.stored(r))];
  }
  async find(id: string, db: Executor = this.db): Promise<ConnectionRecord | null> {
    const env = this.environment().find((r) => r.id === id);
    if (env) return env;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await db.select().from(gitConnections).where(eq(gitConnections.id, id));
    return row ? this.stored(row) : null;
  }
  async get(id: string, db: Executor = this.db): Promise<ConnectionRecord> {
    const record = await this.find(id, db);
    if (!record) throw new GitProviderError('The Git Connection of this repository no longer exists', 409);
    return record;
  }
  providerFor(record: ConnectionRecord): GitProvider {
    return this.factory(record);
  }
  /** The provider of a Repository's Git Connection. */
  async provider(connectionId: string): Promise<GitProvider> {
    return this.providerFor(await this.get(connectionId));
  }
}

export function normalizeGitLabUrl(value: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw badRequest('Enter the GitLab URL, e.g. https://gitlab.com');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw badRequest('The GitLab URL must use https');
  if (url.username || url.password || url.search || url.hash) throw badRequest('The GitLab URL must not contain credentials, a query or a fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
function validatePrivateKey(privateKey: string) {
  try {
    if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error();
  } catch {
    throw badRequest('The private key must be a valid RSA PEM private key');
  }
}
/** Checks the credential against the provider before anything is stored. */
async function identify(ctx: AppContext, record: ConnectionRecord) {
  try {
    return await ctx.git.providerFor(record).validate();
  } catch (err) {
    if (err instanceof GitProviderError) throw badRequest(err.message);
    throw err;
  }
}
function draftRecord(fields: Omit<ConnectionRecord, 'fingerprint' | 'source' | 'rotationError' | 'expiresAt'>): ConnectionRecord {
  // A unique fingerprint keeps candidates out of the provider caches of saved connections.
  return { ...fields, source: 'database', expiresAt: null, rotationError: null, fingerprint: `draft:${digest(fields.id, fields.secret, String(Date.now()))}` };
}

async function linkedProjects(db: Executor, id: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(projects)
    .where(sql`${projects.repository}->>'connectionId' = ${id}`);
  return row?.n ?? 0;
}
function health(record: ConnectionRecord, expiresAt: string | null): GitConnectionHealth {
  if (expiresAt && Date.parse(expiresAt) < Date.now() + EXPIRY_WINDOW_MS && (record.source === 'environment' || record.rotationError)) {
    const message =
      record.source === 'environment'
        ? 'The token expires soon and is set through the environment: renew GITLAB_TOKEN.'
        : `The token expires soon and automatic rotation failed: ${record.rotationError}`;
    return { state: 'expiring', expiresAt, message };
  }
  return { state: 'ok' };
}
async function describe(ctx: AppContext, record: ConnectionRecord): Promise<GitConnection> {
  const base = {
    id: record.id,
    provider: record.provider,
    name: record.name,
    host: hostOf(record),
    source: record.source,
    appId: record.appId,
    baseUrl: record.baseUrl,
    secretLast4: record.secretLast4,
    linkedProjects: await linkedProjects(ctx.db, record.id),
  };
  try {
    const identity = await ctx.git.providerFor(record).validate();
    const expiresAt = identity.expiresAt ?? record.expiresAt;
    return { ...base, expiresAt, access: identity.access, health: health(record, expiresAt) };
  } catch (err) {
    const message = err instanceof GitProviderError ? err.message : 'The connection could not be checked';
    return { ...base, expiresAt: record.expiresAt, access: [], health: { state: 'error', message } };
  }
}

export async function listConnections(ctx: AppContext): Promise<GitConnection[]> {
  return Promise.all((await ctx.git.list()).map((r) => describe(ctx, r)));
}
async function getStored(ctx: AppContext, id: string): Promise<ConnectionRecord> {
  const record = await ctx.git.find(id);
  if (!record) throw notFound('Git Connection');
  if (record.source === 'environment') throw conflict('This connection is managed through the backend environment');
  return record;
}

export async function createConnection(ctx: AppContext, body: CreateGitConnectionBody): Promise<GitConnection> {
  const id = crypto.randomUUID();
  let record: ConnectionRecord;
  let config: GitConnectionConfig;
  if (body.provider === 'github') {
    validatePrivateKey(body.privateKey);
    record = draftRecord({ id, provider: 'github', name: body.name, appId: body.appId, baseUrl: null, secret: body.privateKey, secretLast4: null });
    await identify(ctx, record);
    config = { appId: body.appId };
  } else {
    const baseUrl = normalizeGitLabUrl(body.baseUrl, !!ctx.config.gitlabAllowHttp);
    record = draftRecord({ id, provider: 'gitlab', name: body.name, appId: null, baseUrl, secret: body.token, secretLast4: last4(body.token) });
    const identity = await identify(ctx, record);
    config = gitlabConfig(baseUrl, identity.expiresAt, identity.access[0]?.label ?? null);
  }
  await ctx.db.insert(gitConnections).values({
    id,
    provider: body.provider,
    name: body.name,
    config,
    secretCiphertext: ctx.config.secrets.encrypt(record.secret),
    secretLast4: record.secretLast4,
  });
  return describe(ctx, await ctx.git.get(id));
}
function gitlabConfig(baseUrl: string, expiresAt: string | null, username: string | null): GitConnectionConfig {
  return { baseUrl, userId: null, username, expiresAt };
}

export async function updateConnection(ctx: AppContext, id: string, body: UpdateGitConnectionBody): Promise<GitConnection> {
  const current = await getStored(ctx, id);
  if (current.provider === 'github' && body.token) throw badRequest('GitHub connections use an App private key, not a token');
  if (current.provider === 'gitlab' && (body.appId || body.privateKey)) throw badRequest('GitLab connections use a token');
  const secret = body.privateKey ?? body.token ?? current.secret;
  const appId = body.appId ?? current.appId;
  const credentialChanged = secret !== current.secret || appId !== current.appId;
  let config: GitConnectionConfig = current.provider === 'github' ? { appId: appId! } : gitlabConfig(current.baseUrl!, current.expiresAt, null);
  if (credentialChanged) {
    if (body.privateKey) validatePrivateKey(body.privateKey);
    const identity = await identify(ctx, draftRecord({ ...current, appId, secret, secretLast4: body.token ? last4(body.token) : current.secretLast4 }));
    if (current.provider === 'gitlab') config = gitlabConfig(current.baseUrl!, identity.expiresAt, identity.access[0]?.label ?? null);
  }
  // Under the rotation's lock, so a rotation in flight can't overwrite what the admin saves.
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-connection:${id}`}))`);
    await tx
      .update(gitConnections)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(credentialChanged
          ? {
              config,
              secretCiphertext: ctx.config.secrets.encrypt(secret),
              secretLast4: body.token ? last4(body.token) : current.secretLast4,
              rotationError: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(gitConnections.id, id));
  });
  return describe(ctx, await ctx.git.get(id));
}

export async function deleteConnection(ctx: AppContext, id: string): Promise<void> {
  await getStored(ctx, id);
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-connection:${id}`}))`);
    await tx.execute(sql`lock table ${projects} in share mode`);
    if ((await linkedProjects(tx, id)) > 0) throw conflict('Projects still link repositories of this connection. Link them elsewhere first.');
    await tx.delete(gitConnections).where(eq(gitConnections.id, id));
  });
}

/** Repositories of every connection; one failing connection doesn't hide the others. */
export async function listRepositoryGroups(ctx: AppContext): Promise<RepositoryGroup[]> {
  return Promise.all(
    (await ctx.git.list()).map(async (record) => {
      const connection = { id: record.id, provider: record.provider, name: record.name, host: hostOf(record) };
      try {
        return { connection, repositories: await ctx.git.providerFor(record).listAccessibleRepositories(), error: null };
      } catch (err) {
        return { connection, repositories: [], error: err instanceof GitProviderError ? err.message : 'The connection could not list repositories' };
      }
    }),
  );
}

type Rotatable = GitProvider & { rotateToken(expiresAt?: string): Promise<{ token: string; expiresAt: string | null }> };
const rotatable = (p: GitProvider): p is Rotatable => typeof (p as Partial<Rotatable>).rotateToken === 'function';

/**
 * Rotates stored GitLab tokens before they expire. Rotating an already-revoked token makes
 * GitLab revoke the whole token family, so rotations are serialized per connection and the
 * token is re-read under the lock.
 */
export async function rotateExpiringTokens(ctx: AppContext): Promise<void> {
  const rows = await ctx.db.select({ id: gitConnections.id }).from(gitConnections).where(eq(gitConnections.provider, 'gitlab'));
  for (const { id } of rows) {
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-connection:${id}`}))`);
      const [row] = await tx.select().from(gitConnections).where(eq(gitConnections.id, id));
      if (!row) return;
      const config = row.config as GitConnectionConfig;
      if (!('baseUrl' in config) || !config.expiresAt || Date.parse(config.expiresAt) > Date.now() + EXPIRY_WINDOW_MS) return;
      if (row.rotationError && row.updatedAt.getTime() > Date.now() - ROTATION_RETRY_MS) return;
      const provider = ctx.git.providerFor(await ctx.git.get(id, tx));
      if (!rotatable(provider)) return;
      try {
        const target = new Date(Date.now() + ROTATED_LIFETIME_DAYS * 24 * 3600000).toISOString().slice(0, 10);
        let rotated;
        try {
          rotated = await provider.rotateToken(target);
        } catch (err) {
          // The instance may cap token lifetimes: fall back to GitLab's default expiry.
          if (!(err instanceof GitProviderError && err.status === 400)) throw err;
          rotated = await provider.rotateToken();
        }
        await tx
          .update(gitConnections)
          .set({
            secretCiphertext: ctx.config.secrets.encrypt(rotated.token),
            secretLast4: last4(rotated.token),
            config: { ...config, expiresAt: rotated.expiresAt },
            rotationError: null,
            updatedAt: new Date(),
          })
          .where(eq(gitConnections.id, id));
        ctx.log.info({ connectionId: id, expiresAt: rotated.expiresAt }, 'GitLab token rotated');
      } catch (err) {
        const message = err instanceof GitProviderError ? err.message : 'Rotation failed';
        await tx.update(gitConnections).set({ rotationError: message, updatedAt: new Date() }).where(eq(gitConnections.id, id));
        ctx.log.warn({ connectionId: id, message }, 'GitLab token rotation failed');
      }
    });
  }
}
