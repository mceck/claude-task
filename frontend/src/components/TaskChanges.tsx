import type { TaskWorktreeStatus, WorktreeFile, WorktreeFileStatus } from '@claude-task/shared';
import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { errorMessage, get } from '../api/client';
import { Loading, Time } from './common';

const STATUS: Record<WorktreeFileStatus, { letter: string; className: string; label: string }> = {
  modified: { letter: 'M', className: 'text-amber-500', label: 'Modified' },
  added: { letter: 'A', className: 'text-emerald-500', label: 'Added' },
  deleted: { letter: 'D', className: 'text-red-500', label: 'Deleted' },
  renamed: { letter: 'R', className: 'text-sky-400', label: 'Renamed' },
  copied: { letter: 'C', className: 'text-sky-400', label: 'Copied' },
  'type-changed': { letter: 'T', className: 'text-amber-500', label: 'Type changed' },
  untracked: { letter: 'U', className: 'text-emerald-500', label: 'Untracked' },
  conflicted: { letter: 'C', className: 'text-red-500', label: 'Conflict' },
};

/** Extension colours, so a glance reads like an editor's file tree. */
const EXTENSION: Record<string, string> = {
  TS: 'text-sky-400',
  TSX: 'text-sky-400',
  JS: 'text-amber-300',
  JSX: 'text-amber-300',
  JSON: 'text-yellow-400',
  MD: 'text-slate-300',
  CSS: 'text-violet-400',
  GO: 'text-cyan-400',
  PY: 'text-emerald-400',
  RS: 'text-orange-400',
  YML: 'text-pink-400',
  YAML: 'text-pink-400',
  SH: 'text-emerald-400',
};

function pathParts(path: string): { name: string; dir: string; extension: string } {
  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dir = slash === -1 ? '' : path.slice(0, slash);
  const dot = name.lastIndexOf('.');
  return { name, dir, extension: dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : '' };
}

const EMPTY_STATE: Record<NonNullable<TaskWorktreeStatus['reason']>, string> = {
  'no-session': 'This task has no agent session yet.',
  'no-repository': 'This project has no repository, so its worktree has no git changes.',
  'no-worktree': 'The task has no worktree yet.',
  'no-runner': 'The task’s worker isn’t running, so the changes can’t be read right now.',
  error: 'The changes couldn’t be read.',
};

/** The Changes dialog of a Task: the uncommitted files of its Worktree (docs/specs/git-integration.md). */
export function TaskChangesDialog({ taskId, open, onOpenChange }: { taskId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [data, setData] = useState<TaskWorktreeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read on every open: the Worktree changes only while a Job runs.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setData(null);
    setError(null);
    get<{ status: TaskWorktreeStatus }>(`/tasks/${taskId}/worktree-status`)
      .then(({ status }) => !cancelled && setData(status))
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, taskId]);

  const status = data?.status ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Changes
            {status && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">{status.total}</span>
            )}
          </DialogTitle>
          <DialogDescription>The uncommitted changes in this task’s worktree.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <Loading className="p-6" />
        ) : error ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">{error}</p>
        ) : !status ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">{EMPTY_STATE[data?.reason ?? 'error']}</p>
        ) : status.files.length === 0 ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">No uncommitted changes.</p>
        ) : (
          <>
            <ul className="-mx-1 max-h-[60vh] overflow-auto">
              {status.files.map((file) => (
                <FileRow key={file.path} file={file} />
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {status.truncated && `Showing the first ${status.files.length} of ${status.total} changes. `}
              {data?.live ? (
                'Read just now.'
              ) : (
                <>
                  Last read <Time iso={status.capturedAt} />
                  {data?.reason === 'no-runner' ? ', with the worker stopped' : ''}.
                </>
              )}
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FileRow({ file }: { file: WorktreeFile }) {
  const { name, dir, extension } = pathParts(file.path);
  const state = STATUS[file.status];
  return (
    <li title={file.path} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted/50">
      {extension ? (
        <span className={cn('w-6 shrink-0 text-center font-mono text-[10px] font-semibold', EXTENSION[extension] ?? 'text-muted-foreground')}>
          {extension}
        </span>
      ) : (
        <FileText className="mx-1 size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0 truncate">{name}</span>
      {dir && <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span>}
      <span className={cn('ml-auto w-5 shrink-0 text-right font-mono text-xs font-semibold', state.className)} title={state.label}>
        {state.letter}
      </span>
    </li>
  );
}
