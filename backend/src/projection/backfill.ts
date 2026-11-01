// Fills Context Usage for Turns recorded before the projection stored it. Replaying each Job's raw
// stream with the same projection clients see live keeps the backfill and the live rules identical.
import type { ContextUsage } from '@claude-task/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { sessionEvents, turns } from '../db/schema';
import { initialProjection, project } from './projector';

/** The logger calls the backfill makes; the app's pino logger fits. */
export interface BackfillLog {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Walks the Jobs that still have Turns without Context Usage, replays their events and writes the
 * result. A Turn the stream cannot measure (no model call, no `modelUsage`) gets 0 tokens, the mark
 * that says "checked": the Session view ignores it, and the next start does not replay the Job again.
 */
export async function backfillTurnContexts(db: Executor, log?: BackfillLog): Promise<number> {
  const gaps = await db.select({ jobId: turns.jobId }).from(turns).where(isNull(turns.contextTokens)).groupBy(turns.jobId);
  let filled = 0;
  for (const { jobId } of gaps) {
    const events = await db
      .select({ payload: sessionEvents.payload, receivedAt: sessionEvents.receivedAt })
      .from(sessionEvents)
      .where(eq(sessionEvents.jobId, jobId))
      .orderBy(asc(sessionEvents.seq));
    const contexts = new Map<number, ContextUsage>();
    if (events.length > 0) {
      let state = initialProjection();
      for (const event of events) {
        const projected = project(state, event.payload, { jobId, credentialName: '', receivedAt: event.receivedAt.toISOString() });
        state = projected.state;
        for (const mutation of projected.mutations) {
          if (mutation.op === 'turn' && mutation.turn.context) contexts.set(mutation.turn.index, mutation.turn.context);
        }
      }
    }
    const open = await db.select({ index: turns.index }).from(turns).where(and(eq(turns.jobId, jobId), isNull(turns.contextTokens)));
    for (const { index } of open) {
      const context = contexts.get(index);
      await db
        .update(turns)
        .set({ contextTokens: context?.tokens ?? 0, contextWindow: context?.window ?? null })
        .where(and(eq(turns.jobId, jobId), eq(turns.index, index), isNull(turns.contextTokens)));
      if (context) filled++;
    }
  }
  if (gaps.length > 0) log?.info({ jobs: gaps.length, turns: filled }, 'backfilled Context Usage from the raw stream');
  return filled;
}
