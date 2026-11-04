import { workerImageRepo } from './runtime';
import type { BuildResult, ContainerInfo, ContainerSpec, DockerCleanupInput, DockerCleanupReport, KnownWorker, ProfileSpec, WorkerRuntime } from './runtime';

interface FakeContainer {
  workerId: string;
  slot: number;
  spec: ContainerSpec;
  state: string;
  created: number;
}

export const containerKey = (workerId: string, slot: number) => `${workerId}:${slot}`;

/**
 * In-memory images and containers: builds succeed unless told otherwise, containers "run"
 * as soon as they're created. Used by the backend tests and with `AGENT_RUNTIME=fake`.
 */
export class FakeRuntime implements WorkerRuntime {
  /** The latest profile synchronized per (Worker, Agent), keyed `workerId:agentId`. */
  readonly profiles = new Map<string, ProfileSpec & { slot: number }>();
  /** Every synchronization, in order. */
  readonly profileSyncs: { workerId: string; slot: number; agentId: string; revision: number }[] = [];
  /** The next profile synchronizations fail with this message while it's set. */
  pluginFailure: string | null = null;
  /** Fails the synchronizations of some Agents only: returns the error, or null to succeed. */
  profileFailure: ((agentId: string) => string | null) | null = null;
  /** Holds profile synchronizations until it resolves. */
  profileHold: Promise<void> | null = null;
  /** Keyed by `containerKey(workerId, slot)`. */
  readonly containers = new Map<string, FakeContainer>();
  readonly builds: { workerId: string; buildId: string; dockerfile: string }[] = [];
  /** Workers whose resources were removed. */
  readonly removed: string[] = [];
  /** Next builds' outcomes, consumed in order; default success. */
  private readonly script: { fail?: string; user?: string; log?: string; hold?: Promise<void> }[] = [];
  /** Slots removed by a Cleanup, as `containerKey`s. */
  readonly removedSlots: string[] = [];
  /** Every `removeUnusedImages` call. */
  readonly imageRemovals: { workerId: string; keepTag: string }[] = [];
  oldBaseImageRemovals = 0;
  /** Every Docker part of a Cleanup, with the Workers it was given. */
  readonly cleanups: { anyBuilding: boolean; workers: KnownWorker[] }[] = [];
  /** What the next Docker parts of a Cleanup report; zeros by default. */
  cleanupReport: DockerCleanupReport | null = null;
  /** Holds the Docker part of Cleanups until it resolves. */
  cleanupHold: Promise<void> | null = null;
  baseImageBuilds = 0;
  private baseBuilt = false;
  /** Called with each new container, e.g. to hand its Runner token to a fake Runner. */
  onContainerCreated: ((workerId: string, slot: number, spec: ContainerSpec) => void) | null = null;

  constructor(public baseVersion = 'fake-1') {}

  /** Simulates a new pinned Claude Code version or Runner: the Base Image must be rebuilt. */
  upgrade(version: string): void {
    this.baseVersion = version;
    this.baseBuilt = false;
  }

  scriptBuild(outcome: { fail?: string; user?: string; log?: string; hold?: Promise<void> }): void {
    this.script.push(outcome);
  }

  container(workerId: string, slot: number): FakeContainer | undefined {
    return this.containers.get(containerKey(workerId, slot));
  }

  /** The slots of the Worker whose container runs. */
  runningSlots(workerId: string): number[] {
    return [...this.containers.values()].filter((c) => c.workerId === workerId && c.state === 'running').map((c) => c.slot).sort((a, b) => a - b);
  }

  /** Simulates a crash or `docker stop`. */
  setState(workerId: string, slot: number, state: string): void {
    const c = this.container(workerId, slot);
    if (c) c.state = state;
  }

  async ensureBaseImage(onLog: (chunk: string) => void): Promise<void> {
    if (this.baseBuilt) return;
    this.baseBuilt = true;
    this.baseImageBuilds++;
    onLog(`Built claude-task/agent-base:${this.baseVersion}\n`);
  }

  async buildWorkerImage(input: { workerId: string; buildId: string; dockerfile: string }, onLog: (chunk: string) => void): Promise<BuildResult> {
    this.builds.push(input);
    const next = this.script.shift() ?? {};
    onLog(next.log ?? `Step 1/1 : FROM claude-task/agent-base:${this.baseVersion}\n`);
    await next.hold;
    if (next.fail) throw new Error(next.fail);
    return { imageTag: `${workerImageRepo(input.workerId)}:${input.buildId.slice(0, 12)}`, user: next.user ?? 'agent' };
  }

  async createContainer(workerId: string, slot: number, spec: ContainerSpec): Promise<void> {
    this.containers.set(containerKey(workerId, slot), { workerId, slot, spec, state: 'running', created: Date.now() });
    this.onContainerCreated?.(workerId, slot, spec);
  }

  async restartContainer(workerId: string, slot: number): Promise<void> {
    const c = this.container(workerId, slot);
    if (c) c.state = 'running';
  }

  async stopContainer(workerId: string, slot: number): Promise<void> {
    this.setState(workerId, slot, 'exited');
  }

  async removeContainer(workerId: string, slot: number): Promise<void> {
    this.containers.delete(containerKey(workerId, slot));
  }

  async removeWorker(workerId: string): Promise<void> {
    for (const [key, c] of this.containers) if (c.workerId === workerId) this.containers.delete(key);
    this.removed.push(workerId);
  }

  async removeSlot(workerId: string, slot: number): Promise<void> {
    this.containers.delete(containerKey(workerId, slot));
    this.removedSlots.push(containerKey(workerId, slot));
  }

  async removeUnusedImages(workerId: string, keepTag: string): Promise<number> {
    this.imageRemovals.push({ workerId, keepTag });
    return 0;
  }

  async removeOldBaseImages(): Promise<number> {
    this.oldBaseImageRemovals++;
    return 0;
  }

  async cleanup(input: DockerCleanupInput): Promise<DockerCleanupReport> {
    await this.cleanupHold;
    this.cleanups.push({ anyBuilding: input.anyBuilding, workers: await input.workers() });
    return (
      this.cleanupReport ?? {
        removed: { baseImages: 0, workerImages: 0, danglingImages: 0, orphanContainers: 0, orphanVolumes: 0, orphanImages: 0 },
        reclaimedBytes: 0,
        errors: [],
      }
    );
  }

  async inspect(workerId: string, slot: number): Promise<ContainerInfo> {
    const c = this.container(workerId, slot);
    return c ? { state: c.state, image: c.spec.image } : { state: 'missing', image: null };
  }

  async logs(workerId: string, slot: number, tail: number): Promise<string> {
    return this.container(workerId, slot) ? `runner started (fake container, last ${tail} lines)\n` : '';
  }

  async configureProfile(workerId: string, slot: number, profile: ProfileSpec): Promise<void> {
    await this.profileHold;
    if (this.pluginFailure) throw new Error(this.pluginFailure);
    const failure = this.profileFailure?.(profile.agentId);
    if (failure) throw new Error(failure);
    this.profiles.set(`${workerId}:${profile.agentId}`, { ...profile, slot });
    this.profileSyncs.push({ workerId, slot, agentId: profile.agentId, revision: profile.revision });
  }
}
