// Real-time events pushed to browsers over the WebSocket. Events are notifications
// carrying the new projection; on reconnect clients refetch instead of replaying.
import type { Comment, Label, Project, Revision, Status, Task, TaskCard } from './domain';

export type Topic = `project:${string}` | `task:${string}`;

export const projectTopic = (projectId: string): Topic => `project:${projectId}`;
export const taskTopic = (taskId: string): Topic => `task:${taskId}`;

/** Events on `project:<id>` (the Board). */
export type BoardEvent =
  | { type: 'task.created'; task: TaskCard }
  | { type: 'task.updated'; task: TaskCard }
  | { type: 'task.moved'; task: TaskCard }
  | { type: 'task.deleted'; projectId: string; taskId: string }
  | { type: 'statuses.changed'; projectId: string; statuses: Status[] }
  | { type: 'labels.changed'; projectId: string; labels: Label[] }
  | { type: 'project.updated'; project: Project };

/** Events on `task:<id>` (the Timeline and detail view). */
export type TaskEvent =
  | { type: 'task.changed'; task: Task }
  | { type: 'task.removed'; taskId: string }
  | { type: 'comment.created'; comment: Comment }
  | { type: 'comment.updated'; comment: Comment }
  | { type: 'comment.deleted'; comment: Comment }
  | { type: 'revision.created'; revision: Revision };

export type RealtimeEvent = BoardEvent | TaskEvent;

export type ClientMessage =
  | { type: 'subscribe'; topics: Topic[] }
  | { type: 'unsubscribe'; topics: Topic[] };

export type ServerMessage =
  | { type: 'event'; topic: Topic; event: RealtimeEvent }
  /** Acknowledges a subscribe: events on these topics will be delivered from now on. */
  | { type: 'subscribed'; topics: Topic[] }
  | { type: 'error'; message: string };
