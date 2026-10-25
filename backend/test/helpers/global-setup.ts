import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createDb, runMigrations } from '../../src/db/client';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabaseUrl: string;
  }
}

/** Connection to the server's maintenance DB, used to create throwaway databases. */
export const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres';

export function databaseUrl(name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Creates a migrated template database for this run. Each worker clones it
 * (see app.ts), and everything is dropped at the end.
 */
export default async function setup(project: TestProject) {
  const prefix = `ct_test_${randomBytes(4).toString('hex')}`;
  const template = `${prefix}_tmpl`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${template}`);

  const { db, pool } = createDb(databaseUrl(template));
  await runMigrations(db);
  await pool.end();
  project.provide('templateDatabaseUrl', databaseUrl(template));

  return async () => {
    const { rows } = await admin.query<{ datname: string }>(
      `select datname from pg_database where datname like $1`,
      [`${prefix}%`],
    );
    // Workers' databases first: the template can't be dropped while clones are being made.
    for (const { datname } of rows.sort((a) => (a.datname === template ? 1 : -1))) {
      await admin.query(`drop database if exists ${datname} with (force)`);
    }
    await admin.end();
  };
}
