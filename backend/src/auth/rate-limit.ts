/**
 * Fixed-window counter of failed attempts per key, kept in memory. The backend is a
 * single process, so this is enough to slow down password guessing.
 */
export class AttemptLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly options: { max: number; windowMs: number }) {}

  /** Seconds until the key may try again, or 0 if it's not blocked. */
  retryAfter(key: string, now = Date.now()): number {
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now || w.count < this.options.max) return 0;
    return Math.ceil((w.resetAt - now) / 1000);
  }

  fail(key: string, now = Date.now()): void {
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.options.windowMs });
      this.prune(now);
    } else {
      w.count++;
    }
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  private prune(now: number) {
    if (this.windows.size < 10_000) return;
    for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
  }
}
