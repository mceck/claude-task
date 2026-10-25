import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { purgeExpiredLogins } from './auth/logins';
import { FsBlobStore } from './blobstore';
import type { BlobStore } from './blobstore';
import type { Config } from './config';
import type { AppContext } from './context';
import { createDb, runMigrations } from './db/client';
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
  overrides: { blobs?: BlobStore; logger?: boolean } = {},
): Promise<Server> {
  const { db, pool } = createDb(config.databaseUrl);
  try {
    await runMigrations(db);
    const ctx: AppContext = {
      config,
      db,
      hub: new RealtimeHub(),
      blobs: overrides.blobs ?? new FsBlobStore(path.join(config.dataDir, 'blobs')),
    };
    const app = await buildApp(ctx, { logger: overrides.logger });
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
        await app.close();
        await pool.end();
      },
    };
  } catch (err) {
    await pool.end();
    throw err;
  }
}
