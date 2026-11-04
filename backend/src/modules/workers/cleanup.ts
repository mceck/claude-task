// Records of the Cleanup, the Installation id that scopes it and the Worker Volume requests
// (docs/specs/workers.md, "Cleanup"). The scheduler runs Cleanups; this module keeps their data.
import { EMPTY_CLEANUP_COUNTS, WORKERS_TOPIC } from '@claude-task/shared';
import type { BackendToRunner, Cleanup, CleanupCounts, CleanupTrigger } from '@claude-task/shared';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { agents, cleanups, installation, jobs, projects, tasks, users, workers } from '../../db/schema';
import { ACTIVE_JOB_STATES } from '../agents/service';

/** Cleanups kept; older ones go when a new one starts. */
export const CLEANUPS_KEPT = 20;

/** The Installation id, created on first start. */
export async function ensureInstallationId(db: Executor): Promise<string> {
  const [row] = await db.select({ id: installation.id }).from(installation).limit(1);
  if (row) return row.id;
  const [created] = await db.insert(installation).values({}).returning({ id: installation.id });
  return created!.id;
}

export async function createCleanup(db: Executor, trigger: CleanupTrigger, userId: string | null): Promise<string> {
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

/** The record is for Admins: the event only says which Cleanup changed, and Admins load it. */
export async function publishCleanup(ctx: AppContext, id: string): Promise<void> {
  ctx.hub.publish(WORKERS_TOPIC, { type: 'cleanup.updated', cleanupId: id });
}

/** What a Runner of the Worker keeps in its Worker Volume: the Projects that run there and every Agent. */
export async function volumeCleanupRequest(db: Executor, workerId: string, requestId: string): Promise<BackendToRunner> {
  const assigned = await db.select({ id: projects.id }).from(projects).where(eq(projects.workerId, workerId));
  const working = await db
    .selectDistinct({ id: projects.id })
    .from(jobs)
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(jobs.workerId, workerId), inArray(jobs.state, [...ACTIVE_JOB_STATES])));
  const agentRows = await db.select({ id: agents.id }).from(agents);
  return {
    type: 'volume.cleanup',
    requestId,
    keepProjects: [...new Set([...assigned, ...working].map((p) => p.id))],
    keepAgents: agentRows.map((a) => a.id),
  };
}

/**
 * A Worker Volume answered: its counts go to the Cleanup that asked. Only the first answer to the
 * request still pending on the Worker stops the Cleanup waiting, since a request can go out twice
 * (once when sent, again when a Runner says hello before the answer).
 */
export async function settleVolumeCleanup(
  db: Executor,
  workerId: string,
  cleanupId: string,
  result: { projects: number; agentProfiles: number; reclaimedBytes: number; error: string | null },
): Promise<boolean> {
  const claimed = await db
    .update(workers)
    .set({ volumeCleanupPending: null })
    .where(and(eq(workers.id, workerId), eq(workers.volumeCleanupPending, cleanupId)))
    .returning({ id: workers.id });
  return addToCleanup(db, cleanupId, {
    removed: { projects: result.projects, agentProfiles: result.agentProfiles },
    reclaimedBytes: result.reclaimedBytes,
    errors: result.error ? [result.error] : [],
    volumesPending: claimed.length ? -1 : 0,
  });
}
