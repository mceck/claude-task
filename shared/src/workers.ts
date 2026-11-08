// Workers, their Worker Containers and Builds (docs/specs/workers.md). Terms follow docs/CONTEXT.md.
import type { HostRef } from './hosts';
import { z } from 'zod';
import { AGENT_SERVICES, DEFAULT_AGENT_SERVICES } from './agents';
import type { AgentRef, AgentService, BuildStatus, ImageState, TaskRef } from './agents';

/** The highest cap a Worker can have. */
export const WORKER_CAP_MAX = 20;

/** The Claude Code version the Base Image installs, and the one a new Worker starts with. */
export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.310';

/** What the Workers list shows, derived from configuration, image, containers and Jobs. */
export type WorkerState = 'disabled' | 'building' | 'build_failed' | 'offline' | 'host_offline' | 'idle' | 'working';

/** One Worker Slot, as the Worker page shows it. */
export type WorkerContainerState = 'stopped' | 'starting' | 'idle' | 'working';

export interface WorkerRef {
  id: string;
  name: string;
}

export interface WorkerContainer {
  slot: number;
  state: WorkerContainerState;
  /** Last observed Docker state (`running`, `exited`, `missing`, …). */
  containerState: string;
  runnerConnected: boolean;
  /** The container runs an older image or limits and is recreated once it is free. */
  recreatePending: boolean;
  /** The Job it runs right now. */
  job: { id: string; task: TaskRef; agent: AgentRef | null } | null;
  runnerVersion: string | null;
  claudeVersion: string | null;
  lastActivityAt: string | null;
}

/** An Agent Profile that failed to synchronize on this Worker. */
export interface AgentProfileError {
  agentId: string;
  agentName: string;
  error: string;
}

export interface Worker extends WorkerRef {
  host: HostRef;
  description: string;
  dockerfile: string;
  /** The Claude Code version the Worker's Base Image installs. */
  claudeCodeVersion: string;
  services: AgentService[];
  /** Per Worker Container. */
  cpuLimit: number | null;
  memoryMb: number | null;
  /** Slots 1 to `minimum` are always on. */
  minimum: number;
  /** The most Worker Containers that run at once. */
  cap: number;
  enabled: boolean;
  imageState: ImageState;
  state: WorkerState;
  /** Every slot that has a container, plus slots up to the cap. */
  containers: WorkerContainer[];
  /** Worker Containers running a Job. */
  busy: number;
  /** Worker Containers running. */
  running: number;
  queueLength: number;
  projects: { id: string; key: string; name: string; kind: string }[];
  profileErrors: AgentProfileError[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkerBuild {
  id: string;
  workerId: string;
  status: BuildStatus;
  baseVersion: string;
  log: string;
  startedAt: string;
  finishedAt: string | null;
}

const name = z.string().trim().min(1).max(100);

/** A version mise can install and Docker can use in a tag. */
const claudeCodeVersion = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]*$/, 'Use a Claude Code version mise can install, like 2.1.310');

const workerFields = {
  name,
  description: z.string().max(2000),
  dockerfile: z.string().min(1).max(100_000),
  claudeCodeVersion,
  services: z.array(z.enum(AGENT_SERVICES)).max(AGENT_SERVICES.length)
    .refine((v) => new Set(v).size === v.length, 'Duplicate service')
    .transform((v) => AGENT_SERVICES.filter((service) => v.includes(service))),
  /** CPUs per Worker Container, e.g. 2 or 0.5. */
  cpuLimit: z.number().positive().max(256).nullable(),
  memoryMb: z.int().min(256).max(1_048_576).nullable(),
  minimum: z.int().min(0).max(WORKER_CAP_MAX),
  cap: z.int().min(1).max(WORKER_CAP_MAX),
  enabled: z.boolean(),
};

const minimumWithinCap = (b: { minimum?: number; cap?: number }) => b.minimum === undefined || b.cap === undefined || b.minimum <= b.cap;

export const createWorkerBody = z
  .strictObject({
    ...workerFields,
    description: workerFields.description.default(''),
    claudeCodeVersion: workerFields.claudeCodeVersion.default(DEFAULT_CLAUDE_CODE_VERSION),
    services: workerFields.services.default(DEFAULT_AGENT_SERVICES),
    cpuLimit: workerFields.cpuLimit.default(null),
    memoryMb: workerFields.memoryMb.default(null),
    minimum: workerFields.minimum.default(0),
    cap: workerFields.cap.default(1),
    enabled: workerFields.enabled.default(true),
  })
  .refine(minimumWithinCap, { message: 'The minimum cannot exceed the cap', path: ['minimum'] });
export type CreateWorkerBody = z.input<typeof createWorkerBody>;

export const updateWorkerBody = z.strictObject({
  name: workerFields.name.optional(),
  description: workerFields.description.optional(),
  dockerfile: workerFields.dockerfile.optional(),
  claudeCodeVersion: workerFields.claudeCodeVersion.optional(),
  services: workerFields.services.optional(),
  cpuLimit: workerFields.cpuLimit.optional(),
  memoryMb: workerFields.memoryMb.optional(),
  minimum: workerFields.minimum.optional(),
  cap: workerFields.cap.optional(),
  enabled: workerFields.enabled.optional(),
});
export type UpdateWorkerBody = z.infer<typeof updateWorkerBody>;

export const duplicateWorkerBody = z.strictObject({ name: name.optional() });

/** What one Cleanup removed, per kind (docs/specs/workers.md, "Cleanup"). */
export interface CleanupCounts {
  baseImages: number;
  workerImages: number;
  danglingImages: number;
  orphanContainers: number;
  orphanVolumes: number;
  orphanImages: number;
  slots: number;
  /** Projects whose Bare Clone or Worktrees left a Worker Volume. */
  projects: number;
  agentProfiles: number;
}

export const EMPTY_CLEANUP_COUNTS: CleanupCounts = {
  baseImages: 0,
  workerImages: 0,
  danglingImages: 0,
  orphanContainers: 0,
  orphanVolumes: 0,
  orphanImages: 0,
  slots: 0,
  projects: 0,
  agentProfiles: 0,
};

export type CleanupTrigger = 'automatic' | 'manual';

/** One run of the Cleanup, automatic or asked by an Admin. */
export interface Cleanup {
  id: string;
  trigger: CleanupTrigger;
  requestedBy: { id: string; name: string } | null;
  startedAt: string;
  /** Null while the Docker part and the slots are still being cleaned. */
  finishedAt: string | null;
  removed: CleanupCounts;
  /** Approximate: Docker's reclaimed space plus the Runners' measured file sizes. */
  reclaimedBytes: number;
  /** Worker Volumes whose Runner has not answered yet. */
  volumesPending: number;
  hostsPending: number;
  errors: string[];
}
