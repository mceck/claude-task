// The only module that talks to Docker (Spec 02, "AgentRuntime"). Everything else asks it for
// images and containers and stores what it observed.

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

export interface AgentRuntime {
  /** Synchronizes platform-managed ~/.claude/skills entries; preserves all other home files. */
  configureSkills(agentId: string, revision: number, skills: import('@claude-task/shared').InstalledSkill[]): Promise<void>;
  /** Base Image version: changes with the pinned Claude Code version and the Runner. */
  readonly baseVersion: string;
  /** Builds `claude-task/agent-base:<baseVersion>` if it's missing. */
  ensureBaseImage(onLog: (chunk: string) => void): Promise<void>;
  buildAgentImage(input: { agentId: string; buildId: string; dockerfile: string }, onLog: (chunk: string) => void): Promise<BuildResult>;
  /** Creates the container, replacing an existing one. The Agent Volume is kept. */
  createContainer(agentId: string, spec: ContainerSpec): Promise<void>;
  restartContainer(agentId: string): Promise<void>;
  /** Container, images and volume. */
  removeAgent(agentId: string): Promise<void>;
  inspect(agentId: string): Promise<ContainerInfo>;
  logs(agentId: string, tail: number): Promise<string>;
}

export const containerName = (agentId: string) => `claude-task-agent-${agentId}`;
export const volumeName = (agentId: string) => `claude-task-agent-${agentId}`;
export const agentImageRepo = (agentId: string) => `claude-task/agent-${agentId}`;
