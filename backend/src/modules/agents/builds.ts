import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { agentBuilds, agents } from '../../db/schema';

/** Builds cut short by a backend restart are failed, and their Agents rebuilt by the reconciler. */
export async function resetInterruptedBuilds(db: Db): Promise<void> {
  await db
    .update(agentBuilds)
    .set({ status: 'failed', finishedAt: new Date(), log: sql`${agentBuilds.log} || '\nThe backend restarted during this build.\n'` })
    .where(eq(agentBuilds.status, 'building'));
  await db.update(agents).set({ imageState: 'none' }).where(eq(agents.imageState, 'building'));
}
