import { sql } from 'drizzle-orm';
import type { Executor } from './client';

/**
 * The Timeline positions of some of a Task's entries, by item id. Positions are the persisted
 * insert order (docs/specs/conversation.md): the server orders the Timeline by them and live events
 * carry them, because timestamps alone can tie once clients see only milliseconds.
 */
export async function loadTimelinePositions(db: Executor, taskId: string, itemIds: string[]): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const rows = (
    await db.execute<{ item_id: string; position: string }>(sql`
      select item_id, position::text from task_activity
      where task_id = ${taskId}::uuid and item_id in (${sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
  ).rows;
  return new Map(rows.map((r) => [r.item_id, r.position]));
}
