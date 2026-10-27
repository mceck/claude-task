import { FakeGitProvider } from '../../src/git/fake-provider';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { FakeRuntime } from '../../src/agents/fake-runtime';
import { FsBlobStore } from '../../src/blobstore';
import type { Config } from '../../src/config';
import { SecretBox } from '../../src/secrets';
import { bootstrapAdmin } from '../../src/modules/users/service';
import { createServer } from '../../src/server';
import type { Server } from '../../src/server';
import { ApiClient } from './client';

export const ADMIN = { email: 'admin@example.com', password: 'admin-password', displayName: 'Ada Admin' };

let workerDb: Promise<string> | undefined;

/** One database per test file, cloned from the migrated template, so files can run in parallel. */
function workerDatabase(): Promise<string> {
  workerDb ??= (async () => {
    const template = new URL(inject('templateDatabaseUrl'));
    const name = `${template.pathname.slice(1).replace(/_tmpl$/, '')}_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Client({ connectionString: Object.assign(new URL(template), { pathname: '/postgres' }).toString() });
    await admin.connect();
    await admin.query(`create database ${name} template ${template.pathname.slice(1)}`);
    await admin.end();
    return Object.assign(new URL(template), { pathname: `/${name}` }).toString();
  })();
  return workerDb;
}

export interface TestApp {
  /** Base URL of the listening server, e.g. http://127.0.0.1:54321 */
  url: string;
  server: Server;
  /** A fresh, unauthenticated client. */
  client(): ApiClient;
  /** A client logged in as the bootstrapped admin. */
  admin(): Promise<ApiClient>;
  /** The in-memory Docker stand-in. */
  runtime: FakeRuntime;
  /** Behind every GitHub connection; `env-github` exists unless the config removes it. */
  git: FakeGitProvider;
  /** Behind every GitLab connection. */
  gitlab: FakeGitProvider;
  /** Waits until the backend's background work (dispatch, builds, publishing) is done. */
  settle(): Promise<void>;
}

export interface TestAppOptions {
  push?: import('../../src/notifications/transport').PushTransport;
  config?: Partial<Config>;
  /** Real providers instead of the fakes (provider HTTP contracts). */
  git?: import('../../src/git/connections').ProviderFactory;
  /** Keep data between tests in the file (default: truncate before each test). */
  keepData?: boolean;
}

/**
 * Starts the real app on a random port against a real Postgres, for the whole file.
 * Before each test the database is emptied and the admin re-created.
 */
export function useTestApp(options: TestAppOptions = {}): TestApp {
  let blobDir: string;
  const t = {} as TestApp;

  beforeAll(async () => {
    blobDir = await mkdtemp(path.join(tmpdir(), 'ct-blobs-'));
    const config: Config = {
      databaseUrl: await workerDatabase(),
      host: '127.0.0.1',
      port: 0,
      dataDir: blobDir,
      staticDir: null,
      cookieSecure: false,
      trustProxy: false,
      logLevel: 'silent',
      bootstrapAdmin: ADMIN,
      loginRateLimit: { max: 1000, windowMs: 60_000 },
      secrets: new SecretBox(Buffer.alloc(32, 7)),
      agents: {
        runtime: 'fake',
        dockerSocket: '/dev/null',
        claudeCodeVersion: '2.1.310',
        backendUrl: 'http://backend.test',
        network: null,
        commitEmailDomain: 'agents.test',
        reconcileIntervalMs: 60 * 60_000,
        runnerReconnectTimeoutMs: 5 * 60_000,
      },
      github: { appId: '1', privateKey: 'unused by the fake provider' },
      gitlabAllowHttp: true,
      ...options.config,
    };
    t.runtime = new FakeRuntime();
    t.git = new FakeGitProvider();
    t.gitlab = new FakeGitProvider('gitlab', '');
    const git = options.git ?? FakeGitProvider.factory(() => ({ github: t.git, gitlab: t.gitlab }));
    const server = await createServer(config, { blobs: new FsBlobStore(blobDir), logger: false, runtime: t.runtime, git, push: options.push });
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    t.url = `http://127.0.0.1:${address.port}`;
    t.server = server;
    t.client = () => new ApiClient(t.url);
    t.admin = async () => {
      const c = t.client();
      await c.login(ADMIN.email, ADMIN.password);
      return c;
    };
    t.settle = () => server.ctx.scheduler.settle();
  });

  afterAll(async () => {
    await t.server?.close();
    await rm(blobDir, { recursive: true, force: true });
  });

  if (!options.keepData) {
    beforeEach(async () => {
      await t.server.ctx.runners.closeAll();
      await t.server.ctx.scheduler.settle();
      await t.server.ctx.gitSync.settle();
      t.server.ctx.git.invalidateRepositories();
      t.git = new FakeGitProvider();
      t.gitlab = new FakeGitProvider('gitlab', '');
      t.runtime.containers.clear();
      t.runtime.onContainerCreated = null;
      await truncateAll(t.server);
      await bootstrapAdmin(t.server.ctx.db, t.server.ctx.config.bootstrapAdmin);
    });
  }

  return t;
}

export async function truncateAll(server: Server): Promise<void> {
  const { rows } = await server.ctx.db.$client.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`,
  );
  await server.ctx.db.$client.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} cascade`);
}
