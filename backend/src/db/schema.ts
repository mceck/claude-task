import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
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
import { ACTOR_TYPES, CATEGORIES, COMMENT_KINDS, PRIORITIES, ROLES } from '@claude-task/shared';
import type { RevisionChange } from '@claude-task/shared';

export const roleEnum = pgEnum('role', ROLES);
export const categoryEnum = pgEnum('category', CATEGORIES);
export const priorityEnum = pgEnum('priority', PRIORITIES);
export const actorTypeEnum = pgEnum('actor_type', ACTOR_TYPES);
export const commentKindEnum = pgEnum('comment_kind', COMMENT_KINDS);

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('comments_task_created_idx').on(t.taskId, t.createdAt)],
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
