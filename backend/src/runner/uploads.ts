// Files an Agent posts through a Task Tool: the backend asks the Agent's Runner with `job.upload`
// and waits for the Runner's multipart POST to the upload endpoint (docs/specs/runner.md).
import { randomUUID } from 'node:crypto';
import { RUNNER_UPLOADS_PATH } from '@claude-task/shared';
import type { UploadManifestEntry } from '@claude-task/shared';
import type { NewAttachment } from '../modules/comments/service';
import { badRequest } from '../errors';
import type { RunnerHub } from './hub';

/** How long a tool call waits for the Runner's upload, from the request to the last byte. */
export const UPLOAD_TIMEOUT_MS = 60_000;

export interface UploadedFiles {
  /** One entry per requested path, in order. */
  manifest: UploadManifestEntry[];
  /** The stored files of the successful entries, in order. */
  files: NewAttachment[];
}

interface Pending {
  agentId: string;
  jobId: string;
  paths: string[];
  /** Set once the Runner's POST arrived; the deadline still applies while it streams. */
  taken: boolean;
  resolve: (result: UploadedFiles) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** The pending request a Runner's POST answers. `complete` and `fail` return false once the tool call gave up. */
export interface TakenUpload {
  jobId: string;
  paths: string[];
  complete: (result: UploadedFiles) => boolean;
  fail: (message: string) => void;
}

export class UploadRequests {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly runners: RunnerHub,
    private readonly backendUrl: string,
    private readonly timeoutMs = UPLOAD_TIMEOUT_MS,
  ) {}

  /**
   * Asks the Runner for the files and waits for them. Rejects with a message for the model when
   * the Runner isn't connected or the upload doesn't finish in time.
   */
  request(agentId: string, jobId: string, paths: string[]): Promise<UploadedFiles> {
    const requestId = randomUUID();
    return new Promise<UploadedFiles>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(badRequest(`Could not collect the files: the runner did not upload them within ${Math.round(this.timeoutMs / 1000)} seconds.`));
      }, this.timeoutMs);
      this.pending.set(requestId, { agentId, jobId, paths, taken: false, resolve, reject, timer });
      const sent = this.runners.send(agentId, {
        type: 'job.upload',
        jobId,
        requestId,
        url: `${this.backendUrl}${RUNNER_UPLOADS_PATH}/${requestId}`,
        files: paths.map((path) => ({ path })),
      });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(badRequest('Could not collect the files: the runner is not connected. Try again in a moment.'));
      }
    });
  }

  /** Takes the pending request for this Runner's upload, or null when there is none (or it was taken). */
  take(agentId: string, requestId: string): TakenUpload | null {
    const pending = this.pending.get(requestId);
    if (!pending || pending.agentId !== agentId || pending.taken) return null;
    pending.taken = true;
    const settle = () => {
      if (this.pending.get(requestId) !== pending) return false;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      return true;
    };
    return {
      jobId: pending.jobId,
      paths: pending.paths,
      complete: (result) => settle() && (pending.resolve(result), true),
      fail: (message) => {
        if (settle()) pending.reject(badRequest(`Could not collect the files: ${message}`));
      },
    };
  }
}
