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
import { LoginRevocations } from './auth/revocations';
import { FsBlobStore } from './blobstore';
import type { BlobStore } from './blobstore';
import { DockerRuntime } from './agents/docker-runtime';
import { FakeRuntime } from './agents/fake-runtime';
import type { AgentRuntime } from './agents/runtime';
import { Scheduler } from './agents/scheduler';
import { RunnerHub } from './runner/hub';
import { RunRegistry } from './sessions/runs';
import { UploadRequests } from './runner/uploads';
import { ProjectSkillRequests } from './runner/skill-requests';
import type { Config } from './config';
import type { AppContext } from './context';
import { createDb, runMigrations } from './db/client';
import { resetInterruptedBuilds } from './modules/agents/builds';
import { agents } from './db/schema';
import { bootstrapAdmin } from './modules/users/service';
import { RealtimeHub } from './realtime/hub';
import { ProjectActivity } from './realtime/project-activity';

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
  let loginRevocations: LoginRevocations | undefined;
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
      runs: new RunRegistry(),
    } as AppContext;
    ctx.uploads = new UploadRequests(ctx.runners, config.agents.backendUrl, config.agents.uploadTimeoutMs);
    ctx.skillRequests = new ProjectSkillRequests(ctx.runners);
    ctx.pushDispatcher = new PushDispatcher(ctx);
    ctx.projectActivity = new ProjectActivity(ctx.hub, db, (err) => ctx.log.warn({ err }, 'Project activity failed'));
    ctx.scheduler = new Scheduler(ctx);
    ctx.gitSync = new GitSync(ctx);
    const app = await buildApp(ctx, { logger: overrides.logger });
    ctx.log = app.log;
    loginRevocations = ctx.loginRevocations = new LoginRevocations(config.databaseUrl, ctx.hub, app.log);
    await loginRevocations.start();
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
    let closing: Promise<void> | undefined;
    return {
      app,
      ctx,
      close() {
        return closing ??= (async () => {
          clearInterval(purge);
          ctx.scheduler.stop();
          ctx.gitSync.stop();
          ctx.projectActivity.stop();
          ctx.pushDispatcher.stop();
          await ctx.pushDispatcher.settle();
          await ctx.push.close?.();
          await ctx.gitSync.settle();
          // Stop containers while the (possibly long) build drain runs: Compose kills the
          // process after stop_grace_period, so stopping only after settle defeats the setting.
          let stopFailure: unknown;
          const stopContainers = async (onlyRunning = false) => {
            if (!config.agents.stopOnShutdown) return;
            const rows = await db.select({ id: agents.id }).from(agents);
            const results = await Promise.allSettled(rows.map(async ({ id }) => {
              if (onlyRunning && !['running', 'restarting'].includes((await ctx.runtime.inspect(id)).state)) return;
              await ctx.runtime.stopContainer(id);
              app.log.info({ agentId: id }, 'stopped Agent Container for backend shutdown');
            }));
            const errors: unknown[] = [];
            for (const [index, result] of results.entries()) {
              if (result.status === 'rejected') {
                app.log.error({ err: result.reason, agentId: rows[index]!.id }, 'failed to stop Agent Container for backend shutdown');
                errors.push(result.reason);
              }
            }
            if (errors.length) throw new AggregateError(errors, 'Some Agent Containers could not be stopped');
          };
          const stopping = stopContainers().catch((err) => {
            stopFailure = err;
          });
          try {
            const results = await Promise.allSettled([
              app.close(),
              (async () => {
                await ctx.scheduler.settle();
                await stopping;
                // A create/restart can finish after the early stop. Stop it without
                // waiting for HTTP keepalive connections to finish closing.
                await stopContainers(true);
              })(),
            ]);
            // Runner close handlers can publish state while the first drain completes.
            await ctx.scheduler.settle();
            const failure = results.find((result) => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
            if (stopFailure) throw stopFailure;
          } finally {
            await stopping;
            await loginRevocations!.close();
            await pool.end();
          }
        })();
      },
    };
  } catch (err) {
    await loginRevocations?.close();
    await pool.end();
    throw err;
  }
}
