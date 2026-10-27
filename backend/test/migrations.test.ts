import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolder, runMigrations } from '../src/db/client';
import { useTestApp } from './helpers/app';
import { assignAgent, createAgent, createProject, createTask, getSession } from './helpers/fixtures';

// The test app's DB is disposable. Recreate the exact schema and ledger left by
// the first Wiki migration, which the local watch process had already applied.
describe('migration upgrades', () => {
  const app = useTestApp();

  it('upgrades the originally applied Wiki migration without replaying it or losing existing Claude sessions', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id, { title: 'Existing task', description: 'Keep this content' });
    const { agent, runner } = await createAgent(app, admin);
    await assignAgent(admin, task.id, agent.id);
    await app.settle();
    const session = await getSession(admin, task.id);
    const { db } = app.server.ctx;
    const journal = JSON.parse(await readFile(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    const original = journal.entries.find((e) => e.tag === '0014_wiki')!;
    expect(original.when).toBe(1793054532571);
    await db.$client.query(`
      ALTER TABLE sessions ALTER COLUMN claude_session_id SET DEFAULT gen_random_uuid();
      UPDATE sessions SET claude_session_id = gen_random_uuid(), started = true, state = 'idle';
      ALTER TABLE sessions ALTER COLUMN claude_session_id SET NOT NULL;
      ALTER TABLE tasks DROP COLUMN chat_generation;
    `);
    await db.$client.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at > $1', [original.when]);
    expect((await db.$client.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1')).rows[0].hash)
      .toBe('ab1884a99d4a0f6b79ea3b44125718e9d2613eb18b1d6748ec4039800ac590f7');

    await runMigrations(db);
    const first = (await db.$client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    await runMigrations(db);
    expect((await db.$client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows).toEqual(first);
    expect((await admin.get(`/tasks/${task.id}`)).body.task).toMatchObject({ title: 'Existing task', description: 'Keep this content', chatGeneration: 0 });
    expect(await getSession(admin, task.id)).toMatchObject({ id: session!.id, state: 'idle' });
    const [column] = (await db.$client.query(`SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'claude_session_id'`)).rows;
    expect(column).toEqual({ is_nullable: 'YES', column_default: null });

    await admin.post(`/tasks/${task.id}/comments`, { body: 'Continue the existing conversation' });
    const start = await runner.next('job.start');
    expect(start).toMatchObject({ mode: 'resume', sessionId: session!.id });
  });
});
