import type { GitProvider } from './git/provider';
import type { GitSync } from './git/sync';
import type { RealtimeEvent, Topic } from '@claude-task/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentRuntime } from './agents/runtime';
import type { Scheduler } from './agents/scheduler';
import type { BlobStore } from './blobstore';
import type { Config } from './config';
import type { Db, Tx } from './db/client';
import type { RealtimeHub } from './realtime/hub';
import type { RunnerHub } from './runner/hub';

export interface AppContext {
  config: Config;
  db: Db;
  hub: RealtimeHub;
  blobs: BlobStore;
  runtime: AgentRuntime;
  git: GitProvider;
  gitSync: GitSync;
  /** Connected Runners, one per Agent. */
  runners: RunnerHub;
  /** Dispatcher, builds and the container reconciler. */
  scheduler: Scheduler;
  log: FastifyBaseLogger;
}

/**
 * Collects what must happen only once the transaction has committed: real-time events,
 * messages to Runners, and cleanup like deleting blobs. Nothing runs if the transaction rolls back.
 */
export class AfterCommit {
  readonly events: { topic: Topic; event: RealtimeEvent }[] = [];
  readonly tasks: (() => Promise<void>)[] = [];
  readonly effects: ((ctx: AppContext) => void)[] = [];

  /** The app, for transaction code that needs config, Runners or blobs. */
  constructor(readonly ctx: AppContext) {}

  emit(topic: Topic, event: RealtimeEvent): void {
    this.events.push({ topic, event });
  }

  run(task: () => Promise<void>): void {
    this.tasks.push(task);
  }

  /** Runs right after commit, in order, e.g. sending a message to a Runner or kicking the dispatcher. */
  effect(fn: (ctx: AppContext) => void): void {
    this.effects.push(fn);
  }
}

export async function transact<T>(
  ctx: AppContext,
  fn: (tx: Tx, after: AfterCommit) => Promise<T>,
): Promise<T> {
  const after = new AfterCommit(ctx);
  const result = await ctx.db.transaction((tx) => fn(tx, after));
  for (const { topic, event } of after.events) ctx.hub.publish(topic, event);
  for (const effect of after.effects) {
    try {
      effect(ctx);
    } catch (err) {
      ctx.log.error(err, 'after-commit effect failed');
    }
  }
  // Best-effort cleanup (an orphaned blob is harmless), so the response doesn't wait for it.
  if (after.tasks.length > 0) void Promise.allSettled(after.tasks.map((task) => task()));
  return result;
}

const RETRYABLE = new Set(['40P01', '40001']);

/** For background work (dispatching, Runner messages): retries deadlocks and serialization failures. */
export async function transactWithRetry<T>(
  ctx: AppContext,
  fn: (tx: Tx, after: AfterCommit) => Promise<T>,
  attempts = 5,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await transact(ctx, fn);
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (i >= attempts || !code || !RETRYABLE.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 10 * i + Math.random() * 20));
    }
  }
}
