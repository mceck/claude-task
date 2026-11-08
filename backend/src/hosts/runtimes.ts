import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { workers } from '../db/schema';
import type { WorkerRuntime } from '../agents/runtime';
import { conflict } from '../errors';

/** A disconnected control path must never fall back to another machine's daemon. */
export class RuntimeRegistry {
  private readonly runtimes = new Map<string, WorkerRuntime>();
  constructor(private readonly db: Db) {}
  attach(hostId: string, runtime: WorkerRuntime): void { this.runtimes.set(hostId, runtime); }
  detach(hostId: string): void { this.runtimes.delete(hostId); }
  has(hostId: string): boolean { return this.runtimes.has(hostId); }
  get(hostId: string): WorkerRuntime {
    const runtime = this.runtimes.get(hostId);
    if (!runtime) throw conflict('Host disconnected');
    return runtime;
  }
  entries(): IterableIterator<[string, WorkerRuntime]> { return this.runtimes.entries(); }
  async forWorker(workerId: string): Promise<WorkerRuntime> {
    const [worker] = await this.db.select({ hostId: workers.hostId }).from(workers).where(eq(workers.id, workerId));
    if (!worker) throw conflict('Worker no longer exists');
    return this.get(worker.hostId);
  }
  clear(): void { this.runtimes.clear(); }
}
