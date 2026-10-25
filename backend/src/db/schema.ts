import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACTOR_TYPES,
  BUILD_STATUSES,
  CATEGORIES,
  COMMENT_KINDS,
  CREDENTIAL_KINDS,
  DELIVERY_STATES,
  EFFORT_LEVELS,
  IMAGE_STATES,
  JOB_STATES,
  PERMISSION_MODES,
  PRIORITIES,
  QUEUE_ENTRY_KINDS,
  ROLES,
  SESSION_STATES,
} from '@claude-task/shared';
import type { AgentItemPayload, RevisionChange, Usage } from '@claude-task/shared';

export const roleEnum = pgEnum('role', ROLES);
export const categoryEnum = pgEnum('category', CATEGORIES);
export const priorityEnum = pgEnum('priority', PRIORITIES);
export const actorTypeEnum = pgEnum('actor_type', ACTOR_TYPES);
export const commentKindEnum = pgEnum('comment_kind', COMMENT_KINDS);
export const credentialKindEnum = pgEnum('credential_kind', CREDENTIAL_KINDS);
export const permissionModeEnum = pgEnum('permission_mode', PERMISSION_MODES);
export const effortEnum = pgEnum('effort', EFFORT_LEVELS);
export const imageStateEnum = pgEnum('image_state', IMAGE_STATES);
export const buildStatusEnum = pgEnum('build_status', BUILD_STATUSES);
export const sessionStateEnum = pgEnum('session_state', SESSION_STATES);
export const queueEntryKindEnum = pgEnum('queue_entry_kind', QUEUE_ENTRY_KINDS);
export const jobStateEnum = pgEnum('job_state', JOB_STATES);
export const deliveryStateEnum = pgEnum('delivery_state', DELIVERY_STATES);
export const agentItemKindEnum = pgEnum('agent_item_kind', ['thinking', 'activity', 'turn_summary', 'notice']);

/** Fractional-index keys compare by byte, so they need the C collation. */
const orderKey = customType<{ data: string }>({ dataType: () => 'text COLLATE "C"' });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: roleEnum('role').notNull().default('member'),
    active: boolean('active').notNull().default(true),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`)],
);

/** A User's authenticated browser session (a Login, not an agent Session). */
export const logins = pgTable(
  'logins',
  {
    /** SHA-256 of the cookie token; the token itself is never stored. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('logins_user_idx').on(t.userId)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    nextTaskNumber: integer('next_task_number').notNull().default(1),
    /** Runs in every newly created Worktree of the Project's Tasks. */
    setupScript: text('setup_script').notNull().default(''),
    agentInstructions: text('agent_instructions').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('projects_key_unique').on(t.key)],
);

export const statuses = pgTable(
  'statuses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    category: categoryEnum('category').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [uniqueIndex('statuses_name_unique').on(t.projectId, sql`lower(${t.name})`)],
);

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
  },
  (t) => [uniqueIndex('labels_name_unique').on(t.projectId, sql`lower(${t.name})`)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    statusId: uuid('status_id')
      .notNull()
      .references(() => statuses.id),
    priority: priorityEnum('priority').notNull().default('none'),
    position: orderKey('position').notNull(),
    createdByType: actorTypeEnum('created_by_type').notNull(),
    createdById: uuid('created_by_id'),
    agentId: uuid('agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'set null' }),
    currentSessionId: uuid('current_session_id'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tasks_number_unique').on(t.projectId, t.number),
    index('tasks_status_position_idx').on(t.statusId, t.position),
  ],
);

export const taskAssignees = pgTable(
  'task_assignees',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.userId] }), index('task_assignees_user_idx').on(t.userId)],
);

export const taskLabels = pgTable(
  'task_labels',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.labelId] }), index('task_labels_label_idx').on(t.labelId)],
);

export const taskRevisions = pgTable(
  'task_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: uuid('actor_id'),
    changes: jsonb('changes').$type<RevisionChange[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('task_revisions_version_unique').on(t.taskId, t.version)],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: commentKindEnum('kind').notNull(),
    authorType: actorTypeEnum('author_type').notNull(),
    authorId: uuid('author_id'),
    body: text('body').notNull(),
    internal: boolean('internal').notNull().default(false),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** `none` for Internal Notes, agent and system Comments, and Comments posted without an Agent. */
    deliveryState: deliveryStateEnum('delivery_state').notNull().default('none'),
    deliveryReason: text('delivery_reason'),
    deliveredInJobId: uuid('delivered_in_job_id'),
    queueEntryId: uuid('queue_entry_id'),
    /** For Notify agent Comments: the Task version their change list goes up to. */
    noticeTaskVersion: integer('notice_task_version'),
    /** For Notify agent Comments: what the Agent receives (the field-by-field changes). */
    noticeMessage: text('notice_message'),
    /** For agent Comments: the Job whose stream produced it. */
    jobId: uuid('job_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('comments_task_created_idx').on(t.taskId, t.createdAt),
    index('comments_queue_entry_idx').on(t.queueEntryId),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    blobId: text('blob_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    /** Upload order within the Comment. */
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_comment_idx').on(t.commentId)],
);

// Agents (Spec 02)

/** Every encrypted value carries its key version, e.g. `v1:<iv>:<tag>:<ciphertext>`. */
export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: credentialKindEnum('kind').notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretLast4: text('secret_last4').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('credentials_name_unique').on(sql`lower(${t.name})`)],
);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    avatarEmoji: text('avatar_emoji').notNull(),
    avatarColor: text('avatar_color').notNull(),
    description: text('description').notNull().default(''),
    dockerfile: text('dockerfile').notNull(),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    model: text('model'),
    effort: effortEnum('effort'),
    permissionMode: permissionModeEnum('permission_mode').notNull().default('bypassPermissions'),
    systemPrompt: text('system_prompt').notNull().default(''),
    cpuLimit: doublePrecision('cpu_limit'),
    memoryMb: integer('memory_mb'),
    enabled: boolean('enabled').notNull().default(true),
    /** SHA-256 of the token the Runner connects with; regenerated on every container recreation. */
    runnerTokenHash: text('runner_token_hash'),
    /** The image of the latest successful build: what the container should run. */
    imageTag: text('image_tag'),
    imageState: imageStateEnum('image_state').notNull().default('none'),
    /** Base Image version the latest build used. */
    imageBaseVersion: text('image_base_version'),
    /** Image and limits the current container was created with (JSON), compared with the desired ones. */
    containerSpec: text('container_spec'),
    containerState: text('container_state').notNull().default('missing'),
    /** Set when an Admin asked to recreate the container even if the Agent is working. */
    forceRecreate: boolean('force_recreate').notNull().default(false),
    runnerConnectedAt: timestamp('runner_connected_at', { withTimezone: true }),
    runnerDisconnectedAt: timestamp('runner_disconnected_at', { withTimezone: true }),
    runnerVersion: text('runner_version'),
    claudeVersion: text('claude_version'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('agents_name_unique').on(sql`lower(${t.name})`)],
);

export const agentBuilds = pgTable(
  'agent_builds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    dockerfile: text('dockerfile').notNull(),
    baseVersion: text('base_version').notNull(),
    status: buildStatusEnum('status').notNull().default('building'),
    imageTag: text('image_tag'),
    /** Capped; the tail is kept. */
    log: text('log').notNull().default(''),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('agent_builds_agent_idx').on(t.agentId, t.startedAt)],
);

export const projectEnvVars = pgTable(
  'project_env_vars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    secret: boolean('secret').notNull(),
    /** Plain values only; secrets go to `valueCiphertext`. */
    value: text('value'),
    valueCiphertext: text('value_ciphertext'),
    last4: text('last4'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('project_env_vars_name_unique').on(t.projectId, t.name)],
);

/** The Claude Code conversation of one (Task, Agent); its id is also the Claude session id. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    state: sessionStateEnum('state').notNull().default('pending'),
    worktreePath: text('worktree_path').notNull(),
    /** Whether `claude` created the session, so later Jobs `--resume` it. */
    started: boolean('started').notNull().default(false),
    lastSeenTaskVersion: integer('last_seen_task_version').notNull().default(0),
    /** When the latest Job of this Session was dispatched. */
    lastJobAt: timestamp('last_job_at', { withTimezone: true }),
    /** The Worktree must be removed once the Runner is connected. */
    worktreeRemovalPending: boolean('worktree_removal_pending').notNull().default(false),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('sessions_task_agent_unique').on(t.taskId, t.agentId), index('sessions_agent_idx').on(t.agentId)],
);

export const queueEntries = pgTable(
  'queue_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: queueEntryKindEnum('kind').notNull(),
    position: orderKey('position').notNull(),
    /** After a failed Job: waits for a Retry (or a new Comment) instead of being dispatched. */
    held: boolean('held').notNull().default(false),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('queue_entries_agent_task_unique').on(t.agentId, t.taskId),
    index('queue_entries_agent_position_idx').on(t.agentId, t.position),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: queueEntryKindEnum('kind').notNull(),
    state: jobStateEnum('state').notNull().default('dispatched'),
    /** SHA-256 of the Job token used by the Task Tools MCP server. */
    tokenHash: text('token_hash').notNull(),
    /** Highest Runner message seq processed (they're applied exactly once, in order). */
    lastSeq: integer('last_seq').notNull().default(0),
    /** State of the stream projection, carried from event to event. */
    projection: jsonb('projection').$type<Record<string, unknown>>(),
    claudeVersion: text('claude_version'),
    mcpServers: jsonb('mcp_servers').$type<unknown[]>(),
    setupOutput: text('setup_output').notNull().default(''),
    stderr: text('stderr').notNull().default(''),
    exitCode: integer('exit_code'),
    signal: text('signal'),
    failureStage: text('failure_stage'),
    error: text('error'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_agent_idx').on(t.agentId, t.createdAt),
    index('jobs_session_idx').on(t.sessionId),
    uniqueIndex('jobs_token_unique').on(t.tokenHash),
  ],
);

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    resultSubtype: text('result_subtype').notNull(),
    isError: boolean('is_error').notNull(),
    stopReason: text('stop_reason'),
    durationMs: integer('duration_ms').notNull(),
    numToolCalls: integer('num_tool_calls').notNull(),
    costUsd: doublePrecision('cost_usd'),
    usage: jsonb('usage').$type<Usage>(),
  },
  (t) => [uniqueIndex('turns_job_index_unique').on(t.jobId, t.index), index('turns_agent_idx').on(t.agentId, t.finishedAt)],
);

/** The raw stream, kept for audit and re-projection. */
export const sessionEvents = pgTable(
  'session_events',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb('payload').notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.seq] })],
);

/** Thinking, Activity, Turn Summaries and notices; agent text lives in `comments`. */
export const agentItems = pgTable(
  'agent_items',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    kind: agentItemKindEnum('kind').notNull(),
    payload: jsonb('payload').$type<AgentItemPayload>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_items_task_created_idx').on(t.taskId, t.createdAt)],
);

export const rateLimitObservations = pgTable(
  'rate_limit_observations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rate_limit_observations_credential_idx').on(t.credentialId, t.observedAt)],
);
