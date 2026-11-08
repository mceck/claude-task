import { HostControllers } from './hosts/controllers';
import { RuntimeRegistry } from './hosts/runtimes';
import { hosts, workers } from './db/schema';
import { eq } from 'drizzle-orm';
import { refreshLocalHost, workerConnection } from './modules/hosts/service';
import { FirebasePushTransport } from './notifications/transport';
import type { PushTransport } from './notifications/transport';
import { PushDispatcher } from './notifications/dispatcher';
import { GitConnections, cachedProviderFactory } from './git/connections';
import type { ProviderFactory } from './git/connections';
import { GitSync } from './git/sync';
import { httpClickUpClient } from './clickup/client';
import type { ClickUpClientFactory } from './clickup/client';
import { ClickUpSync } from './clickup/sync';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { purgeExpiredLogins } from './auth/logins';
import { LoginRevocations } from './auth/revocations';
import { FsBlobStore } from './blobstore';
import type { BlobStore } from './blobstore';
import { S3BlobStore } from './blobstore/s3';
import { S3Client } from '@aws-sdk/client-s3';
import { DockerRuntime } from './agents/docker-runtime';
import { FakeRuntime } from './agents/fake-runtime';
import type { WorkerRuntime } from './agents/runtime';
import { Scheduler } from './agents/scheduler';
import { ensureInstallationId } from './modules/workers/cleanup';
import { RunnerHub } from './runner/hub';
import { RunRegistry } from './sessions/runs';
import { UploadRequests } from './runner/uploads';
import { ProjectSkillRequests } from './runner/skill-requests';
import { WorktreeStatusRequests } from './runner/worktree-status';
import type { Config } from './config';
import type { AppContext } from './context';
import { createDb, runMigrations } from './db/client';
import { resetInterruptedBuilds } from './modules/workers/builds';
import { markRunnerConnectionsLost } from './runner/handlers';
import { workerContainers } from './db/schema';
import { isUp } from './modules/workers/service';
import { bootstrapAdmin } from './modules/users/service';
import { seedPlatformSkill } from './modules/extensions/platform-skill';
import { RealtimeHub } from './realtime/hub';
import { ProjectActivity } from './realtime/project-activity';

export interface Server {
  app: FastifyInstance;
  ctx: AppContext;
  close(): Promise<void>;
}

/** The disk store (`STORAGE_TYPE=disk`, the default) or an S3-compatible bucket. */
function createBlobStore(config: Config): BlobStore {
  if (config.storage.type !== 's3') return new FsBlobStore(path.join(config.dataDir, 'blobs'));
  const { bucket, region, endpoint, forcePathStyle, prefix, credentials } = config.storage;
  return new S3BlobStore({
    bucket,
    prefix,
    client: new S3Client({ region, endpoint, forcePathStyle, credentials }),
  });
}

/** Migrates the database, bootstraps the first admin and builds the app (not listening yet). */
export async function createServer(
  config: Config,
  overrides: { blobs?: BlobStore; logger?: boolean; runtime?: WorkerRuntime; startScheduler?: boolean; git?: ProviderFactory; push?: PushTransport; clickup?: ClickUpClientFactory } = {},
): Promise<Server> {
  const { db, pool } = createDb(config.databaseUrl);
  let loginRevocations: LoginRevocations | undefined;
  try {
    await runMigrations(db);
    const installationId = await ensureInstallationId(db);
    const ctx = {
      config,
      db,
      installationId,
      push: overrides.push ?? new FirebasePushTransport(config.push?.serviceAccountFile),
      git: new GitConnections(db, config, overrides.git ?? cachedProviderFactory()),
      clickup: overrides.clickup ?? httpClickUpClient,
      hub: new RealtimeHub(),
      blobs: overrides.blobs ?? createBlobStore(config),
      runtimes: new RuntimeRegistry(db),
      runners: new RunnerHub(() => ctx.log),
      runs: new RunRegistry(),
    } as AppContext;
    const [local] = await db.select().from(hosts).where(eq(hosts.kind, 'local'));
    if (config.localHost !== false) ctx.runtimes.attach(local!.id, overrides.runtime ?? (config.agents.runtime === 'fake' ? new FakeRuntime() : new DockerRuntime(config.agents, installationId)));
    ctx.controllers = new HostControllers(ctx);
    ctx.uploads = new UploadRequests(ctx.runners, async (containerId) => {
      const [row] = await db.select({ hostId: workers.hostId }).from(workerContainers).innerJoin(workers, eq(workers.id, workerContainers.workerId)).where(eq(workerContainers.id, containerId));
      if (!row) throw new Error('Worker Container no longer exists');
      const connection = await workerConnection(ctx, db, row.hostId);
      if (!connection.backendUrl) throw new Error('Host has no backend URL yet');
      return connection.backendUrl;
    }, config.agents.uploadTimeoutMs);
    ctx.skillRequests = new ProjectSkillRequests(ctx.runners);
    ctx.worktreeStatus = new WorktreeStatusRequests(ctx.runners);
    ctx.pushDispatcher = new PushDispatcher(ctx);
    ctx.projectActivity = new ProjectActivity(ctx.hub, db, (err) => ctx.log.warn({ err }, 'Project activity failed'));
    ctx.scheduler = new Scheduler(ctx);
    ctx.gitSync = new GitSync(ctx);
    ctx.clickupSync = new ClickUpSync(ctx);
    const app = await buildApp(ctx, { logger: overrides.logger });
    ctx.log = app.log;
    await refreshLocalHost(ctx);
    await seedPlatformSkill(ctx);
    loginRevocations = ctx.loginRevocations = new LoginRevocations(config.databaseUrl, ctx.hub, app.log);
    await loginRevocations.start();
    await resetInterruptedBuilds(db);
    // The new process has no Runner connections: a Runner that never comes back must not look
    // connected to the rest of the backend.
    await markRunnerConnectionsLost(db);
    if (overrides.startScheduler !== false) {
      ctx.pushDispatcher.start();
      ctx.scheduler.start();
      ctx.gitSync.start();
      ctx.clickupSync.start();
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
          ctx.clickupSync.stop();
          ctx.projectActivity.stop();
          ctx.pushDispatcher.stop();
          await ctx.pushDispatcher.settle();
          await ctx.push.close?.();
          await ctx.gitSync.settle();
          await ctx.clickupSync.settle();
          // Stop containers while the (possibly long) build drain runs: Compose kills the
          // process after stop_grace_period, so stopping only after settle defeats the setting.
          let stopFailure: unknown;
          const stopContainers = async (onlyRunning = false) => {
            if (!config.agents.stopOnShutdown) return;
            const rows = await db.select({ workerId: workerContainers.workerId, slot: workerContainers.slot, hostId: workers.hostId }).from(workerContainers).innerJoin(workers, eq(workers.id, workerContainers.workerId));
            const results = await Promise.allSettled(rows.map(async ({ workerId, slot, hostId }) => {
              if (!ctx.runtimes.has(hostId)) { app.log.info({ hostId, workerId }, 'skipping disconnected Host for backend shutdown'); return; }
              const runtime = ctx.runtimes.get(hostId);
              if (onlyRunning && !isUp((await runtime.inspect(workerId, slot)).state)) return;
              await runtime.stopContainer(workerId, slot);
              app.log.info({ workerId, slot }, 'stopped Worker Container for backend shutdown');
            }));
            const errors: unknown[] = [];
            for (const [index, result] of results.entries()) {
              if (result.status === 'rejected') {
                app.log.error({ err: result.reason, workerId: rows[index]!.workerId, slot: rows[index]!.slot }, 'failed to stop Worker Container for backend shutdown');
                errors.push(result.reason);
              }
            }
            if (errors.length) throw new AggregateError(errors, 'Some Worker Containers could not be stopped');
          };
          const stopping = stopContainers().catch((err) => {
            stopFailure = err;
          });
          try {
            await stopping;
            const results = await Promise.allSettled([(async () => {
              await ctx.scheduler.settle();
              await stopContainers(true);
            })()]);
            await app.close();
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
