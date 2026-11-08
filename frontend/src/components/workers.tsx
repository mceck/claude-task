import type { Worker, WorkerContainerState, WorkerState } from '@claude-task/shared';
import { Link } from 'react-router';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { errorMessage } from '../api/client';
import { useMe, useWorkers } from '../api/queries';
import { StateDot } from './agents';
import { ErrorText } from './common';

const WORKER_STATE_LABEL: Record<WorkerState, string> = {
  idle: 'Idle',
  working: 'Working',
  offline: 'Offline',
  host_offline: 'Host offline',
  disabled: 'Disabled',
  building: 'Building',
  build_failed: 'Build failed',
};

/** Next to a Worker in a picker: the same palette as the Agent and Session dots. */
export function WorkerStateDot({ worker }: { worker: { state: WorkerState } }) {
  return <StateDot state={worker.state} className="shrink-0 ring-0" />;
}

export function WorkerStateBadge({ state }: { state: WorkerState }) {
  const tone =
    state === 'working'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : state === 'build_failed'
        ? 'border-red-500/30 bg-red-500/10 text-red-400'
        : state === 'building'
          ? 'border-sky-500/30 bg-sky-500/10 text-sky-400'
          : 'border-border bg-muted/40 text-muted-foreground';
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium', tone)}>
      <StateDot state={state} className="size-1.5 ring-0" />
      {WORKER_STATE_LABEL[state]}
    </span>
  );
}

const CONTAINER_DOT: Record<WorkerContainerState, string> = { stopped: 'offline', starting: 'pending', idle: 'idle', working: 'working' };
const CONTAINER_LABEL: Record<WorkerContainerState, string> = { stopped: 'Stopped', starting: 'Starting', idle: 'Idle', working: 'Working' };

export function ContainerStateBadge({ state }: { state: WorkerContainerState }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium text-muted-foreground">
      <StateDot state={CONTAINER_DOT[state]} className="size-1.5 ring-0" />
      {CONTAINER_LABEL[state]}
    </span>
  );
}

/** The Worker to preselect: the only one, when exactly one exists. */
export function defaultWorkerId(workers: Worker[] | undefined): string {
  return workers?.length === 1 ? workers[0]!.id : '';
}

/** Shown instead of the picker on an installation without Workers. */
export function NoWorkerNotice() {
  const admin = useMe().data?.role === 'admin';
  return (
    <p role="status" className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      {admin ? (
        <>
          <Link to="/workers" className="underline">
            Create a Worker first
          </Link>
          : it runs the agents of this project.
        </>
      ) : (
        'Ask an Admin to create a Worker: it runs the agents of this project.'
      )}
    </p>
  );
}

/**
 * Picks a Worker with its state dot. Renders the "no Worker" notice instead when none exists; callers disable
 * submission while `value` is empty.
 */
export function WorkerPicker({
  id,
  value,
  onChange,
  disabled,
  label = 'Worker',
  className,
}: {
  id?: string;
  value: string;
  onChange: (workerId: string) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const workers = useWorkers();
  if (workers.error) return <ErrorText>{errorMessage(workers.error)}</ErrorText>;
  if (workers.data?.length === 0) return <NoWorkerNotice />;
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled || workers.isPending}>
      <SelectTrigger id={id} aria-label={label} className={cn('w-full', className)}>
        <SelectValue placeholder={workers.isPending ? 'Loading workers…' : 'Choose a worker'} />
      </SelectTrigger>
      <SelectContent>
        {(workers.data ?? []).map((w) => (
          <SelectItem key={w.id} value={w.id}>
            {w.name} <WorkerStateDot worker={w} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
