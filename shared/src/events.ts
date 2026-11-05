// Real-time events pushed to browsers over the WebSocket. Events are notifications
// carrying the new projection; on reconnect clients refetch instead of replaying.
import type { UserEvent } from './mobile';
import type { VoiceCommand, VoiceServerMessage, VoiceRoom } from './voice';
import type { Agent, ContextUsage, Job, LiveDelta, QueueEntry, RunMessage, RunSummary, TaskSession } from './agents';
import type { Worker, WorkerBuild } from './workers';
import type { AgentItem, Comment, Tag, Project, Revision, ScheduledMessage, Status, Task, TaskCard } from './domain';

export type Topic = `project:${string}` | `task:${string}` | 'agents' | 'wikis' | 'schedules' | 'projects' | 'workers' | `agent:${string}` | `worker:${string}` | `user:${string}`;

export const projectTopic = (projectId: string): Topic => `project:${projectId}`;
export const taskTopic = (taskId: string): Topic => `task:${taskId}`;
export const userTopic = (userId: string): Topic => `user:${userId}`;
export const AGENTS_TOPIC: Topic = 'agents';
/** The Projects list: its unread and running indicators may have changed. */
export const PROJECTS_TOPIC: Topic = 'projects';
export const agentTopic = (agentId: string): Topic => `agent:${agentId}`;
export const WORKERS_TOPIC: Topic = 'workers';
export const workerTopic = (workerId: string): Topic => `worker:${workerId}`;

/** Events on `project:<id>` (the Board). */
export type BoardEvent =
  | { type: 'task.created'; task: TaskCard }
  | { type: 'task.updated'; task: TaskCard }
  | { type: 'task.moved'; task: TaskCard }
  | { type: 'task.deleted'; projectId: string; taskId: string }
  | { type: 'statuses.changed'; projectId: string; statuses: Status[] }
  | { type: 'tags.changed'; projectId: string; tags: Tag[] }
  | { type: 'project.updated'; project: Project };

/** Events on `task:<id>` (the Timeline and detail view). */
export type TaskEvent =
  | { type: 'task.changed'; task: Task }
  | { type: 'task.removed'; taskId: string }
  | { type: 'timeline.reset'; taskId: string }
  /** `readPosition` is the entry's persisted Timeline position, so clients place it exactly where the server stores it. */
  | { type: 'comment.created'; comment: Comment; readPosition?: string }
  | { type: 'comment.updated'; comment: Comment }
  | { type: 'comment.deleted'; comment: Comment }
  | { type: 'revision.created'; revision: Revision; readPosition?: string }
  /** A scheduled message was created, changed, cancelled or published. */
  | { type: 'scheduled_message.updated'; message: ScheduledMessage }
  | { type: 'session.changed'; taskId: string; session: TaskSession | null }
  | { type: 'agent_item.created'; item: AgentItem; readPosition?: string }
  | { type: 'agent_item.updated'; item: AgentItem }
  /** Live text or thinking of the running Turn; not persisted, the final Comment follows. */
  | { type: 'live.delta'; taskId: string; delta: LiveDelta }
  /** (also on the Project's topic, for the Board's cards) The conversation's context size after a model call of the running Turn; the window is null (the CLI reports it with the Turn's result). */
  | { type: 'live.context'; taskId: string; context: ContextUsage }
  /** Transient status of the running Turn (API retries); null clears it. */
  | { type: 'live.status'; taskId: string; status: { kind: 'retrying'; attempt: number; maxRetries: number; error: string | null } | null }
  /** A Run started or ended; its transcript stays in the backend's memory. */
  | { type: 'run.updated'; taskId: string; run: RunSummary }
  /** One message of a Run's live transcript, numbered per Run. */
  | { type: 'run.message'; taskId: string; runId: string; message: RunMessage }
  | { type: 'job.setup_output'; taskId: string; jobId: string; chunk: string };

/** Events on `agents` (the Agents list) and `agent:<id>` (an Agent's detail view). */
export type AgentEvent =
  | { type: 'agent.updated'; agent: Agent }
  | { type: 'agent.deleted'; agentId: string }
  | { type: 'job.updated'; job: Job };

/** Events on `workers` (the Workers list) and `worker:<id>` (a Worker's page). */
export type WorkerEvent =
  | { type: 'worker.updated'; worker: Worker }
  | { type: 'worker.deleted'; workerId: string }
  | { type: 'queue.changed'; workerId: string; entries: QueueEntry[] }
  | { type: 'build.updated'; build: Omit<WorkerBuild, 'log'> }
  | { type: 'build.log'; workerId: string; buildId: string; chunk: string }
  /** On `workers` only. The record is for Admins, who load it with `GET /cleanup`. */
  | { type: 'cleanup.updated'; cleanupId: string };

export type RealtimeEvent = { type: 'voice.room'; room: VoiceRoom } | { type: 'wiki.changed'; wikiId: string } | { type: 'schedule.changed'; scheduleId: string } | { type: 'project.activity'; projectId: string } | BoardEvent | TaskEvent | AgentEvent | WorkerEvent | UserEvent;

export type ClientMessage =
  | VoiceCommand
  | { type: 'subscribe'; topics: Topic[] }
  | { type: 'unsubscribe'; topics: Topic[] };

export type ServerMessage =
  | VoiceServerMessage
  | { type: 'event'; topic: Topic; event: RealtimeEvent }
  /** Acknowledges a subscribe: events on these topics will be delivered from now on. */
  | { type: 'subscribed'; topics: Topic[] }
  | { type: 'error'; message: string };
