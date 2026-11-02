// The only module that talks to Docker (docs/specs/workers.md, "WorkerRuntime"). Everything else asks it for
// images and containers and stores what it observed.
import type { InstalledPlugin, InstalledSkill } from '@claude-task/shared';

export interface ContainerSpec {
  image: string;
  /** Only what the Runner needs to connect; Credentials and Project env travel per Job. */
  env: Record<string, string>;
  cpuLimit: number | null;
  memoryMb: number | null;
}

export interface ContainerInfo {
  /** Docker's state (`running`, `exited`, `restarting`, …) or `missing`. */
  state: string;
  image: string | null;
}

export interface BuildResult {
  imageTag: string;
  /** The image's final `USER`. */
  user: string;
}

/** What one Agent Profile should hold. */
export interface ProfileSpec {
  agentId: string;
  revision: number;
  skills: InstalledSkill[];
  plugins: InstalledPlugin[];
}

export interface WorkerRuntime {
  /** Base Image version: changes with the pinned Claude Code version and the Runner. */
  readonly baseVersion: string;
  /** Builds `claude-task/agent-base:<baseVersion>` if it's missing. */
  ensureBaseImage(onLog: (chunk: string) => void): Promise<void>;
  buildWorkerImage(input: { workerId: string; buildId: string; dockerfile: string }, onLog: (chunk: string) => void): Promise<BuildResult>;
  /** Creates the slot's container, replacing an existing one. The Worker Volume and the slot's Service Volume are kept. */
  createContainer(workerId: string, slot: number, spec: ContainerSpec): Promise<void>;
  restartContainer(workerId: string, slot: number): Promise<void>;
  /** Stops processes while preserving the container, images and volumes. */
  stopContainer(workerId: string, slot: number): Promise<void>;
  /** Removes one slot's container (its Service Volume stays). */
  removeContainer(workerId: string, slot: number): Promise<void>;
  /** Every container, image and volume of the Worker. */
  removeWorker(workerId: string): Promise<void>;
  inspect(workerId: string, slot: number): Promise<ContainerInfo>;
  logs(workerId: string, slot: number, tail: number): Promise<string>;
  /**
   * Brings one Agent Profile in the Worker Volume in line with the spec, from inside the slot's
   * running container: shared session data links, Skills, and Plugins installed with `claude plugin`.
   */
  configureProfile(workerId: string, slot: number, profile: ProfileSpec): Promise<void>;
}

export const containerName = (workerId: string, slot: number) => `claude-task-worker-${workerId}-${slot}`;
export const volumeName = (workerId: string) => `claude-task-worker-${workerId}`;
export const serviceVolumeName = (workerId: string, slot: number) => `claude-task-worker-${workerId}-services-${slot}`;
export const workerImageRepo = (workerId: string) => `claude-task/worker-${workerId}`;
/** Where each slot's Development Services keep their data, outside the shared home. */
export const SERVICE_DATA_DIR = '/var/lib/claude-task/services';
