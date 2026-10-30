// Real-time events pushed to browsers over the WebSocket. Events are notifications
// carrying the new projection; on reconnect clients refetch instead of replaying.
import type { UserEvent } from './mobile';
import type { VoiceCommand, VoiceServerMessage, VoiceRoom } from './voice';
import type { Agent, AgentBuild, Job, LiveDelta, QueueEntry, RunMessage, RunSummary, TaskSession } from './agents';
import type { AgentItem, Comment, Tag, Project, Revision, Status, Task, TaskCard } from './domain';

export type Topic = `project:${string}` | `task:${string}` | 'agents' | 'wikis' | 'schedules' | `agent:${string}` | `user:${string}`;

export const projectTopic = (projectId: string): Topic => `project:${projectId}`;
export const taskTopic = (taskId: string): Topic => `task:${taskId}`;
export const userTopic = (userId: string): Topic => `user:${userId}`;
export const AGENTS_TOPIC: Topic = 'agents';
export const agentTopic = (agentId: string): Topic => `agent:${agentId}`;

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
  | { type: 'comment.created'; comment: Comment }
  | { type: 'comment.updated'; comment: Comment }
  | { type: 'comment.deleted'; comment: Comment }
  | { type: 'revision.created'; revision: Revision }
  | { type: 'session.changed'; taskId: string; session: TaskSession | null }
  | { type: 'agent_item.created'; item: AgentItem }
  | { type: 'agent_item.updated'; item: AgentItem }
  /** Live text or thinking of the running Turn; not persisted, the final Comment follows. */
  | { type: 'live.delta'; taskId: string; delta: LiveDelta }
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
  | { type: 'queue.changed'; agentId: string; entries: QueueEntry[] }
  | { type: 'build.updated'; build: Omit<AgentBuild, 'log'> }
  | { type: 'build.log'; agentId: string; buildId: string; chunk: string }
  | { type: 'job.updated'; job: Job };

export type RealtimeEvent = { type: 'voice.room'; room: VoiceRoom } | { type: 'wiki.changed'; wikiId: string } | { type: 'schedule.changed'; scheduleId: string } | BoardEvent | TaskEvent | AgentEvent | UserEvent;

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
