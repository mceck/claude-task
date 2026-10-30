import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createDb, runMigrations } from './db/client';
import { createOrPromoteAdmin } from './modules/users/service';

const USAGE = `Usage:
  cli create-admin --email <email> [--password <password>] [--name <display name>]

Creates an admin, or promotes and reactivates an existing user with that email.
The password can also come from ADMIN_PASSWORD. Without one, a new user gets a
generated temporary password (printed once) and an existing user keeps theirs.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'create-admin') {
    console.error(USAGE);
    return command === undefined || command === '--help' ? 0 : 1;
  }
  const { values } = parseArgs({
    args: rest,
    options: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } },
  });
  if (!values.email) {
    console.error(USAGE);
    return 1;
  }
  if (!z.email().max(320).safeParse(values.email.trim()).success) {
    console.error('The email must be a valid address of at most 320 characters.');
    return 1;
  }
  const password = values.password ?? (process.env.ADMIN_PASSWORD || undefined);
  if (password !== undefined && (password.length < 8 || password.length > 200)) {
    console.error('The password must be between 8 and 200 characters.');
    return 1;
  }
  const name = values.name?.trim();
  if (name !== undefined && (name.length < 1 || name.length > 100)) {
    console.error('The display name must be between 1 and 100 characters.');
    return 1;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    return 1;
  }

  const { db, pool } = createDb(databaseUrl);
  try {
    await runMigrations(db);
    const result = await db.transaction((tx) => createOrPromoteAdmin(tx, { email: values.email!, password, displayName: name }));
    console.log(`${result.created ? 'Created' : 'Promoted'} admin ${result.user.email}`);
    if (result.generatedPassword) {
      console.log(`Temporary password (change it at first login): ${result.generatedPassword}`);
    }
    return 0;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
