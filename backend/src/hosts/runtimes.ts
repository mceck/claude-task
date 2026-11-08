import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { workers } from '../db/schema';
import type { WorkerRuntime } from '../agents/runtime';
import { conflict } from '../errors';

/** A disconnected control path must never fall back to another machine's daemon. */
export class RuntimeRegistry {
  private readonly runtimes = new Map<string, WorkerRuntime>();
  private readonly signals = new Map<string, AbortController>();
  private readonly offline = new Set<string>();
  constructor(private readonly db: Db) {}
  attach(hostId: string, runtime: WorkerRuntime): void { this.signals.get(hostId)?.abort(); this.signals.set(hostId, new AbortController()); this.runtimes.set(hostId, runtime); this.offline.delete(hostId); }
  detach(hostId: string): void { this.signals.get(hostId)?.abort(); this.signals.delete(hostId); this.runtimes.delete(hostId); }
  has(hostId: string): boolean { return this.runtimes.has(hostId) && !this.offline.has(hostId); }
  get(hostId: string): WorkerRuntime {
    const runtime = this.runtimes.get(hostId);
    if (!runtime || this.offline.has(hostId)) throw conflict('Host disconnected');
    return runtime;
  }
  entries(): [string, WorkerRuntime][] { return [...this.runtimes.entries()].filter(([id]) => this.has(id)); }
  probe(hostId: string): WorkerRuntime { const runtime = this.runtimes.get(hostId); if (!runtime) throw conflict('Host disconnected'); return runtime; }
  setConnected(id: string, connected: boolean): void {
    if (connected) { this.offline.delete(id); if (this.signals.get(id)?.signal.aborted) this.signals.set(id, new AbortController()); }
    else { this.offline.add(id); this.signals.get(id)?.abort(); }
  }
  async forWorker(workerId: string): Promise<WorkerRuntime> {
    const [worker] = await this.db.select({ hostId: workers.hostId }).from(workers).where(eq(workers.id, workerId));
    if (!worker) throw conflict('Worker no longer exists');
    return this.get(worker.hostId);
  }
  async run<T>(hostId: string, action: () => Promise<T>): Promise<T> {
    this.get(hostId);
    const signal = this.signals.get(hostId)!.signal;
    let abort!: () => void;
    const dropped = new Promise<never>((_resolve, reject) => { abort = () => reject(conflict('Host disconnected')); signal.addEventListener('abort', abort, { once: true }); });
    try { return await Promise.race([action(), dropped]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  clear(): void { for (const signal of this.signals.values()) signal.abort(); this.signals.clear(); this.runtimes.clear(); this.offline.clear(); }
}
