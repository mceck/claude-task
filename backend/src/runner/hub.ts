import type { BackendToRunner, RunnerToBackend } from '@claude-task/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';

interface Connection {
  agentId: string;
  socket: WebSocket;
  /** Messages are processed one at a time, in arrival order. */
  chain: Promise<void>;
}

/** The connected Runners, at most one per Agent. A new connection replaces the old one. */
export class RunnerHub {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly log: () => FastifyBaseLogger) {}

  isConnected(agentId: string): boolean {
    const conn = this.connections.get(agentId);
    return !!conn && conn.socket.readyState === conn.socket.OPEN;
  }

  connectedAgents(): string[] {
    return [...this.connections.keys()].filter((id) => this.isConnected(id));
  }

  send(agentId: string, msg: BackendToRunner): boolean {
    const conn = this.connections.get(agentId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) return false;
    conn.socket.send(JSON.stringify(msg));
    return true;
  }

  attach(
    agentId: string,
    socket: WebSocket,
    handlers: { message: (msg: RunnerToBackend) => Promise<void>; close: () => Promise<void> },
  ): void {
    const previous = this.connections.get(agentId);
    if (previous) previous.socket.close(4000, 'replaced by a new connection');
    const conn: Connection = { agentId, socket, chain: Promise.resolve() };
    this.connections.set(agentId, conn);

    const enqueue = (work: () => Promise<void>) => {
      conn.chain = conn.chain.then(work).catch((err) => this.log().error({ err, agentId }, 'runner message failed'));
      const pending = conn.chain;
      this.pending.add(pending);
      void pending.then(() => this.pending.delete(pending));
    };
    socket.on('message', (raw) => {
      if (this.connections.get(agentId) !== conn) return;
      let msg: RunnerToBackend;
      try {
        msg = JSON.parse(raw.toString()) as RunnerToBackend;
      } catch {
        this.log().warn({ agentId }, 'runner sent invalid JSON');
        return;
      }
      enqueue(() => handlers.message(msg));
    });
    socket.on('close', () => {
      if (this.connections.get(agentId) !== conn) return;
      this.connections.delete(agentId);
      enqueue(handlers.close);
    });
  }

  /** Waits until the Agent's pending messages are processed (tests). */
  async drain(agentId: string): Promise<void> {
    await this.connections.get(agentId)?.chain;
  }

  disconnect(agentId: string, code = 4001, reason = 'disconnected'): void {
    this.connections.get(agentId)?.socket.close(code, reason);
  }

  async closeAll(): Promise<void> {
    for (const conn of this.connections.values()) conn.socket.close(1001, 'server shutting down');
    this.connections.clear();
    // Closing a socket doesn't stop a handler already writing to the database.
    // Drain those handlers before shutdown (or resetting the test database).
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
