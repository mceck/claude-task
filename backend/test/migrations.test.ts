import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb, migrationsFolder, runMigrations } from '../src/db/client';
import { useTestApp } from './helpers/app';
import { assignAgent, createAgent, createProject, createTask, getSession } from './helpers/fixtures';
import { FakeRunner } from './helpers/runner';

/** The schema before Workers: Agents with their own container, one Session per (Task, Agent), Queues per Agent. */
const BEFORE_WORKERS = `
  ALTER TABLE workers DROP COLUMN host_id;
  DROP TABLE hosts;
  ALTER TABLE cleanups DROP COLUMN hosts_pending;
  ALTER TABLE agents ADD COLUMN dockerfile text NOT NULL DEFAULT 'FROM claude-task/agent-base', ADD COLUMN services jsonb NOT NULL DEFAULT '["postgres","redis"]',
    ADD COLUMN configured_extensions_revision integer NOT NULL DEFAULT -1, ADD COLUMN extensions_error text, ADD COLUMN cpu_limit double precision,
    ADD COLUMN memory_mb integer, ADD COLUMN runner_token_hash text, ADD COLUMN image_tag text, ADD COLUMN image_state image_state NOT NULL DEFAULT 'none',
    ADD COLUMN image_base_version text, ADD COLUMN container_spec text, ADD COLUMN container_state text NOT NULL DEFAULT 'missing',
    ADD COLUMN force_recreate boolean NOT NULL DEFAULT false, ADD COLUMN runner_connected_at timestamptz, ADD COLUMN runner_disconnected_at timestamptz,
    ADD COLUMN runner_version text, ADD COLUMN claude_version text;
  CREATE TABLE agent_builds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    dockerfile text NOT NULL, base_version text NOT NULL, status build_status NOT NULL DEFAULT 'building', image_tag text, log text NOT NULL DEFAULT '',
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
  ALTER TABLE sessions ADD COLUMN agent_id uuid;
  UPDATE sessions s SET agent_id = coalesce(s.last_agent_id, t.agent_id) FROM tasks t WHERE t.id = s.task_id;
  DELETE FROM sessions WHERE agent_id IS NULL;
  ALTER TABLE sessions ALTER COLUMN agent_id SET NOT NULL,
    ADD CONSTRAINT sessions_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
  DROP INDEX sessions_task_unique;
  CREATE UNIQUE INDEX sessions_task_agent_unique ON sessions (task_id, agent_id);
  CREATE INDEX sessions_agent_idx ON sessions (agent_id);
  ALTER TABLE sessions DROP COLUMN last_agent_id, DROP COLUMN last_slot;
  DELETE FROM queue_entries;
  ALTER TABLE queue_entries ADD COLUMN agent_id uuid NOT NULL,
    ADD CONSTRAINT queue_entries_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
  DROP INDEX queue_entries_task_unique;
  DROP INDEX queue_entries_worker_position_idx;
  CREATE UNIQUE INDEX queue_entries_agent_task_unique ON queue_entries (agent_id, task_id);
  CREATE INDEX queue_entries_agent_position_idx ON queue_entries (agent_id, position);
  ALTER TABLE queue_entries DROP COLUMN worker_id;
  ALTER TABLE jobs DROP COLUMN agent_name, DROP COLUMN worker_id, DROP COLUMN container_id, DROP COLUMN slot;
  ALTER TABLE projects DROP COLUMN worker_id;
  DROP TABLE agent_profiles, worker_builds, worker_containers, workers;
`;

// Recreate previously applied schemas and ledgers in the disposable test DB.
describe('migration upgrades', () => {
  const app = useTestApp();

  // Replaying an upgrade replaces the seeded Host id; reattach the harness's local daemon.
  async function migrateApp(): Promise<void> {
    await runMigrations(app.server.ctx.db);
    const [{ id }] = (await app.server.ctx.db.$client.query("SELECT id FROM hosts WHERE kind = 'local'")).rows;
    app.server.ctx.runtimes.attach(id, app.runtime);
  }


  // The migrations take about 2 seconds. DROP DATABASE forces a checkpoint, which has to fsync everything the other
  // test files wrote meanwhile: on a disk with slow fsync that took up to a minute while the whole suite was running.
  const DROP_DATABASE_SLACK_MS = 120_000;

  it('assigns existing Workers to the Local Host when upgrading', async () => {
    const { db } = app.server.ctx;
    const before = (await db.$client.query('SELECT id, name FROM workers ORDER BY id')).rows;
    const journal = JSON.parse(await readFile(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8'));
    const migration = journal.entries.find((entry: { tag: string }) => entry.tag === '0039_remote_hosts');
    expect(migration).toBeDefined();
    await db.$client.query('ALTER TABLE workers DROP COLUMN host_id; DROP TABLE hosts; ALTER TABLE cleanups DROP COLUMN hosts_pending');
    await db.$client.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= $1', [migration.when]);
    await migrateApp();
    expect((await db.$client.query('SELECT w.id, w.name FROM workers w JOIN hosts h ON h.id = w.host_id WHERE h.kind = \'local\' ORDER BY w.id')).rows).toEqual(before);
    expect((await db.$client.query('SELECT name FROM hosts')).rows).toEqual([{ name: 'Local' }]);
  });

  it('serializes two processes migrating the same empty database', { timeout: DROP_DATABASE_SLACK_MS }, async () => {
    const name = `ct_mig_${randomBytes(4).toString('hex')}`;
    const url = new URL(app.server.ctx.config.databaseUrl);
    url.pathname = `/${name}`;
    await app.server.ctx.db.$client.query(`create database ${name}`);
    const first = createDb(url.toString());
    const second = createDb(url.toString());
    try {
      const results = await Promise.allSettled([runMigrations(first.db), runMigrations(second.db)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      // A fresh installation starts without a Worker: an Admin creates the first one.
      expect((await first.pool.query('SELECT count(*)::int AS n FROM workers')).rows[0].n).toBe(0);
    } finally {
      await first.pool.end();
      await second.pool.end();
      await app.server.ctx.db.$client.query(`drop database if exists ${name} with (force)`);
    }
  });

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
    await db.$client.query(BEFORE_WORKERS);
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
      ALTER TABLE comments DROP COLUMN started_agent_id;
      ALTER TABLE projects DROP COLUMN board_write_access;
      ALTER TABLE tasks DROP COLUMN chat_title;
      ALTER TABLE turns DROP COLUMN context_tokens, DROP COLUMN context_window;
      ALTER TABLE sessions DROP COLUMN worktree_status;
      DROP INDEX IF EXISTS turns_task_idx;
    `);
    await db.$client.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at > $1', [original.when]);
    expect((await db.$client.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1')).rows[0].hash)
      .toBe('ab1884a99d4a0f6b79ea3b44125718e9d2613eb18b1d6748ec4039800ac590f7');

    await migrateApp();
    const first = (await db.$client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    await migrateApp();
    expect((await db.$client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows).toEqual(first);
    expect((await admin.get(`/tasks/${task.id}`)).body.task).toMatchObject({ title: 'Existing task', description: 'Keep this content', chatGeneration: 0 });
    // The upgrade to Workers keeps the Session, which starts a new conversation on the new Worker Volume.
    expect(await getSession(admin, task.id)).toMatchObject({ id: session!.id, state: 'pending' });
    const [{ worker_id: workerId }] = (await db.$client.query('SELECT worker_id FROM projects WHERE id = $1', [project.id])).rows;
    expect((await db.$client.query('SELECT name, minimum, cap, services FROM workers WHERE id = $1', [workerId])).rows).toEqual([
      { name: 'Default', minimum: 0, cap: 1, services: ['postgres', 'redis'] },
    ]);
    const [column] = (await db.$client.query(`SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'claude_session_id'`)).rows;
    expect(column).toEqual({ is_nullable: 'YES', column_default: null });

    // The Default Worker builds and starts a container when work arrives; a fake Runner plays it.
    await runner.close();
    await admin.post(`/tasks/${task.id}/comments`, { body: 'Continue the existing conversation' });
    await app.server.ctx.scheduler.reconcileAll();
    await app.settle();
    const upgraded = await FakeRunner.connect(app, workerId);
    const start = await upgraded.next('job.start');
    expect(start).toMatchObject({ mode: 'new', sessionId: session!.id });
    expect(start.initialMessage?.map((b) => (b.type === 'text' ? b.text : '')).join('\n')).toContain('Continue the existing conversation');
  });

  it('moves existing Projects to a Default Worker and keeps one Session per Task, starting over', async () => {
    const admin = await app.admin();
    const { project } = await createProject(admin);
    const task = await createTask(admin, project.id);
    const { agent } = await createAgent(app, admin, { name: 'Ada Bot' });
    const { agent: other } = await createAgent(app, admin, { name: 'Bea Bot' });
    await assignAgent(admin, task.id, agent.id);
    const current = await getSession(admin, task.id);
    const { db } = app.server.ctx;
    const journal = JSON.parse(await readFile(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
    const workers = journal.entries.find((e) => e.tag === '0033_workers')!;
    await db.$client.query(BEFORE_WORKERS);
    await db.$client.query('ALTER TABLE sessions DROP COLUMN worktree_status');
    // An earlier Agent's Session on the same Task, started, with a Comment waiting in its Queue.
    const [{ id: older }] = (await db.$client.query(
      `INSERT INTO sessions (task_id, agent_id, state, worktree_path, started) SELECT task_id, $1, 'paused', worktree_path, true FROM sessions WHERE id = $2 RETURNING id`,
      [other.id, current!.id],
    )).rows;
    await db.$client.query(`UPDATE sessions SET state = 'idle', started = true WHERE id = $1`, [current!.id]);
    const [{ id: entry }] = (await db.$client.query(
      `INSERT INTO queue_entries (agent_id, task_id, session_id, kind, position) VALUES ($1, $2, $3, 'messages', 'a0') RETURNING id`,
      [agent.id, task.id, current!.id],
    )).rows;
    await db.$client.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= $1', [workers.when]);

    await migrateApp();
    const sessions = (await db.$client.query('SELECT id, state, started, last_agent_id FROM sessions WHERE task_id = $1', [task.id])).rows;
    expect(sessions).toEqual([{ id: current!.id, state: 'pending', started: false, last_agent_id: agent.id }]);
    expect((await db.$client.query('SELECT 1 FROM sessions WHERE id = $1', [older])).rows).toEqual([]);
    const [{ worker_id: workerId }] = (await db.$client.query('SELECT worker_id FROM projects WHERE id = $1', [project.id])).rows;
    expect((await db.$client.query('SELECT name FROM workers')).rows).toEqual([{ name: 'Default' }]);
    expect((await db.$client.query('SELECT id, kind, worker_id FROM queue_entries')).rows).toEqual([{ id: entry, kind: 'start', worker_id: workerId }]);
    expect((await db.$client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'dockerfile'")).rows).toEqual([]);
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
      await db.$client.query(BEFORE_WORKERS);
      await db.$client.query('ALTER TABLE sessions DROP COLUMN worktree_status');
      await db.$client.query('ALTER TABLE users DROP COLUMN avatar_blob_id');
      await db.$client.query('ALTER TABLE projects DROP COLUMN default_agent_id');
      await db.$client.query('DROP TABLE survey_responses, questions');
      await db.$client.query('ALTER TABLE comments DROP COLUMN answers_comment_id');
      await db.$client.query('ALTER TABLE comments DROP COLUMN started_agent_id');
      await db.$client.query('ALTER TABLE projects DROP COLUMN board_write_access');
      await db.$client.query('ALTER TABLE tasks DROP COLUMN chat_title');
      await db.$client.query('DROP INDEX IF EXISTS turns_task_idx');
      await db.$client.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at > $1', [original.created_at]);
      await db.$client.query('UPDATE drizzle.__drizzle_migrations SET hash = $1, created_at = $2 WHERE id = $3', [hash, when, original.id]);
      const before = (await db.$client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;

      await migrateApp();
      await migrateApp();

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
