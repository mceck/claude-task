import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { agentBuilds, agents } from '../../db/schema';

/** Builds cut short by a backend restart are failed, and their Agents rebuilt by the reconciler. */
export async function resetInterruptedBuilds(db: Db): Promise<void> {
  // The Agent may not have reached `building` before the restart; find them from the Build rows.
  await db.execute(sql`update agents set image_state = 'none'
    where id in (select agent_id from agent_builds where status = 'building')`);
  await db
    .update(agentBuilds)
    .set({ status: 'failed', finishedAt: new Date(), log: sql`${agentBuilds.log} || '\nThe backend restarted during this build.\n'` })
    .where(eq(agentBuilds.status, 'building'));
  await db.update(agents).set({ imageState: 'none' }).where(eq(agents.imageState, 'building'));
}
