import type { BackendToRunner, RunnerToBackend } from '@claude-task/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';

interface Connection {
  containerId: string;
  workerId: string;
  slot: number;
  socket: WebSocket;
  /** The Runner completed its `hello`; dispatching or writing to it may begin. */
  ready: boolean;
  /** Messages are processed one at a time, in arrival order. */
  chain: Promise<void>;
}

/** The connected Runners, at most one per Worker Container. A new connection replaces the old one. */
export class RunnerHub {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly log: () => FastifyBaseLogger) {}

  isConnected(containerId: string): boolean {
    const conn = this.connections.get(containerId);
    return !!conn && conn.socket.readyState === conn.socket.OPEN;
  }

  /** Whether the socket is open and its `hello` has been processed. */
  isReady(containerId: string): boolean {
    const conn = this.connections.get(containerId);
    return !!conn && conn.ready && conn.socket.readyState === conn.socket.OPEN;
  }

  markReady(containerId: string): void {
    const conn = this.connections.get(containerId);
    if (conn) conn.ready = true;
  }

  connectedContainers(): string[] {
    return [...this.connections.keys()].filter((id) => this.isConnected(id));
  }

  send(containerId: string, msg: BackendToRunner): boolean {
    const conn = this.connections.get(containerId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) return false;
    conn.socket.send(JSON.stringify(msg));
    return true;
  }

  /** The ready Runners of a Worker's containers, lowest slot first (the preferred slot first when given). */
  forWorker(workerId: string, preferSlot: number | null = null): string[] {
    return [...this.connections.values()]
      .filter((c) => c.workerId === workerId && this.isReady(c.containerId))
      .sort((a, b) => (a.slot === preferSlot ? -1 : b.slot === preferSlot ? 1 : a.slot - b.slot))
      .map((c) => c.containerId);
  }

  attach(
    runner: { containerId: string; workerId: string; slot: number },
    socket: WebSocket,
    handlers: { message: (msg: RunnerToBackend) => Promise<void>; close: () => Promise<void> },
  ): void {
    const { containerId } = runner;
    const previous = this.connections.get(containerId);
    if (previous) previous.socket.close(4000, 'replaced by a new connection');
    const conn: Connection = { ...runner, socket, ready: false, chain: Promise.resolve() };
    this.connections.set(containerId, conn);

    const enqueue = (work: () => Promise<void>) => {
      conn.chain = conn.chain.then(work).catch((err) => {
        this.log().error({ err, containerId }, 'runner message failed');
        // The message was not acknowledged, so its seq is still in the Runner's outbox. Drop the
        // connection: a live socket never resends, so the Job (or the hello) would stay stuck.
        if (this.connections.get(containerId) === conn) this.disconnect(containerId, 4001, 'message failed');
      });
      const pending = conn.chain;
      this.pending.add(pending);
      void pending.then(() => this.pending.delete(pending));
    };
    socket.on('message', (raw) => {
      if (this.connections.get(containerId) !== conn) return;
      let msg: RunnerToBackend;
      try {
        msg = JSON.parse(raw.toString()) as RunnerToBackend;
      } catch {
        this.log().warn({ containerId }, 'runner sent invalid JSON');
        return;
      }
      enqueue(() => handlers.message(msg));
    });
    socket.on('close', () => {
      if (this.connections.get(containerId) !== conn) return;
      this.connections.delete(containerId);
      enqueue(handlers.close);
    });
  }

  /** Waits until the Worker Container's pending messages are processed (tests). */
  async drain(containerId: string): Promise<void> {
    await this.connections.get(containerId)?.chain;
  }

  disconnect(containerId: string, code = 4001, reason = 'disconnected'): void {
    this.connections.get(containerId)?.socket.close(code, reason);
  }

  async closeAll(): Promise<void> {
    for (const conn of this.connections.values()) conn.socket.close(1001, 'server shutting down');
    this.connections.clear();
    // Closing a socket doesn't stop a handler already writing to the database.
    // Drain those handlers before shutdown (or resetting the test database).
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
