import { and, eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { projects, tasks } from '../db/schema';

type TaskRef = Pick<typeof tasks.$inferSelect, 'id' | 'projectId' | 'number'>;

/**
 * The Task that owns the Worktree, Task Branch and pull request of a Task. A Wiki's Chats are Tasks of its
 * Wiki Project and all share the ones of its first Task; every other Task owns its own.
 */
export async function gitOwnerTask(db: Executor, task: TaskRef): Promise<typeof tasks.$inferSelect> {
  if (task.number !== 1) {
    const [p] = await db.select({ kind: projects.kind }).from(projects).where(eq(projects.id, task.projectId));
    if (p?.kind === 'wiki') {
      const [owner] = await db.select().from(tasks).where(and(eq(tasks.projectId, task.projectId), eq(tasks.number, 1)));
      if (owner) return owner;
    }
  }
  const [self] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  return self!;
}
