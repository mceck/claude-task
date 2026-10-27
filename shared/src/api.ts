// Request payloads, validated server-side and typed client-side.
import { z } from 'zod';
import { AGENT_SERVICES, DEFAULT_AGENT_SERVICES, CREDENTIAL_KINDS, EFFORT_LEVELS, PERMISSION_MODES } from './agents';
import { CATEGORIES, PRIORITIES, ROLES } from './domain';
import type { Tag, Project, Status, Task, User } from './domain';

export const API_PREFIX = '/api/v1';
/** Every mutating request must carry this header (CSRF defense). */
export const CSRF_HEADER = 'x-claude-task';

const id = z.uuid();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex color like #aabbcc');
const name = z.string().trim().min(1).max(100);
const password = z.string().min(8).max(200);

// Auth

export const loginBody = z.strictObject({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof loginBody>;

export const changePasswordBody = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: password,
});
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;

// Users

export const createUserBody = z.strictObject({
  email: z.email().max(320),
  displayName: name,
  role: z.enum(ROLES).default('member'),
  /** Generated when omitted. Returned once in the response. */
  temporaryPassword: password.optional(),
});
export type CreateUserBody = z.input<typeof createUserBody>;

export const updateUserBody = z.strictObject({
  displayName: name.optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
});
export type UpdateUserBody = z.infer<typeof updateUserBody>;

export interface UserWithTemporaryPassword {
  user: User;
  temporaryPassword: string;
}

// Projects

export const PROJECT_KEY_PATTERN = /^[A-Z]{2,6}$/;

export const createProjectBody = z.strictObject({
  key: z.string().regex(PROJECT_KEY_PATTERN, 'must be 2–6 uppercase letters'),
  name,
  description: z.string().max(10_000).default(''),
});
export type CreateProjectBody = z.input<typeof createProjectBody>;

/** The key is immutable, so it's not accepted here. */
export const updateProjectBody = z.strictObject({
  name: name.optional(),
  description: z.string().max(10_000).optional(),
});
export type UpdateProjectBody = z.infer<typeof updateProjectBody>;

export const listProjectsQuery = z.object({
  archived: z.enum(['true', 'false']).default('false'),
});

// Statuses

export const createStatusBody = z.strictObject({
  name,
  color,
  category: z.enum(CATEGORIES),
});
export type CreateStatusBody = z.infer<typeof createStatusBody>;

export const updateStatusBody = z.strictObject({
  name: name.optional(),
  color: color.optional(),
  category: z.enum(CATEGORIES).optional(),
});
export type UpdateStatusBody = z.infer<typeof updateStatusBody>;

export const reorderStatusesBody = z.strictObject({
  statusIds: z.array(id).min(1),
});
export type ReorderStatusesBody = z.infer<typeof reorderStatusesBody>;

export const deleteStatusQuery = z.object({
  targetStatusId: id,
});

// Tags

export const createTagBody = z.strictObject({ name, color });
export type CreateTagBody = z.infer<typeof createTagBody>;

export const updateTagBody = z.strictObject({
  name: name.optional(),
  color: color.optional(),
});
export type UpdateTagBody = z.infer<typeof updateTagBody>;

// Tasks

const title = z.string().trim().min(1).max(500);
const description = z.string().max(100_000);

export const createTaskBody = z.strictObject({
  title,
  /** Defaults to the first `open` Status. */
  statusId: id.optional(),
  description: description.default(''),
  priority: z.enum(PRIORITIES).default('none'),
  tagIds: z.array(id).max(50).default([]),
  assigneeIds: z.array(id).max(50).default([]),
});
export type CreateTaskBody = z.input<typeof createTaskBody>;

export const updateTaskBody = z.strictObject({
  /** The Task version the client last saw. */
  version: z.int().min(1),
  title: title.optional(),
  description: description.optional(),
  statusId: id.optional(),
  priority: z.enum(PRIORITIES).optional(),
  tagIds: z.array(id).max(50).optional(),
  assigneeIds: z.array(id).max(50).optional(),
  /** Assign an Agent (at most one), or null to unassign. */
  agentId: id.nullable().optional(),
});
export type UpdateTaskBody = z.infer<typeof updateTaskBody>;

/**
 * Place the Task in `statusId` right below `afterTaskId` (or right above `beforeTaskId`).
 * `afterTaskId: null` alone puts it at the top; no neighbor at all puts it at the end.
 */
export const moveTaskBody = z.strictObject({
  statusId: id,
  afterTaskId: id.nullable().optional(),
  beforeTaskId: id.nullable().optional(),
});
export type MoveTaskBody = z.infer<typeof moveTaskBody>;

const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).filter(Boolean)))
    .pipe(z.array(item));

export const listTasksQuery = z.object({
  /** User ids, or `none` for unassigned Tasks. */
  assignee: csv(z.union([id, z.literal('none')])),
  tag: csv(id),
  priority: csv(z.enum(PRIORITIES)),
  q: z.string().max(200).optional(),
  includeClosed: z.enum(['true', 'false']).default('false'),
});

export interface ConflictResponse {
  error: ApiErrorBody['error'];
  task: Task;
}

// Comments

export const createCommentBody = z.strictObject({
  body: z.string().max(100_000),
  internal: z.boolean().default(false),
});
export type CreateCommentBody = z.input<typeof createCommentBody>;

export const updateCommentBody = z.strictObject({
  body: z.string().trim().min(1).max(100_000),
});
export type UpdateCommentBody = z.infer<typeof updateCommentBody>;

export const timelineQuery = z.object({
  before: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Credentials (admin)

const secret = z.string().trim().min(8, 'looks too short').max(10_000);

export const createCredentialBody = z.strictObject({
  name,
  kind: z.enum(CREDENTIAL_KINDS),
  secret,
});
export type CreateCredentialBody = z.infer<typeof createCredentialBody>;

/** Rotating the secret keeps the Credential (and every Agent using it). */
export const updateCredentialBody = z.strictObject({
  name: name.optional(),
  secret: secret.optional(),
});
export type UpdateCredentialBody = z.infer<typeof updateCredentialBody>;

// Agents (admin, except reads and queue management)

const agentFields = {
  services: z.array(z.enum(AGENT_SERVICES)).max(AGENT_SERVICES.length)
    .refine((v) => new Set(v).size === v.length, 'Duplicate service')
    .transform((v) => AGENT_SERVICES.filter((service) => v.includes(service))),
  skillIds: z.array(id).max(100).refine((v) => new Set(v).size === v.length, 'Duplicate skill'),
  mcpServerIds: z.array(id).max(100).refine((v) => new Set(v).size === v.length, 'Duplicate MCP server'),
  pluginIds: z.array(id).max(100).refine((v) => new Set(v).size === v.length, 'Duplicate plugin'),
  name,
  avatarEmoji: z.string().trim().min(1).max(16),
  avatarColor: color,
  description: z.string().max(2000),
  dockerfile: z.string().min(1).max(100_000),
  credentialId: id,
  model: z.string().trim().min(1).max(100).nullable(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  permissionMode: z.enum(PERMISSION_MODES),
  systemPrompt: z.string().max(50_000),
  /** CPUs, e.g. 2 or 0.5. */
  cpuLimit: z.number().positive().max(256).nullable(),
  memoryMb: z.int().min(256).max(1_048_576).nullable(),
  enabled: z.boolean(),
};

export const createAgentBody = z.strictObject({
  ...agentFields,
  services: agentFields.services.default(DEFAULT_AGENT_SERVICES),
  skillIds: agentFields.skillIds.default([]),
  mcpServerIds: agentFields.mcpServerIds.default([]),
  pluginIds: agentFields.pluginIds.default([]),
  avatarEmoji: agentFields.avatarEmoji.default('🤖'),
  avatarColor: agentFields.avatarColor.default('#6366f1'),
  description: agentFields.description.default(''),
  model: agentFields.model.default(null),
  effort: agentFields.effort.default(null),
  permissionMode: agentFields.permissionMode.default('bypassPermissions'),
  systemPrompt: agentFields.systemPrompt.default(''),
  cpuLimit: agentFields.cpuLimit.default(null),
  memoryMb: agentFields.memoryMb.default(null),
  enabled: agentFields.enabled.default(true),
});
export type CreateAgentBody = z.input<typeof createAgentBody>;

export const updateAgentBody = z.strictObject({
  services: agentFields.services.optional(),
  skillIds: agentFields.skillIds.optional(),
  mcpServerIds: agentFields.mcpServerIds.optional(),
  pluginIds: agentFields.pluginIds.optional(),
  name: agentFields.name.optional(),
  avatarEmoji: agentFields.avatarEmoji.optional(),
  avatarColor: agentFields.avatarColor.optional(),
  description: agentFields.description.optional(),
  dockerfile: agentFields.dockerfile.optional(),
  credentialId: agentFields.credentialId.optional(),
  model: agentFields.model.optional(),
  effort: agentFields.effort.optional(),
  permissionMode: agentFields.permissionMode.optional(),
  systemPrompt: agentFields.systemPrompt.optional(),
  cpuLimit: agentFields.cpuLimit.optional(),
  memoryMb: agentFields.memoryMb.optional(),
  enabled: agentFields.enabled.optional(),
});
export type UpdateAgentBody = z.infer<typeof updateAgentBody>;

/** Images the browser can render; SVG can carry scripts. */
export const AGENT_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const AGENT_AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export const PROJECT_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const PROJECT_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const duplicateAgentBody = z.strictObject({ name: name.optional() });

/** Recreate the container now even if the Agent is working (kills the running Job). */
export const recreateAgentBody = z.strictObject({ force: z.boolean().default(false) });

/** Same convention as moving Tasks: below `afterEntryId` or above `beforeEntryId`. */
export const moveQueueEntryBody = z.strictObject({
  afterEntryId: id.nullable().optional(),
  beforeEntryId: id.nullable().optional(),
});
export type MoveQueueEntryBody = z.infer<typeof moveQueueEntryBody>;

// Project settings for Agents

export const updateAgentSettingsBody = z.strictObject({
  setupScript: z.string().max(100_000).optional(),
  agentInstructions: z.string().max(100_000).optional(),
});
export type UpdateAgentSettingsBody = z.infer<typeof updateAgentSettingsBody>;

export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const putEnvVarBody = z.strictObject({
  name: z.string().regex(ENV_VAR_NAME, 'must be a valid environment variable name'),
  value: z.string().max(100_000),
  secret: z.boolean().default(false),
});
export type PutEnvVarBody = z.input<typeof putEnvVarBody>;

/** A `.env` file whose variables are merged into the Project's: same names are overwritten, others kept. */
export const importEnvBody = z.strictObject({
  content: z.string().max(500_000),
  secret: z.boolean().default(false),
});
export type ImportEnvBody = z.input<typeof importEnvBody>;

// Errors

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// Responses that bundle several entities

export interface MeResponse {
  user: User;
}

export interface ProjectBundle {
  project: Project;
  statuses: Status[];
  tags: Tag[];
}

// Git Integration
const connectionName = z.string().trim().min(1).max(80);
const githubAppId = z.string().trim().regex(/^[0-9]+$/).max(30);
const githubPrivateKey = z.string().trim().min(1).max(20000);
const gitlabToken = z.string().trim().min(1).max(500);
export const createGitConnectionBody = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('github'), name: connectionName, appId: githubAppId, privateKey: githubPrivateKey }),
  z.strictObject({
    provider: z.literal('gitlab'),
    name: connectionName,
    baseUrl: z.string().trim().max(500).default('https://gitlab.com'),
    token: gitlabToken,
  }),
]);
export type CreateGitConnectionBody = z.infer<typeof createGitConnectionBody>;
/** Omitted secrets keep their current value. Provider and GitLab URL never change. */
export const updateGitConnectionBody = z.strictObject({
  name: connectionName.optional(),
  appId: githubAppId.optional(),
  privateKey: githubPrivateKey.optional(),
  token: gitlabToken.optional(),
});
export type UpdateGitConnectionBody = z.infer<typeof updateGitConnectionBody>;
export const repositoryBody = z.strictObject({
  connectionId: z.string().min(1).max(64),
  providerRepoId: z.string().regex(/^[0-9]+$/).max(30),
  baseBranch: z.string().trim().min(1).max(250).optional(),
});
export type RepositoryBody = z.infer<typeof repositoryBody>;
