// The uncommitted changes of a Task's Worktree: read on demand when its Changes dialog opens,
// and kept on the Session after every Job so the dialog works while the Worker's containers are
// stopped (docs/specs/git-integration.md).
import { WORKTREE_FILE_STATUSES } from '@claude-task/shared';
import type { TaskWorktreeStatus, WorktreeFile, WorktreeStatus } from '@claude-task/shared';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { projects, sessions, tasks } from '../db/schema';
import type { WorktreeStatusAnswer } from '../runner/worktree-status';

/** At most this many files come from one read; the Runner applies the same cap. */
const MAX_FILES = 1000;
/** A path longer than this is dropped: no real Worktree has one. */
const MAX_PATH = 4096;

/** The Runner's answer, made safe to store and show whatever the Runner sent. */
function snapshot(answer: WorktreeStatusAnswer): WorktreeStatus {
  const files: WorktreeFile[] = [];
  for (const file of Array.isArray(answer.files) ? answer.files : []) {
    if (files.length >= MAX_FILES) break;
    const path = typeof file?.path === 'string' ? file.path : '';
    if (!path || path.length > MAX_PATH || path.includes('\0')) continue;
    if (!WORKTREE_FILE_STATUSES.includes(file.status)) continue;
    files.push({ path, status: file.status });
  }
  const total = Number.isSafeInteger(answer.total) ? Math.max(answer.total, files.length) : files.length;
  return { capturedAt: new Date().toISOString(), files, total, truncated: answer.truncated === true || total > files.length };
}

/** Reads the Session's Worktree from a connected Runner and keeps the answer; a failure keeps the last one. */
export async function captureWorktreeStatus(ctx: AppContext, sessionId: string, worktreePath: string, containerId: string): Promise<void> {
  const answer = await ctx.worktreeStatus.request(containerId, worktreePath);
  if (!answer || answer.error) return;
  // A Task closed meanwhile has cleared the answer and is removing the Worktree: don't bring it back.
  await ctx.db
    .update(sessions)
    .set({ worktreeStatus: snapshot(answer) })
    .where(and(eq(sessions.id, sessionId), eq(sessions.worktreeRemovalPending, false)));
}

/** The Changes dialog: a live read when a Runner is connected, otherwise the last stored one. */
export async function taskWorktreeStatus(ctx: AppContext, taskId: string): Promise<TaskWorktreeStatus> {
  const [row] = await ctx.db
    .select({
      sessionId: sessions.id,
      worktreePath: sessions.worktreePath,
      lastSlot: sessions.lastSlot,
      stored: sessions.worktreeStatus,
      removalPending: sessions.worktreeRemovalPending,
      workerId: projects.workerId,
      repository: projects.repository,
    })
    .from(tasks)
    .innerJoin(sessions, eq(sessions.id, tasks.currentSessionId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));
  if (!row) return { status: null, live: false, reason: 'no-session' };
  if (!row.repository) return { status: row.stored ?? null, live: false, reason: 'no-repository' };
  // Closed: the Worktree is going away, and its last read was cleared with it.
  if (row.removalPending) return { status: null, live: false, reason: 'no-worktree' };

  // Any Runner of the Worker sees the shared Worker Volume; the Session's last slot first.
  const [containerId] = ctx.runners.forWorker(row.workerId, row.lastSlot);
  if (!containerId) return { status: row.stored ?? null, live: false, reason: 'no-runner' };
  const answer = await ctx.worktreeStatus.request(containerId, row.worktreePath);
  if (!answer) return { status: row.stored ?? null, live: false, reason: 'error' };

  if (answer.error === 'not-found' || answer.error === 'not-a-worktree') {
    // Not created yet, or removed with the Task closed: the stored read no longer applies.
    if (row.stored) await ctx.db.update(sessions).set({ worktreeStatus: null }).where(eq(sessions.id, row.sessionId));
    return { status: null, live: false, reason: 'no-worktree' };
  }
  if (answer.error) return { status: row.stored ?? null, live: false, reason: 'error' };

  const status = snapshot(answer);
  await ctx.db.update(sessions).set({ worktreeStatus: status }).where(eq(sessions.id, row.sessionId));
  return { status, live: true, reason: null };
}
