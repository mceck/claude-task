// Agents, Credentials, Sessions, Jobs and the Agent's Timeline items (docs/specs/agents.md, docs/specs/agent-sessions.md). Terms follow docs/CONTEXT.md.

export const PERMISSION_MODES = ['bypassPermissions', 'auto', 'acceptEdits', 'dontAsk'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const AGENT_SERVICES = ['postgres', 'redis', 'mysql', 'mailpit', 'rustfs'] as const;
export type AgentService = (typeof AGENT_SERVICES)[number];
export const DEFAULT_AGENT_SERVICES: AgentService[] = ['postgres', 'redis'];

export const AGENT_SERVICE_INFO: Record<AgentService, { name: string; description: string }> = {
  postgres: { name: 'PostgreSQL', description: '127.0.0.1:5432 · database/user: agent · no password' },
  redis: { name: 'Redis', description: '127.0.0.1:6379 · no password' },
  mysql: { name: 'MySQL', description: '127.0.0.1:3306 · database/user: agent · no password' },
  mailpit: { name: 'Mailpit', description: 'SMTP: 127.0.0.1:1025 · web/API: 127.0.0.1:8025' },
  rustfs: { name: 'RustFS', description: 'S3: 127.0.0.1:9000 · console: 127.0.0.1:9001 · rustfsadmin / rustfsadmin' },
};

export const CREDENTIAL_KINDS = ['claude_oauth_token', 'anthropic_api_key'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** The secret itself is write-only: only its last 4 characters come back. */
export interface Credential {
  id: string;
  name: string;
  kind: CredentialKind;
  last4: string;
  usedBy: { id: string; name: string }[];
  /** Latest rate-limit status seen on any Agent using it. */
  rateLimit: RateLimitObservation | null;
  createdAt: string;
  updatedAt: string;
}

export interface RateLimitObservation {
  agentId: string;
  /** The `rate_limit_info` of the stream's `rate_limit_event`. */
  info: Record<string, unknown>;
  observedAt: string;
}

export const IMAGE_STATES = ['none', 'building', 'built', 'failed'] as const;
export type ImageState = (typeof IMAGE_STATES)[number];

export const BUILD_STATUSES = ['building', 'succeeded', 'failed'] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

/** What the Agents list shows, derived from configuration, image, container, Runner and Jobs. */
export type AgentState = 'disabled' | 'building' | 'build_failed' | 'offline' | 'idle' | 'working';

/** Enough of an Agent to show it next to a Task or a Comment. */
export interface AgentRef {
  id: string;
  name: string;
  avatarEmoji: string;
  avatarColor: string;
  /** Uploaded image shown instead of the emoji; the URL changes whenever the image does. */
  avatarImageUrl: string | null;
}

export interface Agent extends AgentRef {
  services: AgentService[];
  skillIds: string[];
  mcpServerIds: string[];
  pluginIds: string[];
  skillCommands: import('./extensions').SkillCommand[];
  extensionsPending: boolean;
  extensionsError: string | null;
  description: string;
  dockerfile: string;
  credentialId: string;
  credentialName: string;
  model: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  systemPrompt: string;
  cpuLimit: number | null;
  memoryMb: number | null;
  enabled: boolean;
  imageState: ImageState;
  /** Last observed container state (`running`, `exited`, `missing`, …). */
  containerState: string;
  runnerConnected: boolean;
  /** A newer image is built but the container still runs the old one (waiting for the Agent to be idle). */
  recreatePending: boolean;
  state: AgentState;
  currentTask: TaskRef | null;
  queueLength: number;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRef {
  id: string;
  key: string;
  title: string;
  projectId: string;
}

export interface AgentBuild {
  id: string;
  agentId: string;
  status: BuildStatus;
  baseVersion: string;
  log: string;
  startedAt: string;
  finishedAt: string | null;
}

export const SESSION_STATES = ['pending', 'idle', 'running', 'paused', 'closed'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const QUEUE_ENTRY_KINDS = ['start', 'messages', 'resume_interrupted'] as const;
export type QueueEntryKind = (typeof QUEUE_ENTRY_KINDS)[number];

export const JOB_STATES = ['dispatched', 'running', 'finishing', 'finished', 'failed', 'interrupted'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** The current Session of a Task, as the Task view and its card show it. */
export interface TaskSession {
  commands?: import('./commands').ChatCommand[];
  id: string;
  agent: AgentRef;
  state: SessionState;
  /** 1-based position in the Agent's Queue, when the Task has a Queue Entry. */
  queuePosition: number | null;
  /** The Queue Entry waits for a Retry after a failed Job. */
  held: boolean;
  /** Edits by Users the Agent hasn't read yet (title, description, priority, tags). */
  unseenChanges: boolean;
  /** Version of the latest failed Job, so the UI can offer Retry. */
  lastJob: { id: string; state: JobState; failureStage: string | null; error: string | null } | null;
}

export interface QueueEntry {
  id: string;
  agentId: string;
  task: TaskRef;
  kind: QueueEntryKind;
  position: string;
  held: boolean;
  pendingMessages: number;
  enqueuedAt: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface Job {
  id: string;
  sessionId: string;
  agentId: string;
  task: TaskRef;
  kind: QueueEntryKind;
  state: JobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  failureStage: string | null;
  error: string | null;
  turns: number;
  usage: Usage;
}

export interface JobDetail extends Job {
  setupOutput: string;
  stderr: string;
  claudeVersion: string | null;
}

export interface UsageRow extends Usage {
  /** A day (`YYYY-MM-DD`) or a Task key. */
  key: string;
  turns: number;
}

export interface AgentUsage {
  total: Usage & { turns: number };
  byDay: UsageRow[];
  byTask: (UsageRow & { taskId: string })[];
}

// Delivery of User Comments to the Agent

export const DELIVERY_STATES = ['none', 'queued', 'delivered', 'not_delivered'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export interface Delivery {
  state: Exclude<DeliveryState, 'none'>;
  reason: string | null;
  jobId: string | null;
}

// Agent Timeline items (projected from the stream)

export interface ActivityEntry {
  toolUseId: string;
  name: string;
  /** One line, e.g. "Edited `src/auth.ts`". */
  summary: string;
  /** `interrupted`: it never got a result (a Stop, the Turn or the process ended first). */
  status: 'pending' | 'ok' | 'error' | 'interrupted';
  /** Short outcome, e.g. "exit 1". */
  outcome: string | null;
  input: unknown;
  /** Truncated to 20 KB for display; the full output stays in the raw stream. */
  output: string | null;
  /** Subagent tool calls started by this one. */
  children: ActivityEntry[];
}

export interface TurnSummary {
  durationMs: number;
  toolCalls: number;
  costUsd: number | null;
  /** The `result` subtype, e.g. `success`, `error_max_turns`. */
  subtype: string;
  isError: boolean;
  usage: Usage | null;
}

export type AgentItemPayload =
  | { kind: 'thinking'; text: string }
  | { kind: 'activity'; entries: ActivityEntry[] }
  | { kind: 'turn_summary'; summary: TurnSummary }
  | { kind: 'notice'; text: string };
export type AgentItemKind = AgentItemPayload['kind'];

/** Live, unpersisted output of the running Turn. */
export type LiveDelta = { kind: 'text' | 'thinking'; commentId: string | null; text: string };

// Project settings for Agents

export interface ProjectEnvVar {
  id: string;
  name: string;
  secret: boolean;
  /** Null for secrets: they are write-only. */
  value: string | null;
  last4: string | null;
}

export interface ProjectAgentSettings {
  setupScript: string;
  agentInstructions: string;
  env: ProjectEnvVar[];
}
