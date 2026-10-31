import { z } from 'zod';
import { repositoryBody } from './api';
import { isTimeZone, parseCron } from './cron';
import type { ProjectRepository } from './git';

export const SCHEDULE_STATUSES = [
  { name: 'Running', color: '#3b82f6', category: 'open' },
  { name: 'Succeeded', color: '#22c55e', category: 'closed' },
  { name: 'Failed', color: '#ef4444', category: 'closed' },
] as const;

export type ScheduleRunState = 'running' | 'succeeded' | 'failed' | 'skipped';

export interface Schedule {
  id: string;
  /** The Schedule Project whose Tasks are the Scheduled Runs. */
  projectId: string;
  name: string;
  agentId: string | null;
  cron: string;
  timeZone: string;
  prompt: string;
  /** Null for a global Schedule. */
  repository: ProjectRepository | null;
  readOnly: boolean;
  enabled: boolean;
  nextRunAt: string | null;
  consecutiveSkips: number;
  createdBy: { id: string; displayName: string } | null;
  lastRun: ScheduleRun | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  state: ScheduleRunState;
  manual: boolean;
  /** The time the run was due (the moment of the request for a manual run). */
  dueAt: string;
  /** Null for a skipped run. */
  taskId: string | null;
  taskKey: string | null;
  skipReason: string | null;
  startedAt: string;
  /** Set once the run is closed. */
  finishedAt: string | null;
}

const cron = z.string().trim().min(1).max(100).refine((v) => parseCron(v) !== null, 'Not a valid cron expression');
const timeZone = z.string().trim().min(1).max(100).refine(isTimeZone, 'Not a valid IANA time zone');

export const createScheduleBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  agentId: z.uuid(),
  cron,
  timeZone: timeZone.default('UTC'),
  prompt: z.string().trim().min(1).max(50_000),
  repository: repositoryBody.nullable().default(null),
  readOnly: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type CreateScheduleBody = z.input<typeof createScheduleBody>;

export const updateScheduleBody = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  agentId: z.uuid().optional(),
  cron: cron.optional(),
  timeZone: timeZone.optional(),
  prompt: z.string().trim().min(1).max(50_000).optional(),
  repository: repositoryBody.nullable().optional(),
  readOnly: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateScheduleBody = z.input<typeof updateScheduleBody>;
