import type { ProjectRepository, PullRequest } from './git';
// Entity shapes returned by the API. Terms follow docs/CONTEXT.md.
import type { AgentItemPayload, Delivery, SessionState } from './agents';

export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const USER_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const USER_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

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
  avatarImageUrl: string | null;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CategoryCounts = Record<Category, number>;

export interface Project {
  logoUrl: string | null;
  repository: ProjectRepository | null;
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

export interface Tag {
  id: string;
  projectId: string;
  name: string;
  color: string;
}

/** How a Task looks on the Board. */
export interface TaskCard {
  branchName: string | null;
  branchUrl: string | null;
  pullRequest: PullRequest | null;
  id: string;
  projectId: string;
  key: string;
  number: number;
  title: string;
  statusId: string;
  priority: Priority;
  position: string;
  tagIds: string[];
  assigneeIds: string[];
  commentCount: number;
  /** Incremented when Reset Chat clears the conversation. */
  chatGeneration?: number;
  /** The assigned Agent, if any. */
  agentId: string | null;
  /** The current Session's state on the card (agent avatar + state dot). */
  session: { agentId: string; state: SessionState; queuePosition: number | null } | null;
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
  'tagIds',
  'assigneeIds',
  'agentId',
  'pullRequest',
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
  /** Null for files embedded in a task description. */
  commentId: string | null;
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
  /** Whether a User's Comment reached the Agent; null for Internal Notes, agent and system Comments, or with no Agent. */
  delivery: Delivery | null;
  /** Set on an Agent's Question. */
  question: Question | null;
  /** Set on an Agent's Survey. */
  survey: Survey | null;
  /** On the User Comment that answers a Question: the Question's Comment id. */
  answersCommentId: string | null;
}

/** The two kinds of multiple-choice Agent Comments. */
export const QUESTION_KINDS = ['question', 'survey'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** One multiple-choice item of a Question or Survey; "Other" is added by the clients. */
export interface QuestionItem {
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** The answer to one item: chosen option labels and the "Other" text. */
export interface QuestionAnswer {
  selected: string[];
  other: string | null;
}

export interface Question {
  items: QuestionItem[];
  state: 'open' | 'answered';
  answer: QuestionAnswer[] | null;
  answeredBy: Actor | null;
  answeredAt: string | null;
}

export interface SurveyResponse {
  user: Actor;
  answers: QuestionAnswer[];
  updatedAt: string;
}

export interface Survey {
  items: QuestionItem[];
  state: 'open' | 'closed';
  /** The Task's Assignees when the Survey was created. */
  expectedRespondents: Actor[];
  /** In first-answer order. */
  responses: SurveyResponse[];
  /** Null while open, and when it closed because every Expected Respondent answered. */
  closedBy: Actor | null;
  closedAt: string | null;
}

/** Thinking, Activity, Turn Summaries and notices projected from an Agent's stream. */
export interface AgentItem {
  id: string;
  taskId: string;
  sessionId: string;
  jobId: string;
  agentId: string;
  payload: AgentItemPayload;
  createdAt: string;
  updatedAt: string;
}

export type TimelineItem = (
  | { type: 'comment'; id: string; createdAt: string; comment: Comment }
  | { type: 'revision'; id: string; createdAt: string; revision: Revision }
  | { type: 'agent'; id: string; createdAt: string; item: AgentItem }
) & { /** Persisted read position, supplied by Timeline HTTP responses. */ readPosition?: string };

export interface TimelinePage {
  /** Conversation generation for detecting a Reset Chat during page loads. */
  chatGeneration?: number;
  /** Newest first. */
  items: TimelineItem[];
  /** Pass as `before` to get older items; null when there are none. */
  nextCursor: string | null;
}

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 10;

/** Limits of a Question or Survey (they mirror Claude Code's own question tool). */
export const QUESTION_LIMITS = {
  items: { min: 1, max: 4 },
  header: 12,
  question: 2000,
  options: { min: 2, max: 4 },
  label: 60,
  description: 300,
  other: 2000,
} as const;

export function taskKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}
