// Records of the Cleanup and the Installation id that scopes it (docs/specs/workers.md, "Cleanup").
// The scheduler runs Cleanups; this module stores, loads and publishes them.
import { EMPTY_CLEANUP_COUNTS, WORKERS_TOPIC } from '@claude-task/shared';
import type { Cleanup, CleanupCounts } from '@claude-task/shared';
import { desc, eq, notInArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { cleanups, installation, users } from '../../db/schema';

/** Cleanups kept; older ones go when a new one starts. */
export const CLEANUPS_KEPT = 20;

/** The Installation id, created on first start. */
export async function ensureInstallationId(db: Executor): Promise<string> {
  const [row] = await db.select({ id: installation.id }).from(installation).limit(1);
  if (row) return row.id;
  const [created] = await db.insert(installation).values({}).returning({ id: installation.id });
  return created!.id;
}

export async function createCleanup(db: Executor, trigger: Cleanup['trigger'], userId: string | null): Promise<string> {
  const [row] = await db.insert(cleanups).values({ trigger, requestedBy: userId, removed: EMPTY_CLEANUP_COUNTS }).returning({ id: cleanups.id });
  const kept = db.select({ id: cleanups.id }).from(cleanups).orderBy(desc(cleanups.startedAt)).limit(CLEANUPS_KEPT);
  await db.delete(cleanups).where(notInArray(cleanups.id, kept));
  return row!.id;
}

/** Adds counts, bytes and errors to a Cleanup; returns whether it still exists. */
export async function addToCleanup(
  db: Executor,
  id: string,
  add: { removed?: Partial<CleanupCounts>; reclaimedBytes?: number; errors?: string[]; volumesPending?: number; finished?: boolean },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(cleanups).where(eq(cleanups.id, id)).for('update');
    if (!row) return false;
    const removed = { ...row.removed };
    for (const [key, n] of Object.entries(add.removed ?? {})) removed[key as keyof CleanupCounts] += n ?? 0;
    await tx
      .update(cleanups)
      .set({
        removed,
        reclaimedBytes: row.reclaimedBytes + Math.max(0, Math.round(add.reclaimedBytes ?? 0)),
        errors: [...row.errors, ...(add.errors ?? [])],
        volumesPending: Math.max(0, row.volumesPending + (add.volumesPending ?? 0)),
        ...(add.finished ? { finishedAt: new Date() } : {}),
      })
      .where(eq(cleanups.id, id));
    return true;
  });
}

export async function loadCleanup(db: Executor, id?: string): Promise<Cleanup | null> {
  const [row] = await db
    .select({ cleanup: cleanups, userName: users.displayName })
    .from(cleanups)
    .leftJoin(users, eq(users.id, cleanups.requestedBy))
    .where(id ? eq(cleanups.id, id) : sql`true`)
    .orderBy(desc(cleanups.startedAt))
    .limit(1);
  if (!row) return null;
  const c = row.cleanup;
  return {
    id: c.id,
    trigger: c.trigger,
    requestedBy: c.requestedBy && row.userName ? { id: c.requestedBy, name: row.userName } : null,
    startedAt: c.startedAt.toISOString(),
    finishedAt: c.finishedAt?.toISOString() ?? null,
    removed: { ...EMPTY_CLEANUP_COUNTS, ...c.removed },
    reclaimedBytes: c.reclaimedBytes,
    volumesPending: c.volumesPending,
    errors: c.errors,
  };
}

export async function publishCleanup(ctx: AppContext, id: string): Promise<void> {
  const cleanup = await loadCleanup(ctx.db, id);
  if (cleanup) ctx.hub.publish(WORKERS_TOPIC, { type: 'cleanup.updated', cleanup });
}
