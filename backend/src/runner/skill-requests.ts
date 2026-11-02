// The Worktree's Project Skills before the next Job: the backend asks the Worker Container's Runner with
// `project_skills.request` and waits for the answer over the same socket (docs/specs/runner.md).
import { randomUUID } from 'node:crypto';
import type { ProjectSkillFile } from '@claude-task/shared';
import type { RunnerHub } from './hub';

/** How long a Session view waits for the Runner to read the Worktree. */
export const PROJECT_SKILLS_TIMEOUT_MS = 1500;
/** A Runner that didn't answer (an older one, which ignores the message) isn't asked again this soon. */
export const PROJECT_SKILLS_RETRY_MS = 5 * 60_000;

interface Pending {
  containerId: string;
  resolve: (files: ProjectSkillFile[] | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Reads a Session's Project Skills on demand, from the Worktree its Runner created, so the
 * composer can suggest them before the Session's next Job. A request that isn't answered in time
 * yields null: the view falls back to what the latest Job reported, if anything.
 */
export class ProjectSkillRequests {
  private readonly pending = new Map<string, Pending>();
  /** Worker Containers whose Runner ignored a request recently, so each view doesn't wait for the timeout. */
  private readonly quiet = new Map<string, number>();

  constructor(
    private readonly runners: RunnerHub,
    private readonly timeoutMs = PROJECT_SKILLS_TIMEOUT_MS,
    private readonly retryMs = PROJECT_SKILLS_RETRY_MS,
  ) {}

  /** The files the Runner read, or null when it isn't connected, doesn't answer, or is quiet. */
  request(containerId: string, worktreePath: string): Promise<ProjectSkillFile[] | null> {
    if (!this.runners.isReady(containerId) || (this.quiet.get(containerId) ?? 0) > Date.now()) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise<ProjectSkillFile[] | null>((resolve) => {
      const settle = (files: ProjectSkillFile[] | null) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(files);
      };
      const timer = setTimeout(() => {
        this.quiet.set(containerId, Date.now() + this.retryMs);
        settle(null);
      }, this.timeoutMs);
      this.pending.set(requestId, { containerId, resolve, timer });
      if (!this.runners.send(containerId, { type: 'project_skills.request', requestId, worktreePath })) settle(null);
    });
  }

  /** The Runner's answer; an unknown request id (a late one) is ignored. */
  settle(containerId: string, requestId: string, files: ProjectSkillFile[] | null): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.containerId !== containerId) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (files) this.quiet.delete(containerId);
    pending.resolve(files);
  }
}
