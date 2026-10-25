import type { Actor, ActorType } from '@claude-task/shared';
import { inArray } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { users } from '../db/schema';

export interface ActorRef {
  type: ActorType;
  id: string | null;
}

export type ActorResolver = (ref: ActorRef) => Actor;

/** Loads display names for a batch of actor references. */
export async function actorResolver(db: Executor, refs: ActorRef[]): Promise<ActorResolver> {
  const userIds = [...new Set(refs.filter((r) => r.type === 'user' && r.id).map((r) => r.id!))];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const r of rows) names.set(r.id, r.displayName);
  }
  return (ref) => {
    if (ref.type === 'system') return { type: 'system', id: null, displayName: 'System' };
    if (ref.type === 'user') return { type: 'user', id: ref.id, displayName: names.get(ref.id!) ?? 'Unknown user' };
    // Agents arrive with Spec 02.
    return { type: ref.type, id: ref.id, displayName: 'Agent' };
  };
}
