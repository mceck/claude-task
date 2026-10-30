// The Runner Protocol: JSON messages over the WebSocket between the Runner inside an
// Agent Container and the backend. Versioned together with the Base Image; the Go
// runner (runner/internal/protocol) mirrors these shapes.
import type { PermissionMode } from './agents';

export const RUNNER_PROTOCOL_VERSION = 3;
/** WebSocket path, authenticated with `Authorization: Bearer <runner token>`. */
export const RUNNER_WS_PATH = '/api/v1/runner';
/** Attachment downloads for the Runner, same bearer token: `${RUNNER_ATTACHMENTS_PATH}/<attachmentId>`. */
export const RUNNER_ATTACHMENTS_PATH = '/api/v1/runner/attachments';
/**
 * Uploads of files an Agent posts, same bearer token: `${RUNNER_UPLOADS_PATH}/<requestId>`, one
 * multipart POST with a `manifest` field (`UploadManifestEntry[]`) then one `file` part per success.
 */
export const RUNNER_UPLOADS_PATH = '/api/v1/runner/uploads';
/** Git Proxy (smart HTTP): `${GIT_PROXY_PATH}/<projectId>.git`, Basic auth with the Job token as password. */
export const GIT_PROXY_PATH = '/git';
/** Streamable HTTP MCP endpoint for Task Tools, authenticated with the Job token. */
export const MCP_PATH = '/api/v1/mcp';

/** A stream-json user message content block, as written to `claude`'s stdin. */
export type InputBlock = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface AttachmentToFetch {
  /** Absolute URL; fetch with the runner token as bearer. */
  url: string;
  /** Destination relative to the Worktree, e.g. `.claude-task/attachments/<commentId>/log.txt`. */
  path: string;
}

/** The repository to prepare the Worktree from (docs/specs/git-integration.md). Null when the Project has none. */
export interface GitSpec {
  /** The Git Proxy URL of the Project, without credentials (a file URL in tests). */
  cloneUrl: string;
  /** Git Proxy password for `cloneUrl`: the Job token. Served only by the credential helper. */
  token: string;
  /**
   * Stable identity of the Repository behind `cloneUrl` (`<connectionId>/<providerRepoId>`): the
   * proxy URL stays the same when a Project changes Repository, so the bare clone is kept or
   * discarded by this, not by the URL.
   */
  repositoryId: string;
  baseBranch: string;
  taskBranch: string;
  /** Hint only: whether `origin/<taskBranch>` is expected to exist. */
  branchExists: boolean;
  /** Bare clone, relative to the Agent's home: `repos/<projectId>.git`. */
  repoPath: string;
  commitName: string;
  commitEmail: string;
}

export interface ClaudeArgs {
  /** `--model`; null keeps the CLI default. */
  model: string | null;
  /** `--effort`; null keeps the CLI default. */
  effort: string | null;
  permissionMode: PermissionMode;
  /** `--append-system-prompt`. */
  appendSystemPrompt: string;
  /** `--mcp-config`, a JSON string. */
  mcpConfig: string;
  /** `--disallowedTools <name>`, one per tool. */
  disallowedTools: string[];
  /**
   * The Run transcript needs the subagent's text, which the CLI only forwards with
   * `--forward-subagent-text` (from its 2.1.211). The Runner adds the flag when the `claude`
   * it is about to spawn supports it.
   */
  forwardSubagentText: boolean;
}

/** One requested path in an upload's manifest, in request order; `error` when it failed. */
export interface UploadManifestEntry {
  path: string;
  error?: string;
}

export type JobFailureStage = 'worktree' | 'setup' | 'spawn';

// Backend → Runner

export interface JobStartMessage {
  type: 'job.start';
  jobId: string;
  /** Also the Claude Code session id. */
  sessionId: string;
  /** `new` spawns with `--session-id`, `resume` with `--resume`. */
  mode: 'new' | 'resume';
  /** Sets `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` (already present in `env` too). */
  resumeInterrupted: boolean;
  /** Relative to the Agent's home, deterministic per (Project, Task): `worktrees/<projectId>/<taskKey>`. */
  worktreePath: string;
  git: GitSpec | null;
  /** Runs with `bash -lc` in the Worktree only when the Worktree was just created. Empty = none. */
  setupScript: string;
  /** Merged environment for `claude`: Project env, the Credential, flags. Contains secrets. */
  env: Record<string, string>;
  claudeArgs: ClaudeArgs;
  /** The first user message; null writes nothing. */
  initialMessage: InputBlock[] | null;
  /** Fetched into the Worktree before the initial message is written. */
  attachmentsToFetch: AttachmentToFetch[];
}

export type BackendToRunner =
  | JobStartMessage
  /** Write a user message to stdin (attachments are fetched first). */
  | { type: 'job.input'; jobId: string; message: InputBlock[]; attachmentsToFetch: AttachmentToFetch[] }
  /** Interrupt the current Turn (stream-json `control_request` interrupt); the process keeps running. */
  | { type: 'job.interrupt'; jobId: string }
  /** Close stdin: `claude` finishes what was already written, then exits. */
  | { type: 'job.end'; jobId: string }
  /** Interrupt, close stdin, SIGTERM after 10 s, SIGKILL after 20 s. */
  | { type: 'job.cancel'; jobId: string }
  /**
   * Upload files the Agent posts through a Task Tool: POST them to `url` (see `RUNNER_UPLOADS_PATH`).
   * A request outside the Job's stream: no seq, no ack; paths are relative to the Worktree or absolute.
   */
  | { type: 'job.upload'; jobId: string; requestId: string; url: string; files: { path: string }[] }
  /** Remove a Worktree directory (never the branch). Paths relative to the Agent's home. */
  | { type: 'worktree.remove'; worktreePath: string; repoPath: string | null }
  /** Everything the Runner sent for this Job up to and including `seq` is processed. */
  | { type: 'ack'; jobId: string; seq: number }
  | { type: 'ping' };

// Runner → Backend

/**
 * Every Job-scoped message carries `seq`: one counter per Job, starting at 1, shared by all
 * message types, so the backend processes them exactly once and in order. Unacked messages
 * are resent after a reconnect.
 */
export type RunnerJobMessage =
  | { type: 'job.worktree_ready'; jobId: string; seq: number; created: boolean; remoteBranchMissing: boolean }
  | { type: 'job.accepted'; jobId: string; seq: number }
  /** Worktree preparation and Setup Script output. */
  | { type: 'job.setup_output'; jobId: string; seq: number; chunk: string }
  /** One raw stdout line of `claude` (stream-json). */
  | { type: 'job.event'; jobId: string; seq: number; line: string }
  | { type: 'job.stderr'; jobId: string; seq: number; chunk: string }
  /** The previous `job.event` was a `result` line. */
  | { type: 'job.result'; jobId: string; seq: number; eventSeq: number }
  | { type: 'job.exited'; jobId: string; seq: number; exitCode: number | null; signal: string | null }
  | { type: 'job.failed'; jobId: string; seq: number; stage: JobFailureStage; message: string };

export type RunnerToBackend =
  | {
      type: 'hello';
      protocolVersion: number;
      runnerVersion: string;
      claudeVersion: string;
      /** The Job whose process is running or whose messages aren't all acked yet. */
      activeJobId: string | null;
    }
  | RunnerJobMessage
  | { type: 'pong' };
