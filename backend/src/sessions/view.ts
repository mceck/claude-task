import { chatCommands } from '@claude-task/shared';
import type { TaskSession } from '@claude-task/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { agentSkills, jobs, queueEntries, sessions, skills, tasks, turns } from '../db/schema';
import { agentRefs } from '../modules/agents/service';

export type SessionRow = typeof sessions.$inferSelect;

/** Fields whose human edits the Agent can be notified about; status and assignees don't drive it. */
export const NOTIFIABLE_FIELDS = ['title', 'description', 'priority', 'tagIds'] as const;

const notifiable = sql.raw(NOTIFIABLE_FIELDS.map((f) => `'${f}'`).join(', '));

/**
 * Whether Users left a notifiable field different from where the Agent last saw it.
 * A value edited and then restored is not an unseen change, matching the change list
 * that Notify agent would send.
 */
export function unseenChangesSql(taskId: unknown, lastSeen: unknown) {
  return sql<boolean>`exists (
    select 1 from (
      select c->>'field' as field,
        (array_agg(c->'before' order by r.version))[1] as before,
        (array_agg(c->'after' order by r.version desc))[1] as after
      from task_revisions r
      cross join lateral jsonb_array_elements(r.changes) c
      where r.task_id = ${taskId} and r.version > ${lastSeen} and r.actor_type = 'user'
        and c->>'field' in (${notifiable})
      group by 1
    ) net
    where net.before is distinct from net.after)`;
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
  const [project] = await db.select({ skills: jobs.projectSkills }).from(jobs).where(and(eq(jobs.sessionId, s.id), isNotNull(jobs.projectSkills)))
    .orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1);
  // One Session per (Task, Agent), so the Agent's latest Turn on the Task is this Session's latest.
  // A Turn that couldn't measure the context leaves the previous measurement standing.
  const [lastTurn] = await db.select({ tokens: turns.contextTokens, window: turns.contextWindow }).from(turns)
    .where(and(eq(turns.taskId, taskId), eq(turns.agentId, s.agentId), isNotNull(turns.contextTokens)))
    .orderBy(desc(turns.finishedAt), desc(turns.index)).limit(1);
  return {
    // A Job's report follows the Worktree exactly; the Session's own copy fills the gap before one has run.
    commands: chatCommands(runtime?.commands ?? null, skillRows, project?.skills ?? s.projectSkills ?? []),
    id: s.id,
    agent,
    state: s.state,
    queuePosition: entry?.position ?? null,
    held: entry?.held ?? false,
    // A pending Session hasn't read anything yet, and its first Message carries the whole Task.
    unseenChanges: (s.state === 'idle' || s.state === 'running') && unseen,
    context: lastTurn?.tokens == null ? null : { tokens: lastTurn.tokens, window: lastTurn.window ?? null },
    lastJob: lastJob ?? null,
  };
}
