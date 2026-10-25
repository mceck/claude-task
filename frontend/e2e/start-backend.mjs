// Starts the backend for the Playwright suite on a freshly created database.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '../../backend');
const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres');
const dbName = 'claude_task_e2e';

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`drop database if exists ${dbName} with (force)`);
await admin.query(`create database ${dbName}`);
await admin.end();

const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${dbName}`;

const child = spawn(path.join(backendDir, 'node_modules/.bin/tsx'), ['test/e2e/server.ts'], {
  cwd: backendDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
    HOST: '127.0.0.1',
    PORT: process.env.PORT ?? '3100',
    DATA_DIR: mkdtempSync(path.join(tmpdir(), 'ct-e2e-')),
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'admin-password',
    ADMIN_NAME: 'Ada Admin',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'warn',
    SECRETS_MASTER_KEY: Buffer.alloc(32, 42).toString('base64'),
    AGENT_RUNTIME: 'fake',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
