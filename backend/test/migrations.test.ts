import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolder, runMigrations } from '../src/db/client';
import { useTestApp } from './helpers/app';
import { assignAgent, createAgent, createProject, createTask, getSession } from './helpers/fixtures';

// Recreate previously applied schemas and ledgers in the disposable test DB.
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
      ALTER TABLE projects DROP COLUMN logo_blob_id;
      ALTER TABLE users DROP COLUMN avatar_blob_id;
      ALTER TABLE projects DROP COLUMN default_agent_id;
      DROP TABLE survey_responses, questions;
      ALTER TABLE comments DROP COLUMN answers_comment_id;
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

  it.each([
    { when: 1793060000000, hash: 'a9cf8a04e7c47bdaaa3ef362edac6f22869773e7bf8f7db8edc1b357c5a49732' },
    { when: 1793070354010, hash: 'e3374ab8b40fa9a78cfbdea32f8ab9e4372d3df435dfac80deafefd96acd71b5' },
  ])('keeps existing Project logos without replaying the migration recorded at $when', async ({ when, hash }) => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const form = new FormData();
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    form.set('file', new Blob([image], { type: 'image/png' }), 'logo.png');
    const uploaded = await admin.request('PUT', `/projects/${project.id}/logo`, { form });
    expect(uploaded.status).toBe(200);
    const { db } = app.server.ctx;
    const journal = JSON.parse(await readFile(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    const logoMigration = journal.entries.find((entry) => entry.tag === '0017_project_logo')!;
    const original = (await db.$client.query('SELECT * FROM drizzle.__drizzle_migrations WHERE created_at = $1', [logoMigration.when])).rows[0];
    try {
      // Recreate the schema before User avatars so the newer migration is applied during the upgrade.
      await db.$client.query('ALTER TABLE users DROP COLUMN avatar_blob_id');
      await db.$client.query('ALTER TABLE projects DROP COLUMN default_agent_id');
      await db.$client.query('DROP TABLE survey_responses, questions');
      await db.$client.query('ALTER TABLE comments DROP COLUMN answers_comment_id');
      await db.$client.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at > $1', [original.created_at]);
      await db.$client.query('UPDATE drizzle.__drizzle_migrations SET hash = $1, created_at = $2 WHERE id = $3', [hash, when, original.id]);
      const before = (await db.$client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;

      await runMigrations(db);
      await runMigrations(db);

      const after = (await db.$client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(journal.entries.length);
      expect((await admin.get(`/projects/${project.id}`)).body.project.logoUrl).toBe(uploaded.body.project.logoUrl);
      const downloaded = await admin.get(`/projects/${project.id}/logo`);
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(downloaded.body)).toEqual(image);
    } finally {
      await db.$client.query('UPDATE drizzle.__drizzle_migrations SET hash = $1, created_at = $2 WHERE id = $3', [original.hash, original.created_at, original.id]);
    }
  });
});
