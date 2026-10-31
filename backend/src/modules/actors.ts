import type { Actor, ActorType } from '@claude-task/shared';
import { inArray } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { agents, users } from '../db/schema';

/** The Actor behind what the platform does on its own, such as the Tasks and prompt Comments of Scheduled Runs. */
export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, displayName: 'System' };

export interface ActorRef {
  type: ActorType;
  id: string | null;
}

export type ActorResolver = (ref: ActorRef) => Actor;

/** Loads display names for a batch of actor references. */
export async function actorResolver(db: Executor, refs: ActorRef[]): Promise<ActorResolver> {
  const userIds = [...new Set(refs.filter((r) => r.type === 'user' && r.id).map((r) => r.id!))];
  const agentIds = [...new Set(refs.filter((r) => r.type === 'agent' && r.id).map((r) => r.id!))];
  const names = new Map<string, string>();
  if (agentIds.length > 0) {
    const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds));
    for (const r of rows) names.set(r.id, r.name);
  }
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
    return { type: 'agent', id: ref.id, displayName: names.get(ref.id!) ?? 'Deleted agent' };
  };
}
