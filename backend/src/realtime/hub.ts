import type { RealtimeEvent, ServerMessage, Topic } from '@claude-task/shared';
import type { WebSocket } from 'ws';
import { VoiceRooms } from './voice';

const MAX_BACKLOG_BYTES = 16 * 1024 * 1024;
const TOPIC_PATTERN = /^(?:(?:project|task|agent|user):[0-9a-f-]{36}|agents|wikis)$/;

export function isTopic(value: unknown): value is Topic {
  return typeof value === 'string' && TOPIC_PATTERN.test(value);
}

interface Connection {
  socket: WebSocket;
  userId: string;
  loginId: string;
  topics: Set<Topic>;
}

/** Fans events out to the browsers subscribed to each topic. */
export class RealtimeHub {
  readonly voice = new VoiceRooms((topic, event) => this.publish(topic, event));
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly byTopic = new Map<Topic, Set<Connection>>();

  add(socket: WebSocket, userId: string, loginId: string): void {
    this.connections.set(socket, { socket, userId, loginId, topics: new Set() });
    socket.on('close', () => this.remove(socket));
  }

  subscribe(socket: WebSocket, topics: Topic[]): void {
    const conn = this.connections.get(socket);
    if (!conn) return;
    for (const topic of topics) {
      if (topic.startsWith('user:') && topic !== `user:${conn.userId}`) continue;
      conn.topics.add(topic);
      let set = this.byTopic.get(topic);
      if (!set) this.byTopic.set(topic, (set = new Set()));
      set.add(conn);
    }
  }

  has(socket: WebSocket): boolean {
    return this.connections.has(socket) && socket.readyState === socket.OPEN;
  }

  unsubscribe(socket: WebSocket, topics: Topic[]): void {
    const conn = this.connections.get(socket);
    if (!conn) return;
    for (const topic of topics) {
      conn.topics.delete(topic);
      this.dropFromTopic(topic, conn);
    }
  }

  publish(topic: Topic, event: RealtimeEvent): void {
    if (event.type === 'task.removed') this.voice.deleteTask(event.taskId);
    const set = this.byTopic.get(topic);
    if (!set) return;
    const data = JSON.stringify({ type: 'event', topic, event } satisfies ServerMessage);
    for (const conn of set) {
      if (conn.socket.readyState !== conn.socket.OPEN) continue;
      // A browser that stopped reading would make its backlog grow without end: drop it, it
      // refetches everything when it reconnects.
      if (conn.socket.bufferedAmount > MAX_BACKLOG_BYTES) {
        conn.socket.terminate();
        continue;
      }
      conn.socket.send(data);
    }
  }

  /** Called when Logins end (logout, deactivation, password change). */
  disconnect(match: { userId?: string; loginIds?: string[] }): void {
    for (const conn of this.connections.values()) {
      if (
        (match.userId !== undefined && conn.userId === match.userId) ||
        (match.loginIds?.includes(conn.loginId) ?? false)
      ) {
        conn.socket.close(4001, 'logged out');
        this.remove(conn.socket);
      }
    }
  }

  closeAll(): void {
    for (const conn of [...this.connections.values()]) {
      conn.socket.close(1001, 'server shutting down');
      this.remove(conn.socket);
    }
    this.connections.clear();
    this.byTopic.clear();
  }

  private remove(socket: WebSocket): void {
    const conn = this.connections.get(socket);
    if (!conn) return;
    this.voice.disconnect(socket);
    this.connections.delete(socket);
    for (const topic of conn.topics) this.dropFromTopic(topic, conn);
  }

  private dropFromTopic(topic: Topic, conn: Connection): void {
    const set = this.byTopic.get(topic);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.byTopic.delete(topic);
  }
}
