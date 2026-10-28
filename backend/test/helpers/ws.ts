import { API_PREFIX } from '@claude-task/shared';
import type { RealtimeEvent, ServerMessage, Topic } from '@claude-task/shared';
import WebSocket from 'ws';

type EventMessage = Extract<ServerMessage, { type: 'event' }>;

/** A WebSocket client that records every event so tests can wait for or rule out events. */
export class WsTestClient {
  readonly messages: ServerMessage[] = [];
  readonly received: EventMessage[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  closed: Promise<{ code: number }>;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      this.messages.push(msg);
      if (msg.type === 'event') this.received.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    this.closed = new Promise((resolve) => socket.on('close', (code) => resolve({ code })));
  }

  static connect(baseUrl: string, cookie: string | null, opts: { origin?: string } = {}): Promise<WsTestClient> {
    const url = `${baseUrl.replace(/^http/, 'ws')}${API_PREFIX}/ws`;
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (opts.origin) headers.origin = opts.origin;
    const socket = new WebSocket(url, { headers });
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(new WsTestClient(socket)));
      socket.once('unexpected-response', (_req, res) => reject(new Error(`ws rejected: ${res.statusCode}`)));
      socket.once('error', reject);
    });
  }

  async subscribe(...topics: Topic[]): Promise<void> {
    const ack = this.wait((m) => m.type === 'subscribed', 2000);
    this.socket.send(JSON.stringify({ type: 'subscribe', topics }));
    await ack;
  }

  unsubscribe(...topics: Topic[]): void {
    this.socket.send(JSON.stringify({ type: 'unsubscribe', topics }));
  }

  /** Resolves with the first event (already received or upcoming) matching the predicate. */
  async next<T extends RealtimeEvent['type']>(
    type: T,
    predicate: (event: Extract<RealtimeEvent, { type: T }>, topic: Topic) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<{ topic: Topic; event: Extract<RealtimeEvent, { type: T }> }> {
    const matches = (m: ServerMessage) =>
      m.type === 'event' && m.event.type === type && predicate(m.event as never, m.topic);
    const seen = this.received.find(matches);
    const msg = (seen ?? (await this.wait(matches, timeoutMs))) as EventMessage;
    return { topic: msg.topic, event: msg.event as Extract<RealtimeEvent, { type: T }> };
  }

  /** All recorded events of a type (on any topic). */
  events<T extends RealtimeEvent['type']>(type: T): Extract<RealtimeEvent, { type: T }>[] {
    return this.received.filter((m) => m.event.type === type).map((m) => m.event as Extract<RealtimeEvent, { type: T }>);
  }

  close(): void {
    this.socket.close();
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  message(match: (message: ServerMessage) => boolean, timeoutMs = 2000): Promise<ServerMessage> {
    return this.wait(match, timeoutMs);
  }

  /** Plays a browser that stopped reading (a frozen tab or a dead network). */
  stopReading(): void {
    (this.socket as unknown as { _socket: import('node:net').Socket })._socket.pause();
  }

  private wait(match: (m: ServerMessage) => boolean, timeoutMs: number): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error('timed out waiting for a WebSocket message'));
      }, timeoutMs);
      const done = (m: ServerMessage) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push({ match, resolve: done });
    });
  }
}
