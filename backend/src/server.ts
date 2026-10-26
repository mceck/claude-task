import { FirebasePushTransport } from './notifications/transport';
import type { PushTransport } from './notifications/transport';
import { PushDispatcher } from './notifications/dispatcher';
import { GitConnections, cachedProviderFactory } from './git/connections';
import type { ProviderFactory } from './git/connections';
import { GitSync } from './git/sync';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { purgeExpiredLogins } from './auth/logins';
import { FsBlobStore } from './blobstore';
import type { BlobStore } from './blobstore';
import { DockerRuntime } from './agents/docker-runtime';
import { FakeRuntime } from './agents/fake-runtime';
import type { AgentRuntime } from './agents/runtime';
import { Scheduler } from './agents/scheduler';
import { RunnerHub } from './runner/hub';
import type { Config } from './config';
import type { AppContext } from './context';
import { createDb, runMigrations } from './db/client';
import { resetInterruptedBuilds } from './modules/agents/builds';
import { bootstrapAdmin } from './modules/users/service';
import { RealtimeHub } from './realtime/hub';

export interface Server {
  app: FastifyInstance;
  ctx: AppContext;
  close(): Promise<void>;
}

/** Migrates the database, bootstraps the first admin and builds the app (not listening yet). */
export async function createServer(
  config: Config,
  overrides: { blobs?: BlobStore; logger?: boolean; runtime?: AgentRuntime; startScheduler?: boolean; git?: ProviderFactory; push?: PushTransport } = {},
): Promise<Server> {
  const { db, pool } = createDb(config.databaseUrl);
  try {
    await runMigrations(db);
    const ctx = {
      config,
      db,
      push: overrides.push ?? new FirebasePushTransport(config.push?.serviceAccountFile),
      git: new GitConnections(db, config, overrides.git ?? cachedProviderFactory()),
      hub: new RealtimeHub(),
      blobs: overrides.blobs ?? new FsBlobStore(path.join(config.dataDir, 'blobs')),
      runtime:
        overrides.runtime ??
        (config.agents.runtime === 'fake' ? new FakeRuntime() : new DockerRuntime(config.agents)),
      runners: new RunnerHub(() => ctx.log),
    } as AppContext;
    ctx.pushDispatcher = new PushDispatcher(ctx);
    ctx.scheduler = new Scheduler(ctx);
    ctx.gitSync = new GitSync(ctx);
    const app = await buildApp(ctx, { logger: overrides.logger });
    ctx.log = app.log;
    await resetInterruptedBuilds(db);
    if (overrides.startScheduler !== false) {
      ctx.pushDispatcher.start();
      ctx.scheduler.start();
      ctx.gitSync.start();
    }
    if (await bootstrapAdmin(db, config.bootstrapAdmin)) {
      app.log.info({ email: config.bootstrapAdmin!.email }, 'created the first admin from ADMIN_EMAIL');
    }
    const purge = setInterval(() => purgeExpiredLogins(db).catch((err) => app.log.warn(err)), 60 * 60 * 1000);
    purge.unref();
    return {
      app,
      ctx,
      async close() {
        clearInterval(purge);
        ctx.pushDispatcher.stop();
        await ctx.pushDispatcher.settle();
        await ctx.push.close?.();
        ctx.scheduler.stop();
        ctx.gitSync.stop();
        await ctx.gitSync.settle();
        await app.close();
        await ctx.scheduler.settle();
        await pool.end();
      },
    };
  } catch (err) {
    await pool.end();
    throw err;
  }
}
