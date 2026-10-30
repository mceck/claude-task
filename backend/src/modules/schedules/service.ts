// Schedules (docs/specs/schedules.md): configuration, the run history, starting runs on the scheduler's
// tick and settling them when their Job ends.
import { randomUUID } from 'node:crypto';
import { SCHEDULE_STATUSES, nextCronRun, taskKey } from '@claude-task/shared';
import type { Actor, ProjectRepository, Schedule, ScheduleRun } from '@claude-task/shared';
import { and, desc, eq, lte, ne, sql } from 'drizzle-orm';
import type { AfterCommit, AppContext } from '../../context';
import { transact } from '../../context';
import type { Executor } from '../../db/client';
import { agents, jobs, projects, scheduleRuns, schedules, sessions, statuses, tasks, turns, users } from '../../db/schema';
import { badRequest, conflict, notFound } from '../../errors';
import { notifySchedule } from '../../notifications/schedules';
import { createUserComment } from '../comments/service';
import { createTask, deleteTask, getTaskRow, moveTask, updateTask } from '../tasks/service';

export type ScheduleRow = typeof schedules.$inferSelect;

/** The Actor behind everything a Schedule does: its Tasks and the prompt Comments. */
export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, displayName: 'System' };

/** Skipped runs in a row after which the creator is told the Schedule is blocked. */
const BLOCKED_AFTER_SKIPS = 3;

export function emitScheduleChanged(after: AfterCommit, scheduleId: string): void {
  after.emit('schedules', { type: 'schedule.changed', scheduleId });
}

export async function getScheduleRow(db: Executor, id: string, lock = false): Promise<ScheduleRow> {
  const query = db.select().from(schedules).where(eq(schedules.id, id));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw notFound('Schedule');
  return row;
}

/** The Schedule a Job's Task belongs to, when its Project is a Schedule Project. */
export async function scheduleOfProject(db: Executor, projectId: string): Promise<ScheduleRow | null> {
  const [row] = await db.select().from(schedules).where(eq(schedules.projectId, projectId));
  return row ?? null;
}

// Reading

export async function loadRuns(db: Executor, filter: { scheduleId?: string; limit?: number } = {}): Promise<ScheduleRun[]> {
  const rows = await db
    .select({
      run: scheduleRuns,
      projectKey: projects.key,
      number: tasks.number,
      statusName: statuses.name,
      category: statuses.category,
      closedAt: tasks.updatedAt,
    })
    .from(scheduleRuns)
    .leftJoin(tasks, eq(tasks.id, scheduleRuns.taskId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(filter.scheduleId ? eq(scheduleRuns.scheduleId, filter.scheduleId) : undefined)
    .orderBy(desc(scheduleRuns.createdAt), desc(scheduleRuns.id))
    .limit(filter.limit ?? 200);
  return rows.map(({ run, projectKey, number, statusName, category, closedAt }) => ({
    id: run.id,
    scheduleId: run.scheduleId,
    state: run.state === 'skipped' ? 'skipped' : category === 'closed' ? (statusName === 'Succeeded' ? 'succeeded' : 'failed') : 'running',
    manual: run.manual,
    dueAt: run.dueAt.toISOString(),
    taskId: run.taskId,
    taskKey: projectKey && number ? taskKey(projectKey, number) : null,
    skipReason: run.skipReason,
    startedAt: run.createdAt.toISOString(),
    finishedAt: run.state === 'started' && category === 'closed' && closedAt ? closedAt.toISOString() : null,
  }));
}

export async function listSchedules(db: Executor, id?: string): Promise<Schedule[]> {
  const rows = await db
    .select({ schedule: schedules, repository: projects.repository, creatorName: users.displayName })
    .from(schedules)
    .innerJoin(projects, eq(projects.id, schedules.projectId))
    .leftJoin(users, eq(users.id, schedules.createdBy))
    .where(id ? eq(schedules.id, id) : undefined)
    .orderBy(schedules.name);
  const latest = new Map<string, ScheduleRun>();
  for (const run of await loadRuns(db, { limit: 1000 })) if (!latest.has(run.scheduleId)) latest.set(run.scheduleId, run);
  return rows.map(({ schedule: s, repository, creatorName }) => ({
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    agentId: s.agentId,
    cron: s.cron,
    timeZone: s.timeZone,
    prompt: s.prompt,
    repository: repository as ProjectRepository | null,
    readOnly: s.readOnly,
    enabled: s.enabled,
    nextRunAt: s.nextRunAt?.toISOString() ?? null,
    consecutiveSkips: s.consecutiveSkips,
    createdBy: s.createdBy ? { id: s.createdBy, displayName: creatorName ?? 'Unknown user' } : null,
    lastRun: latest.get(s.id) ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));
}

export async function getSchedule(db: Executor, id: string): Promise<Schedule> {
  const [schedule] = await listSchedules(db, id);
  if (!schedule) throw notFound('Schedule');
  return schedule;
}

// Writing

async function assertAgent(db: Executor, agentId: string): Promise<void> {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
  if (!agent) throw badRequest('Unknown agent');
}

async function assertNameFree(db: Executor, name: string, exceptId?: string): Promise<void> {
  const [clash] = await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(sql`lower(${schedules.name}) = lower(${name})`, exceptId ? ne(schedules.id, exceptId) : undefined));
  if (clash) throw conflict('A schedule with this name already exists');
}

export interface ScheduleInput {
  name: string;
  agentId: string;
  cron: string;
  timeZone: string;
  prompt: string;
  repository: ProjectRepository | null;
  readOnly: boolean;
  enabled: boolean;
}

function computeNext(cron: string, timeZone: string, from: Date): Date {
  const next = nextCronRun(cron, timeZone, from);
  if (!next) throw badRequest('This cron expression never runs');
  return next;
}

export async function createSchedule(tx: Executor, after: AfterCommit, input: ScheduleInput, creatorId: string): Promise<Schedule> {
  await assertAgent(tx, input.agentId);
  await assertNameFree(tx, input.name);
  const nextRunAt = computeNext(input.cron, input.timeZone, new Date());
  // Internal keys stay within the readable Task Key format, like a Wiki's.
  let key: string;
  do {
    key = 'S' + [...randomUUID().replaceAll('-', '').slice(0, 5)].map((c) => String.fromCharCode(65 + parseInt(c, 16))).join('');
  } while ((await tx.select({ id: projects.id }).from(projects).where(eq(projects.key, key))).length);
  const [project] = await tx
    .insert(projects)
    .values({ key, kind: 'schedule', name: input.name, repository: input.repository, defaultAgentId: input.agentId })
    .returning();
  await tx.insert(statuses).values(SCHEDULE_STATUSES.map((s, position) => ({ ...s, position, projectId: project!.id })));
  const [row] = await tx
    .insert(schedules)
    .values({
      projectId: project!.id,
      name: input.name,
      agentId: input.agentId,
      cron: input.cron,
      timeZone: input.timeZone,
      prompt: input.prompt,
      readOnly: input.readOnly,
      enabled: input.enabled,
      nextRunAt: input.enabled ? nextRunAt : null,
      createdBy: creatorId,
    })
    .returning();
  emitScheduleChanged(after, row!.id);
  return getSchedule(tx, row!.id);
}

export type SchedulePatch = Partial<ScheduleInput>;

export async function updateSchedule(tx: Executor, after: AfterCommit, id: string, patch: SchedulePatch): Promise<Schedule> {
  const row = await getScheduleRow(tx, id, true);
  if (patch.agentId !== undefined) await assertAgent(tx, patch.agentId);
  if (patch.name !== undefined) await assertNameFree(tx, patch.name, id);
  const next = { ...row, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'repository')) } as ScheduleRow;
  const timingChanged = next.cron !== row.cron || next.timeZone !== row.timeZone || next.enabled !== row.enabled;
  let nextRunAt = row.nextRunAt;
  if (timingChanged) nextRunAt = next.enabled ? computeNext(next.cron, next.timeZone, new Date()) : null;
  if (next.enabled !== row.enabled && next.enabled) next.consecutiveSkips = 0;
  await tx
    .update(schedules)
    .set({
      name: next.name,
      agentId: next.agentId,
      cron: next.cron,
      timeZone: next.timeZone,
      prompt: next.prompt,
      readOnly: next.readOnly,
      enabled: next.enabled,
      consecutiveSkips: next.consecutiveSkips,
      nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(schedules.id, id));
  const projectPatch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) projectPatch.name = patch.name;
  if (patch.agentId !== undefined) projectPatch.defaultAgentId = patch.agentId;
  if (patch.repository !== undefined) {
    const [project] = await tx.select().from(projects).where(eq(projects.id, row.projectId)).for('update');
    const before = project!.repository;
    const changed = before?.connectionId !== patch.repository?.connectionId || before?.providerRepoId !== patch.repository?.providerRepoId;
    if (changed) {
      const [open] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(tasks, eq(tasks.id, sessions.taskId))
        .where(and(eq(tasks.projectId, row.projectId), ne(sessions.state, 'closed')))
        .limit(1);
      if (open) throw conflict('A run is still active: wait for it to finish before changing the repository.');
    }
    projectPatch.repository = patch.repository;
  }
  await tx.update(projects).set(projectPatch).where(eq(projects.id, row.projectId));
  emitScheduleChanged(after, id);
  return getSchedule(tx, id);
}

export async function deleteSchedule(tx: Executor, after: AfterCommit, id: string): Promise<string[]> {
  const row = await getScheduleRow(tx, id, true);
  const runTasks = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, row.projectId)).orderBy(tasks.number);
  const blobIds: string[] = [];
  for (const task of runTasks) blobIds.push(...(await deleteTask(tx, after, task.id)).blobIds);
  await tx.delete(projects).where(eq(projects.id, row.projectId));
  emitScheduleChanged(after, id);
  return blobIds;
}

// Runs

async function statusId(tx: Executor, projectId: string, name: string): Promise<string> {
  const [row] = await tx
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.name, name)));
  return row!.id;
}

/** The previous run is active while its Task is in the open `Running` Status. */
async function hasActiveRun(tx: Executor, projectId: string): Promise<boolean> {
  const [open] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(and(eq(tasks.projectId, projectId), ne(statuses.category, 'closed')))
    .limit(1);
  return !!open;
}

async function agentAvailable(tx: Executor, agentId: string | null): Promise<boolean> {
  if (!agentId) return false;
  const [agent] = await tx.select({ enabled: agents.enabled }).from(agents).where(eq(agents.id, agentId));
  return !!agent?.enabled;
}

const formatStamp = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(date);

/** Creates the run's Task, assigns the Agent and posts the prompt, which is the trigger of its first Job. */
export async function startRun(tx: Executor, after: AfterCommit, schedule: ScheduleRow, dueAt: Date, manual: boolean): Promise<ScheduleRun> {
  const created = await createTask(
    tx,
    after,
    schedule.projectId,
    {
      title: `${schedule.name} · ${formatStamp(dueAt, schedule.timeZone)}`,
      description: '',
      priority: 'none',
      tagIds: [],
      assigneeIds: [],
      statusId: await statusId(tx, schedule.projectId, 'Running'),
    },
    SYSTEM_ACTOR,
    { assignDefaultAgent: false },
  );
  await updateTask(tx, after, created.id, { version: created.version, agentId: schedule.agentId }, SYSTEM_ACTOR);
  await createUserComment(tx, after, await getTaskRow(tx, created.id), { body: schedule.prompt, internal: false, attachments: [] }, SYSTEM_ACTOR);
  const [run] = await tx.insert(scheduleRuns).values({ scheduleId: schedule.id, dueAt, state: 'started', manual, taskId: created.id }).returning();
  await tx.update(schedules).set({ consecutiveSkips: 0 }).where(eq(schedules.id, schedule.id));
  emitScheduleChanged(after, schedule.id);
  return (await loadRuns(tx, { scheduleId: schedule.id, limit: 1 })).find((r) => r.id === run!.id)!;
}

async function skipRun(tx: Executor, after: AfterCommit, schedule: ScheduleRow, dueAt: Date, reason: string): Promise<void> {
  const [run] = await tx.insert(scheduleRuns).values({ scheduleId: schedule.id, dueAt, state: 'skipped', skipReason: reason }).returning();
  const skips = schedule.consecutiveSkips + 1;
  await tx.update(schedules).set({ consecutiveSkips: skips }).where(eq(schedules.id, schedule.id));
  if (skips === BLOCKED_AFTER_SKIPS && schedule.createdBy)
    await notifySchedule(tx, { eventId: `schedule-blocked:${run!.id}`, kind: 'schedule.blocked', taskId: null, scheduleId: schedule.id, userId: schedule.createdBy });
  emitScheduleChanged(after, schedule.id);
}

/** Run now: starts a run at once, whatever the previous one is doing, leaving the next run time alone. */
export async function runNow(tx: Executor, after: AfterCommit, id: string, now = new Date()): Promise<ScheduleRun> {
  const schedule = await getScheduleRow(tx, id, true);
  if (!(await agentAvailable(tx, schedule.agentId))) throw conflict('The schedule\'s agent is disabled or missing');
  return startRun(tx, after, schedule, now, true);
}

/** Starts or skips every Schedule that is due at `now`. Each Schedule is handled in its own transaction. */
export async function runDueSchedules(ctx: AppContext, now: Date): Promise<void> {
  const due = await ctx.db
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)));
  for (const { id } of due) {
    try {
      await transact(ctx, async (tx, after) => {
        const [schedule] = await tx.select().from(schedules).where(eq(schedules.id, id)).for('update');
        if (!schedule?.enabled || !schedule.nextRunAt || schedule.nextRunAt > now) return;
        const dueAt = schedule.nextRunAt;
        const following = nextCronRun(schedule.cron, schedule.timeZone, dueAt);
        const period = following ? following.getTime() - dueAt.getTime() : Infinity;
        const nextRunAt = nextCronRun(schedule.cron, schedule.timeZone, now);
        await tx.update(schedules).set({ nextRunAt }).where(eq(schedules.id, id));
        const reason = !(await agentAvailable(tx, schedule.agentId))
          ? 'agent unavailable'
          : await hasActiveRun(tx, schedule.projectId)
            ? 'previous run still active'
            : now.getTime() - dueAt.getTime() >= period
              ? 'missed'
              : null;
        if (reason) await skipRun(tx, after, schedule, dueAt, reason);
        else await startRun(tx, after, schedule, dueAt, false);
      });
    } catch (err) {
      ctx.log.error({ err, scheduleId: id }, 'schedule run failed to start');
    }
  }
}

/**
 * The first Job of a run ended: the Task moves to `Succeeded` or `Failed`, which closes its Session and removes
 * its Worktree, and a failure tells the Schedule's creator. Does nothing for Tasks outside Schedule Projects.
 */
export async function settleRun(tx: Executor, after: AfterCommit, jobId: string): Promise<void> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return;
  const task = await getTaskRow(tx, job.taskId, { lock: true });
  const schedule = await scheduleOfProject(tx, task.projectId);
  if (!schedule) return;
  const [current] = await tx.select({ category: statuses.category }).from(statuses).where(eq(statuses.id, task.statusId));
  if (current?.category === 'closed') return;
  const [errored] = await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.jobId, jobId), eq(turns.isError, true))).limit(1);
  const failed = job.state !== 'finished' || job.cancelRequested || !!errored;
  await moveTask(tx, after, task.id, { statusId: await statusId(tx, task.projectId, failed ? 'Failed' : 'Succeeded') }, SYSTEM_ACTOR);
  emitScheduleChanged(after, schedule.id);
  if (failed && schedule.createdBy)
    await notifySchedule(tx, { eventId: `schedule-run-failed:${task.id}`, kind: 'schedule.run_failed', taskId: task.id, scheduleId: schedule.id, userId: schedule.createdBy });
}
