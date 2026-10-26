import { chatCommands } from '@claude-task/shared';
import type { TaskSession } from '@claude-task/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { agentSkills, jobs, queueEntries, sessions, skills, tasks } from '../db/schema';
import { agentRefs } from '../modules/agents/service';

export type SessionRow = typeof sessions.$inferSelect;

/** Fields whose human edits the Agent can be notified about; status and assignees don't drive it. */
export const NOTIFIABLE_FIELDS = ['title', 'description', 'priority', 'tagIds'] as const;

const notifiable = sql.raw(NOTIFIABLE_FIELDS.map((f) => `'${f}'`).join(', '));

/** Whether Users edited the Task after the Agent last read it. */
export function unseenChangesSql(taskId: unknown, lastSeen: unknown) {
  return sql<boolean>`exists (
    select 1 from task_revisions r
    where r.task_id = ${taskId} and r.version > ${lastSeen} and r.actor_type = 'user'
      and exists (select 1 from jsonb_array_elements(r.changes) c where c->>'field' in (${notifiable})))`;
}

export async function loadTaskSession(db: Executor, taskId: string): Promise<TaskSession | null> {
  const [row] = await db
    .select({ session: sessions, agentId: tasks.agentId })
    .from(tasks)
    .innerJoin(sessions, eq(sessions.id, tasks.currentSessionId))
    .where(eq(tasks.id, taskId));
  if (!row) return null;
  const s = row.session;
  const [entry] = await db
    .select({
      held: queueEntries.held,
      position: sql<number>`(select count(*)::int from queue_entries q2 where q2.agent_id = queue_entries.agent_id and q2.position <= queue_entries.position)`,
    })
    .from(queueEntries)
    .where(and(eq(queueEntries.agentId, s.agentId), eq(queueEntries.taskId, taskId)));
  const [lastJob] = await db
    .select({ id: jobs.id, state: jobs.state, failureStage: jobs.failureStage, error: jobs.error })
    .from(jobs)
    .where(eq(jobs.sessionId, s.id))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  const [{ unseen } = { unseen: false }] = await db
    .select({ unseen: unseenChangesSql(taskId, s.lastSeenTaskVersion) })
    .from(sessions)
    .where(eq(sessions.id, s.id));
  const agent = (await agentRefs(db, [s.agentId])).get(s.agentId)!;
  const skillRows = await db.select({ name: skills.name, description: skills.description }).from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(and(eq(agentSkills.agentId, s.agentId), eq(skills.userInvocable, true)));
  const [runtime] = await db.select({ commands: jobs.slashCommands }).from(jobs).where(and(eq(jobs.sessionId, s.id), isNotNull(jobs.slashCommands)))
    .orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1);
  return {
    commands: chatCommands(runtime?.commands ?? null, skillRows),
    id: s.id,
    agent,
    state: s.state,
    queuePosition: entry?.position ?? null,
    held: entry?.held ?? false,
    // A pending Session hasn't read anything yet, and its first Message carries the whole Task.
    unseenChanges: (s.state === 'idle' || s.state === 'running') && unseen,
    lastJob: lastJob ?? null,
  };
}
