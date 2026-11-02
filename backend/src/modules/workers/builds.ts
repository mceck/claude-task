import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { workerBuilds, workers } from '../../db/schema';

/** Builds cut short by a backend restart are failed, and their Workers rebuilt by the reconciler. */
export async function resetInterruptedBuilds(db: Db): Promise<void> {
  // The Worker may not have reached `building` before the restart; find them from the Build rows.
  await db.execute(sql`update workers set image_state = 'none'
    where id in (select worker_id from worker_builds where status = 'building')`);
  await db
    .update(workerBuilds)
    .set({ status: 'failed', finishedAt: new Date(), log: sql`${workerBuilds.log} || '\nThe backend restarted during this build.\n'` })
    .where(eq(workerBuilds.status, 'building'));
  await db.update(workers).set({ imageState: 'none' }).where(eq(workers.imageState, 'building'));
}
