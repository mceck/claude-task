// Entity shapes returned by the API. Terms follow CONTEXT.md.

export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const CATEGORIES = ['open', 'active', 'review', 'done', 'closed'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['urgent', 'high', 'normal', 'low', 'none'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ACTOR_TYPES = ['user', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const COMMENT_KINDS = ['user', 'agent', 'system'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/** Whoever performed an action. `id` is null for the system. */
export interface Actor {
  type: ActorType;
  id: string | null;
  displayName: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CategoryCounts = Record<Category, number>;

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends Project {
  taskCounts: CategoryCounts;
}

export interface Status {
  id: string;
  projectId: string;
  name: string;
  color: string;
  category: Category;
  position: number;
}

export interface Label {
  id: string;
  projectId: string;
  name: string;
  color: string;
}

/** How a Task looks on the Board. */
export interface TaskCard {
  id: string;
  projectId: string;
  key: string;
  number: number;
  title: string;
  statusId: string;
  priority: Priority;
  position: string;
  labelIds: string[];
  assigneeIds: string[];
  commentCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task extends TaskCard {
  description: string;
  createdBy: Actor;
}

export const REVISION_FIELDS = [
  'title',
  'description',
  'statusId',
  'priority',
  'labelIds',
  'assigneeIds',
] as const;
export type RevisionField = (typeof REVISION_FIELDS)[number];

export interface RevisionChange {
  field: RevisionField;
  before: unknown;
  after: unknown;
}

export interface Revision {
  id: string;
  taskId: string;
  version: number;
  actor: Actor;
  changes: RevisionChange[];
  createdAt: string;
}

export interface Attachment {
  id: string;
  commentId: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

export interface Comment {
  id: string;
  taskId: string;
  kind: CommentKind;
  author: Actor;
  /** Empty when the Comment is deleted. */
  body: string;
  internal: boolean;
  attachments: Attachment[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export type TimelineItem =
  | { type: 'comment'; id: string; createdAt: string; comment: Comment }
  | { type: 'revision'; id: string; createdAt: string; revision: Revision };

export interface TimelinePage {
  /** Newest first. */
  items: TimelineItem[];
  /** Pass as `before` to get older items; null when there are none. */
  nextCursor: string | null;
}

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 10;

export function taskKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}
