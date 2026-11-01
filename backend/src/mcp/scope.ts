// Who is calling the Task Tools: the Job a token belongs to, and what that Job may reach.
import type { Actor } from '@claude-task/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import type { Executor } from '../db/client';
import { agents, jobs, projects, schedules, sessions, tasks } from '../db/schema';
import { unauthorized } from '../errors';
import { ACTIVE_JOB_STATES } from '../modules/agents/service';
import { hashToken } from '../secrets';

export interface JobScope {
  jobId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
  projectId: string;
  /** `project`, `wiki` or `schedule`: only an ordinary Project's Tasks are edited through the board tools. */
  projectKind: string;
  /** The Project has a Repository, so the Task has a branch to hand off. */
  hasRepository: boolean;
  /** The Project lets its Agents act on every Task of the Project. */
  boardWriteAccess: boolean;
  actor: Actor;
  /** The Job belongs to a Scheduled Run: `global` when its Schedule has no Repository. */
  schedule: { global: boolean; readOnly: boolean } | null;
}

/** Valid only while its Job runs, and not once a human closed the Task or unassigned the Agent. */
export const activeJobCondition = and(inArray(jobs.state, [...ACTIVE_JOB_STATES]), eq(jobs.cancelRequested, false), eq(sessions.state, 'running'));

export async function jobScope(ctx: AppContext, request: FastifyRequest): Promise<JobScope> {
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token) throw unauthorized('Missing job token');
  const [row] = await ctx.db
    .select({
      job: jobs,
      agentName: agents.name,
      projectId: tasks.projectId,
      projectKind: projects.kind,
      boardWriteAccess: projects.boardWriteAccess,
      repository: projects.repository,
      scheduleId: schedules.id,
      scheduleReadOnly: schedules.readOnly,
    })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(schedules, eq(schedules.projectId, tasks.projectId))
    .where(and(eq(jobs.tokenHash, hashToken(token)), activeJobCondition));
  if (!row) throw unauthorized('Unknown or expired job token');
  return {
    jobId: row.job.id,
    agentId: row.job.agentId,
    taskId: row.job.taskId,
    sessionId: row.job.sessionId,
    projectId: row.projectId,
    projectKind: row.projectKind,
    hasRepository: !!row.repository,
    boardWriteAccess: row.boardWriteAccess,
    actor: { type: 'agent', id: row.job.agentId, displayName: row.agentName },
    schedule: row.scheduleId ? { global: !row.repository, readOnly: row.scheduleReadOnly ?? false } : null,
  };
}

/** Re-checked inside a write: a slow tool call may outlive its Job, or the Task may close meanwhile. */
export async function assertJobActive(tx: Executor, scope: JobScope, what: string): Promise<void> {
  const [job] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(sessions, eq(sessions.id, jobs.sessionId))
    .where(and(eq(jobs.id, scope.jobId), activeJobCondition));
  if (!job) throw unauthorized(`Your job ended before ${what}`);
}
