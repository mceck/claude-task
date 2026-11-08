import Docker from 'dockerode';
import { Agent } from 'node:http';
import { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';

const OPEN = 1,
  DATA = 2,
  END = 3,
  CLOSE = 4;
const MAX_BUFFERED = 4 * 1024 * 1024;
const disconnected = () => new Error('Host disconnected');

class TunnelStream extends Duplex {
  remoteClosed = false;
  constructor(
    readonly id: number,
    private readonly tunnel: DockerTunnel,
  ) {
    super({ allowHalfOpen: true });
  }
  override _read(): void {
    this.tunnel.resume(this.id);
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.tunnel.send(DATA, this.id, chunk).then(() => done(), done);
  }
  override _final(done: (error?: Error | null) => void): void {
    this.tunnel.send(END, this.id).then(() => done(), done);
  }
  override _destroy(error: Error | null, done: (error: Error | null) => void): void {
    this.tunnel.remove(this.id);
    if (!this.remoteClosed) void this.tunnel.send(CLOSE, this.id, error ? Buffer.from(error.message) : undefined).catch(() => {});
    done(error);
  }
  // HTTP clients expect the socket methods also provided by docker-modem's SSH stream.
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setTimeout(ms: number, callback?: () => void): this {
    if (callback) this.once('timeout', callback);
    if (ms) {
      const timer = setTimeout(() => this.emit('timeout'), ms);
      timer.unref();
      this.once('close', () => clearTimeout(timer));
    }
    return this;
  }
}

/** Raw Docker socket connections multiplexed over one Controller WebSocket. */
export class DockerTunnel {
  readonly agent = new Agent({ keepAlive: false });
  private nextId = 1;
  private readonly streams = new Map<number, TunnelStream>();
  private readonly paused = new Set<number>();
  private closed = false;
  constructor(private readonly socket: WebSocket) {
    this.agent.createConnection = () => {
      if (this.closed) throw disconnected();
      const id = this.nextId++;
      if (this.nextId > 0xffffffff) this.nextId = 1;
      const stream = new TunnelStream(id, this);
      stream.on('error', () => {});
      this.streams.set(id, stream);
      void this.send(OPEN, id).catch((err) => stream.destroy(err));
      return stream;
    };
    socket.on('message', (raw, binary) => {
      if (!binary) return;
      const frame = Buffer.from(raw as Buffer);
      if (frame.length < 5) {
        this.close();
        return;
      }
      const op = frame[0],
        id = frame.readUInt32BE(1),
        payload = frame.subarray(5);
      const stream = this.streams.get(id);
      if (!stream) return;
      if (op === DATA) {
        if (!stream.push(payload)) {
          this.paused.add(id);
          socket.pause();
        }
      } else if (op === END) stream.push(null);
      else if (op === CLOSE) {
        stream.remoteClosed = true;
        if (payload.length) stream.destroy(new Error(payload.toString()));
        else {
          stream.push(null);
          stream.end();
        }
      }
    });
    socket.once('close', () => this.close());
    socket.once('error', () => this.close());
  }
  createClient(): Docker {
    const options = { host: 'http://docker.tunnel', agent: this.agent };
    return new Docker(options);
  }
  async send(op: number, id: number, payload: Buffer = Buffer.alloc(0)): Promise<void> {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) throw disconnected();
    // Bound frames as well as the WebSocket queue for streamed build uploads.
    for (let offset = 0; offset < Math.max(payload.length, 1); offset += 64 * 1024) {
      while (this.socket.bufferedAmount > MAX_BUFFERED) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (this.closed) throw disconnected();
      }
      const header = Buffer.allocUnsafe(5);
      header[0] = op;
      header.writeUInt32BE(id, 1);
      await new Promise<void>((resolve, reject) =>
        this.socket.send(Buffer.concat([header, payload.subarray(offset, offset + 64 * 1024)]), (err) =>
          err ? reject(disconnected()) : resolve(),
        ),
      );
    }
  }
  resume(id: number): void {
    this.paused.delete(id);
    if (!this.paused.size) this.socket.resume();
  }
  remove(id: number): void {
    this.streams.delete(id);
    this.resume(id);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams.values()) {
      stream.remoteClosed = true;
      stream.destroy(disconnected());
    }
    this.streams.clear();
    this.agent.destroy();
  }
}
