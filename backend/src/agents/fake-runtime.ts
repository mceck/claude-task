import { agentImageRepo } from './runtime';
import type { AgentRuntime, BuildResult, ContainerInfo, ContainerSpec } from './runtime';

interface FakeContainer {
  spec: ContainerSpec;
  state: string;
  created: number;
}

/**
 * In-memory images and containers: builds succeed unless told otherwise, containers "run"
 * as soon as they're created. Used by the backend tests and with `AGENT_RUNTIME=fake`.
 */
export class FakeRuntime implements AgentRuntime {
  readonly configuredSkills = new Map<string, { revision: number; skills: import('@claude-task/shared').InstalledSkill[] }>();
  async configureSkills(agentId: string, revision: number, skills: import('@claude-task/shared').InstalledSkill[]): Promise<void> {
    this.configuredSkills.set(agentId, { revision, skills });
  }
  readonly configuredPlugins = new Map<string, import('@claude-task/shared').InstalledPlugin[]>();
  /** The next plugin synchronizations fail with this message while it's set. */
  pluginFailure: string | null = null;
  async configurePlugins(agentId: string, plugins: import('@claude-task/shared').InstalledPlugin[]): Promise<void> {
    if (this.pluginFailure) throw new Error(this.pluginFailure);
    this.configuredPlugins.set(agentId, plugins);
  }
  readonly containers = new Map<string, FakeContainer>();
  readonly removed: string[] = [];
  /** Next builds' outcomes, consumed in order; default success. */
  private readonly script: { fail?: string; user?: string; log?: string; hold?: Promise<void> }[] = [];
  baseImageBuilds = 0;
  private baseBuilt = false;
  /** Called with each new container, e.g. to hand its Runner token to a fake Runner. */
  onContainerCreated: ((agentId: string, spec: ContainerSpec) => void) | null = null;

  constructor(public baseVersion = 'fake-1') {}

  /** Simulates a new pinned Claude Code version or Runner: the Base Image must be rebuilt. */
  upgrade(version: string): void {
    this.baseVersion = version;
    this.baseBuilt = false;
  }

  scriptBuild(outcome: { fail?: string; user?: string; log?: string; hold?: Promise<void> }): void {
    this.script.push(outcome);
  }

  /** Simulates a crash or `docker stop`. */
  setState(agentId: string, state: string): void {
    const c = this.containers.get(agentId);
    if (c) c.state = state;
  }

  async ensureBaseImage(onLog: (chunk: string) => void): Promise<void> {
    if (this.baseBuilt) return;
    this.baseBuilt = true;
    this.baseImageBuilds++;
    onLog(`Built claude-task/agent-base:${this.baseVersion}\n`);
  }

  async buildAgentImage(input: { agentId: string; buildId: string; dockerfile: string }, onLog: (chunk: string) => void): Promise<BuildResult> {
    const next = this.script.shift() ?? {};
    onLog(next.log ?? `Step 1/1 : FROM claude-task/agent-base:${this.baseVersion}\n`);
    await next.hold;
    if (next.fail) throw new Error(next.fail);
    return { imageTag: `${agentImageRepo(input.agentId)}:${input.buildId.slice(0, 12)}`, user: next.user ?? 'agent' };
  }

  async createContainer(agentId: string, spec: ContainerSpec): Promise<void> {
    this.containers.set(agentId, { spec, state: 'running', created: Date.now() });
    this.onContainerCreated?.(agentId, spec);
  }

  async restartContainer(agentId: string): Promise<void> {
    const c = this.containers.get(agentId);
    if (c) c.state = 'running';
  }

  async removeAgent(agentId: string): Promise<void> {
    this.containers.delete(agentId);
    this.removed.push(agentId);
  }

  async inspect(agentId: string): Promise<ContainerInfo> {
    const c = this.containers.get(agentId);
    return c ? { state: c.state, image: c.spec.image } : { state: 'missing', image: null };
  }

  async logs(agentId: string, tail: number): Promise<string> {
    return this.containers.has(agentId) ? `runner started (fake container, last ${tail} lines)\n` : '';
  }
}
