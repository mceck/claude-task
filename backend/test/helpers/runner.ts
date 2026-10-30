import { RUNNER_PROTOCOL_VERSION, RUNNER_WS_PATH } from '@claude-task/shared';
import type { BackendToRunner, JobStartMessage, RunnerJobMessage, RunnerToBackend } from '@claude-task/shared';
import WebSocket from 'ws';
import type { TestApp } from './app';
import type { StreamEvent } from './stream';

type Received = BackendToRunner;

/**
 * Plays the Runner inside an Agent Container: connects with the container's token, records
 * what the backend sends, and replays stream-json events for a Job.
 */
export class FakeRunner {
  readonly received: Received[] = [];
  private waiters: { match: (m: Received) => boolean; resolve: (m: Received) => void }[] = [];
  private readonly seqs = new Map<string, number>();
  closed: Promise<{ code: number }>;

  private constructor(
    private readonly app: TestApp,
    readonly agentId: string,
    private readonly socket: WebSocket,
  ) {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Received;
      this.received.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    this.closed = new Promise((resolve) => socket.on('close', (code) => resolve({ code })));
  }

  /** The token the backend put in the Agent Container's env. */
  static token(app: TestApp, agentId: string): string {
    const token = app.runtime.containers.get(agentId)?.spec.env.CLAUDE_TASK_RUNNER_TOKEN;
    if (!token) throw new Error(`no container for agent ${agentId}`);
    return token;
  }

  /** `autoPong: false` plays a Runner that went silent (a half-open connection). */
  static async connect(
    app: TestApp,
    agentId: string,
    opts: { token?: string; activeJobId?: string | null; hello?: boolean; autoPong?: boolean } = {},
  ): Promise<FakeRunner> {
    const socket = new WebSocket(`${app.url.replace(/^http/, 'ws')}${RUNNER_WS_PATH}`, {
      headers: { authorization: `Bearer ${opts.token ?? FakeRunner.token(app, agentId)}` },
      autoPong: opts.autoPong ?? true,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('unexpected-response', (_req, res) => reject(new Error(`runner rejected: ${res.statusCode}`)));
      socket.once('error', reject);
    });
    const runner = new FakeRunner(app, agentId, socket);
    if (opts.hello !== false) {
      await runner.hello(opts.activeJobId ?? null);
    }
    return runner;
  }

  async hello(activeJobId: string | null = null): Promise<void> {
    this.send({ type: 'hello', protocolVersion: RUNNER_PROTOCOL_VERSION, runnerVersion: 'test', claudeVersion: '2.1.310', activeJobId });
    // A ping sent after hello proves the server received the preceding frame. Only
    // then can draining its message chain wait for hello, rather than an empty chain.
    const pong = new Promise<void>((resolve) => this.socket.once('pong', () => resolve()));
    this.socket.ping();
    await pong;
    await this.app.server.ctx.runners.drain(this.agentId);
    await this.app.settle();
  }

  send(msg: RunnerToBackend): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** Sends a Job message with the next seq for that Job. */
  sendJob(msg: DistributiveOmit<RunnerJobMessage, 'seq'>): number {
    const seq = (this.seqs.get(msg.jobId) ?? 0) + 1;
    this.seqs.set(msg.jobId, seq);
    this.send({ ...msg, seq } as RunnerJobMessage);
    return seq;
  }

  /** Resends a message with an explicit seq (to test duplicates after a reconnect). */
  resend(msg: RunnerJobMessage): void {
    this.send(msg);
  }

  accept(jobId: string): void {
    this.sendJob({ type: 'job.accepted', jobId });
  }

  /** Each event as a `job.event`, plus `job.result` after every `result` line, like the real Runner. */
  async play(jobId: string, events: StreamEvent[]): Promise<void> {
    for (const e of events) {
      const seq = this.sendJob({ type: 'job.event', jobId, line: JSON.stringify(e) });
      if (e.type === 'result') this.sendJob({ type: 'job.result', jobId, eventSeq: seq });
    }
    await this.drain();
  }

  async exit(jobId: string, exitCode: number | null = 0, signal: string | null = null): Promise<void> {
    this.sendJob({ type: 'job.exited', jobId, exitCode, signal });
    await this.drain();
  }

  /** A whole Job: accept, play the Turn, and exit once the backend says `job.end`. */
  async runJob(events: StreamEvent[]): Promise<JobStartMessage> {
    const start = await this.next('job.start');
    this.accept(start.jobId);
    await this.play(start.jobId, events);
    await this.next('job.end', (m) => m.jobId === start.jobId);
    await this.exit(start.jobId);
    return start;
  }

  /** Waits until the backend has processed everything sent so far. */
  async drain(): Promise<void> {
    // The backend acks each Job message after processing it.
    const pending = [...this.seqs].filter(([jobId, seq]) => !this.acked(jobId, seq));
    await Promise.all(pending.map(([jobId, seq]) => this.next('ack', (m) => m.jobId === jobId && m.seq >= seq, 5000)));
    await this.app.settle();
  }

  private acked(jobId: string, seq: number): boolean {
    return this.received.some((m) => m.type === 'ack' && m.jobId === jobId && m.seq >= seq);
  }

  messages<T extends Received['type']>(type: T): Extract<Received, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<Received, { type: T }>[];
  }

  /** The first matching message, already received or upcoming. */
  next<T extends Received['type']>(type: T, predicate: (m: Extract<Received, { type: T }>) => boolean = () => true, timeoutMs = 3000): Promise<Extract<Received, { type: T }>> {
    const match = (m: Received) => m.type === type && predicate(m as Extract<Received, { type: T }>);
    const seen = this.received.find(match);
    if (seen) return Promise.resolve(seen as Extract<Received, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`timed out waiting for ${type}; got ${this.received.map((m) => m.type).join(', ')}`));
      }, timeoutMs);
      const done = (m: Received) => {
        clearTimeout(timer);
        resolve(m as Extract<Received, { type: T }>);
      };
      this.waiters.push({ match, resolve: done });
    });
  }

  /** Asserts nothing of this type arrives (after the backend settles). */
  async none(type: Received['type'], predicate: (m: Received) => boolean = () => true): Promise<boolean> {
    await this.app.settle();
    return !this.received.some((m) => m.type === type && predicate(m));
  }

  close(): Promise<{ code: number }> {
    this.socket.close();
    return this.closed;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
