import type { RealtimeEvent, Topic } from '@claude-task/shared';
import type { BlobStore } from './blobstore';
import type { Config } from './config';
import type { Db, Tx } from './db/client';
import type { RealtimeHub } from './realtime/hub';

export interface AppContext {
  config: Config;
  db: Db;
  hub: RealtimeHub;
  blobs: BlobStore;
}

/**
 * Collects what must happen only once the transaction has committed: real-time
 * events and cleanup like deleting blobs. Nothing runs if the transaction rolls back.
 */
export class AfterCommit {
  readonly events: { topic: Topic; event: RealtimeEvent }[] = [];
  readonly tasks: (() => Promise<void>)[] = [];

  emit(topic: Topic, event: RealtimeEvent): void {
    this.events.push({ topic, event });
  }

  run(task: () => Promise<void>): void {
    this.tasks.push(task);
  }
}

export async function transact<T>(
  ctx: AppContext,
  fn: (tx: Tx, after: AfterCommit) => Promise<T>,
): Promise<T> {
  const after = new AfterCommit();
  const result = await ctx.db.transaction((tx) => fn(tx, after));
  for (const { topic, event } of after.events) ctx.hub.publish(topic, event);
  // Best-effort cleanup (an orphaned blob is harmless), so the response doesn't wait for it.
  if (after.tasks.length > 0) void Promise.allSettled(after.tasks.map((task) => task()));
  return result;
}
