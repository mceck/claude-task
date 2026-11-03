// A Worktree's uncommitted changes, read on demand from a Worker Container's Runner with
// `worktree.status.request` (docs/specs/git-integration.md). The answer is small, so it comes
// back over the same WebSocket as the request.
import { randomUUID } from 'node:crypto';
import type { WorktreeFile, WorktreeStatusError } from '@claude-task/shared';
import type { RunnerHub } from './hub';

/** How long the Changes dialog waits for a Runner to run `git status`. */
export const WORKTREE_STATUS_TIMEOUT_MS = 5000;

export interface WorktreeStatusAnswer {
  files: WorktreeFile[];
  total: number;
  truncated: boolean;
  error: WorktreeStatusError | null;
}

interface Pending {
  containerId: string;
  resolve: (answer: WorktreeStatusAnswer | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Reads a Worktree on demand. A request that isn't answered in time yields null, so the view
 * falls back to the last answer kept on the Session.
 */
export class WorktreeStatusRequests {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly runners: RunnerHub,
    private readonly timeoutMs = WORKTREE_STATUS_TIMEOUT_MS,
  ) {}

  request(containerId: string, worktreePath: string): Promise<WorktreeStatusAnswer | null> {
    if (!this.runners.isReady(containerId)) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise<WorktreeStatusAnswer | null>((resolve) => {
      const settle = (answer: WorktreeStatusAnswer | null) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(answer);
      };
      const timer = setTimeout(() => settle(null), this.timeoutMs);
      this.pending.set(requestId, { containerId, resolve, timer });
      if (!this.runners.send(containerId, { type: 'worktree.status.request', requestId, worktreePath })) settle(null);
    });
  }

  /** The Runner's answer; an unknown request id (a late one) is ignored. */
  settle(containerId: string, requestId: string, answer: WorktreeStatusAnswer): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.containerId !== containerId) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(answer);
  }
}
