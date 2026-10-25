import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything queries can run on: the pool or an open transaction. */
export type Executor = Db | Tx;

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

/** Migrations live next to the sources in dev and next to the bundle in production. */
export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, here.endsWith(path.join('src', 'db')) ? '../../drizzle' : '../drizzle');
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
