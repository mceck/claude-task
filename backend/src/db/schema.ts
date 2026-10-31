import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  check,
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
  LIMIT_RESUME_STATES,
  SCHEDULED_MESSAGE_KINDS,
  SCHEDULED_MESSAGE_STATES,
  PERMISSION_MODES,
  PRIORITIES,
  QUESTION_KINDS,
  QUEUE_ENTRY_KINDS,
  ROLES,
  SESSION_STATES,
} from '@claude-task/shared';
import type { AgentService, AgentItemPayload, RevisionChange, Usage, ProjectRepository, PullRequest, GitProviderKind, QuestionAnswer, QuestionItem } from '@claude-task/shared';

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
export const agentItemKindEnum = pgEnum('agent_item_kind', ['thinking', 'activity', 'run', 'turn_summary', 'notice']);

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
    avatarBlobId: text('avatar_blob_id'),
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
    kind: text('kind').notNull().default('project'),
    logoBlobId: uuid('logo_blob_id'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    repository: jsonb('repository').$type<ProjectRepository>(),
    nextTaskNumber: integer('next_task_number').notNull().default(1),
    /** Runs in every newly created Worktree of the Project's Tasks. */
    setupScript: text('setup_script').notNull().default(''),
    agentInstructions: text('agent_instructions').notNull().default(''),
    /** Assigned to every new Task of the Project when it is enabled. */
    defaultAgentId: uuid('default_agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'set null' }),
    /** Copied to each new Task: a usage limit with a known reset time resumes it without asking. */
    autoResume: boolean('auto_resume').notNull().default(false),
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

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
  },
  (t) => [uniqueIndex('tags_name_unique').on(t.projectId, sql`lower(${t.name})`)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    branchName: text('branch_name'),
    branchUrl: text('branch_url'),
    pullRequest: jsonb('pull_request').$type<PullRequest>(),
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
    chatGeneration: integer('chat_generation').notNull().default(0),
    autoResume: boolean('auto_resume').notNull().default(false),
    /** A Wiki Chat's title once someone renamed it; until then the Chat is titled by its first User Comment. */
    chatTitle: text('chat_title'),
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

export const taskTags = pgTable(
  'task_tags',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] }), index('task_tags_tag_idx').on(t.tagId)],
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
    /** On the User Comment answering a Question: the Question's Comment. */
    answersCommentId: uuid('answers_comment_id').references((): AnyPgColumn => comments.id, { onDelete: 'set null' }),
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
    /** Set for files attached to a Comment. */
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    /** Set for files embedded in a Task's description (no Comment). */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    /** Set for files of a pending Scheduled Message; they move to its Comment when it is published. */
    scheduledMessageId: uuid('scheduled_message_id').references((): AnyPgColumn => scheduledMessages.id, { onDelete: 'cascade' }),
    blobId: text('blob_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    /** Upload order within the Comment. */
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('attachments_comment_idx').on(t.commentId),
    index('attachments_task_idx').on(t.taskId),
    index('attachments_scheduled_message_idx').on(t.scheduledMessageId),
    check('attachments_owner_check', sql`(${t.commentId} is not null)::int + (${t.taskId} is not null)::int + (${t.scheduledMessageId} is not null)::int = 1`),
  ],
);

/** A Comment a User wrote ahead of time, or a Limit Resume; published as a Comment when due. */
export const scheduledMessages = pgTable(
  'scheduled_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: SCHEDULED_MESSAGE_KINDS }).notNull(),
    /** Null for a Limit Resume. */
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    internal: boolean('internal').notNull().default(false),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    state: text('state', { enum: SCHEDULED_MESSAGE_STATES }).notNull().default('pending'),
    cancelReason: text('cancel_reason'),
    commentId: uuid('comment_id').references((): AnyPgColumn => comments.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('scheduled_messages_task_idx').on(t.taskId, t.dueAt), index('scheduled_messages_due_idx').on(t.state, t.dueAt)],
);

/** The offer to resume a Task after a usage limit, on the System Comment that reports the limit. */
export const limitResumeOffers = pgTable('limit_resume_offers', {
  commentId: uuid('comment_id')
    .primaryKey()
    .references(() => comments.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  resetsAt: timestamp('resets_at', { withTimezone: true }).notNull(),
  state: text('state', { enum: LIMIT_RESUME_STATES }).notNull().default('open'),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  scheduledMessageId: uuid('scheduled_message_id').references((): AnyPgColumn => scheduledMessages.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/** The structured part of an Agent's Question or Survey (docs/specs/conversation.md). */
export const questions = pgTable('questions', {
  commentId: uuid('comment_id')
    .primaryKey()
    .references(() => comments.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: QUESTION_KINDS }).notNull(),
  items: jsonb('items').$type<QuestionItem[]>().notNull(),
  /** `answered` ends a Question, `closed` a Survey. */
  state: text('state', { enum: ['open', 'answered', 'closed'] }).notNull().default('open'),
  /** Survey: the Task's Assignees when it was created. */
  expectedRespondentIds: uuid('expected_respondent_ids').array().notNull().default(sql`'{}'::uuid[]`),
  answer: jsonb('answer').$type<QuestionAnswer[]>(),
  answeredBy: uuid('answered_by').references(() => users.id, { onDelete: 'set null' }),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  answerCommentId: uuid('answer_comment_id').references((): AnyPgColumn => comments.id, { onDelete: 'set null' }),
  /** Null when a Survey closed because every Expected Respondent answered. */
  closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  resultCommentId: uuid('result_comment_id').references((): AnyPgColumn => comments.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/** One User's answer to a Survey, changeable while it is open. */
export const surveyResponses = pgTable(
  'survey_responses',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => questions.commentId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    answers: jsonb('answers').$type<QuestionAnswer[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.userId] })],
);

// Agents (docs/specs/agents.md)

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
    /** BlobStore id of an uploaded image, shown instead of the emoji. */
    avatarBlobId: text('avatar_blob_id'),
    description: text('description').notNull().default(''),
    dockerfile: text('dockerfile').notNull(),
    services: jsonb('services').$type<AgentService[]>().notNull().default(['postgres', 'redis']),
    /** Plain name/value pairs merged into every Job of this Agent (docs/specs/agents.md). */
    env: jsonb('env').$type<Record<string, string>>().notNull().default({}),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    model: text('model'),
    effort: effortEnum('effort'),
    permissionMode: permissionModeEnum('permission_mode').notNull().default('bypassPermissions'),
    systemPrompt: text('system_prompt').notNull().default(''),
    extensionsRevision: integer('extensions_revision').notNull().default(0),
    configuredExtensionsRevision: integer('configured_extensions_revision').notNull().default(-1),
    extensionsError: text('extensions_error'),
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

export const skills = pgTable('skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  source: text('source').notNull(),
  userInvocable: boolean('user_invocable').notNull().default(true),
  files: jsonb('files').$type<import('@claude-task/shared').SkillFile[]>().notNull(),
  contentHash: text('content_hash').notNull(),
  updatedAt: updatedAt(),
});

export interface StoredMcpValue { value: string | null; ciphertext: string | null; last4: string | null }
export const mcpServers = pgTable('mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  type: text('type').$type<'http' | 'sse' | 'stdio'>().notNull(),
  url: text('url').notNull().default(''),
  command: text('command').notNull().default(''),
  args: jsonb('args').$type<string[]>().notNull().default([]),
  headers: jsonb('headers').$type<Record<string, StoredMcpValue>>().notNull().default({}),
  env: jsonb('env').$type<Record<string, StoredMcpValue>>().notNull().default({}),
  updatedAt: updatedAt(),
});
export const plugins = pgTable('plugins', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  source: text('source').notNull().default(''),
  description: text('description').notNull().default(''),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('plugins_source_name_idx').on(t.source, t.name)]);
export const agentSkills = pgTable('agent_skills', {
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  skillId: uuid('skill_id').notNull().references(() => skills.id, { onDelete: 'restrict' }),
}, (t) => [primaryKey({ columns: [t.agentId, t.skillId] })]);
export const agentMcpServers = pgTable('agent_mcp_servers', {
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  mcpServerId: uuid('mcp_server_id').notNull().references(() => mcpServers.id, { onDelete: 'restrict' }),
}, (t) => [primaryKey({ columns: [t.agentId, t.mcpServerId] })]);
export const agentPlugins = pgTable('agent_plugins', {
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  pluginId: uuid('plugin_id').notNull().references(() => plugins.id, { onDelete: 'restrict' }),
}, (t) => [primaryKey({ columns: [t.agentId, t.pluginId] })]);

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

/** The persistent conversation of one (Task, Agent). Claude identity can rotate on Reset Chat. */
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
    /** Rotated by Reset Chat, independent of the persistent Session row. */
    claudeSessionId: uuid('claude_session_id'),
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
    slashCommands: jsonb('slash_commands').$type<string[]>(),
    /** The Worktree's own user-invocable skills and commands, read before `claude` started. */
    projectSkills: jsonb('project_skills').$type<{ name: string; description: string }[]>(),
    setupOutput: text('setup_output').notNull().default(''),
    stderr: text('stderr').notNull().default(''),
    exitCode: integer('exit_code'),
    signal: text('signal'),
    failureStage: text('failure_stage'),
    error: text('error'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    /** Reset Chat: ignore old output while waiting for cancellation to finish. */
    discardOutput: boolean('discard_output').notNull().default(false),
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

/** Git Connections stored from the UI. Environment connections (`env-github`, `env-gitlab`) aren't stored. */
export const gitConnections = pgTable('git_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').$type<GitProviderKind>().notNull(),
  name: text('name').notNull(),
  /** GitHub: `{ appId }`. GitLab: `{ baseUrl, userId, username, expiresAt }` (identity cached from the token). */
  config: jsonb('config').$type<GitConnectionConfig>().notNull(),
  /** Write-only: a GitHub App private key or a GitLab token. */
  secretCiphertext: text('secret_ciphertext').notNull(),
  secretLast4: text('secret_last4'),
  /** The last automatic token rotation failure, cleared by a successful one or a new token. */
  rotationError: text('rotation_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export type GitConnectionConfig =
  | { appId: string }
  | { baseUrl: string; userId: number | null; username: string | null; expiresAt: string | null };

/** Explicit preferences survive automatic-follow triggers. */
export const taskPreferences = pgTable('task_preferences', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  following: boolean('following').notNull().default(true),
  muted: boolean('muted').notNull().default(false),
  explicitFollow: boolean('explicit_follow').notNull().default(false),
  readPosition: bigint('read_position', { mode: 'bigint' }).notNull().default(sql`0`),
}, (t) => [primaryKey({ columns: [t.userId, t.taskId] })]);

/** Persisted Timeline insert order, independent of timestamps and device clocks. */
export const taskActivity = pgTable('task_activity', {
  position: bigint('position', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  itemId: uuid('item_id').notNull(),
}, (t) => [uniqueIndex('task_activity_item_unique').on(t.taskId, t.itemId)]);

export const pushDevices = pgTable('push_devices', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  loginId: text('login_id').notNull().references(() => logins.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenCiphertext: text('token_ciphertext').notNull(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('push_devices_token_unique').on(t.tokenHash), index('push_devices_user_idx').on(t.userId)]);

export const notificationEvents = pgTable('notification_events', {
  id: text('id').primaryKey(),
  /** Null for a Schedule event that reports no Task (a blocked Schedule). */
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  scheduleId: uuid('schedule_id').references((): AnyPgColumn => schedules.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  createdAt: createdAt(),
});

export const pushDeliveries = pgTable('push_deliveries', {
  eventId: text('event_id').notNull().references(() => notificationEvents.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => pushDevices.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.eventId, t.userId, t.deviceId] }), index('push_deliveries_pending_idx').on(t.nextAttemptAt)]);

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Schedule Project: its Tasks are the Scheduled Runs, and it carries the Repository. */
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    agentId: uuid('agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'set null' }),
    cron: text('cron').notNull(),
    timeZone: text('time_zone').notNull().default('UTC'),
    prompt: text('prompt').notNull(),
    readOnly: boolean('read_only').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    consecutiveSkips: integer('consecutive_skips').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('schedules_project_unique').on(t.projectId),
    uniqueIndex('schedules_name_unique').on(sql`lower(${t.name})`),
    index('schedules_next_run_idx').on(t.nextRunAt),
  ],
);

export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    state: text('state', { enum: ['started', 'skipped'] }).notNull(),
    manual: boolean('manual').notNull().default(false),
    /** Null for a skipped run. */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    skipReason: text('skip_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('schedule_runs_schedule_idx').on(t.scheduleId, t.createdAt), uniqueIndex('schedule_runs_task_unique').on(t.taskId)],
);
