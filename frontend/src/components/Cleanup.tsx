import type { Cleanup, CleanupCounts } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Eraser, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorMessage, post } from '../api/client';
import { keys, useCleanup } from '../api/queries';
import { ErrorText, Time } from './common';

const WHAT_IT_REMOVES = [
  'Base Images of older platform versions',
  'Untagged images left by builds',
  'Older images of each worker that no container uses, and stopped containers still on one (recreated at their next start, with their volumes)',
  'Slots above a worker’s cap, with their service data',
  'Containers, volumes and images left by deleted workers',
  'Repositories of projects that no longer run on a worker, and the profiles of deleted agents',
];

const COUNT_LABELS: Record<keyof CleanupCounts, string> = {
  baseImages: 'old base images',
  workerImages: 'worker images',
  danglingImages: 'untagged images',
  orphanContainers: 'leftover containers',
  orphanVolumes: 'leftover volumes',
  orphanImages: 'leftover images',
  slots: 'slots above the cap',
  bareClones: 'project repositories',
  agentProfiles: 'agent profiles',
};

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The Workers list's "Clean up" action: confirmation, then the live result. */
export function CleanupButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const latest = useCleanup(true).data;
  const cleanup = startedId && latest?.id === startedId ? latest : null;

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const { cleanup } = await post<{ cleanup: Cleanup }>('/cleanup', {});
      // Its own live events may have arrived first, with a later state.
      qc.setQueryData<Cleanup | null>(keys.cleanup, (current) => (current?.id === cleanup.id && (current.finishedAt || !cleanup.finishedAt) ? current : cleanup));
      setStartedId(cleanup.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setStartedId(null);
          setError(null);
          setOpen(true);
        }}
      >
        <Eraser /> Clean up
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Clean up</DialogTitle>
            <DialogDescription>
              {startedId ? 'Freeing the space the workers no longer need.' : 'Frees the space the workers no longer need. It removes:'}
            </DialogDescription>
          </DialogHeader>
          {startedId ? (
            cleanup ? (
              <CleanupResult cleanup={cleanup} />
            ) : (
              <Loader2 className="size-4 animate-spin" />
            )
          ) : (
            <div className="space-y-3 text-sm">
              <ul className="list-disc space-y-1 pl-5">
                {WHAT_IT_REMOVES.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                Images, containers and volumes in use stay, and so does everything another installation on the same Docker host created.
              </p>
            </div>
          )}
          {error && <ErrorText>{error}</ErrorText>}
          <DialogFooter>
            {startedId ? (
              <Button onClick={() => setOpen(false)}>Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={start} disabled={starting}>
                  Clean up
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CleanupResult({ cleanup }: { cleanup: Cleanup }) {
  const counts = (Object.keys(COUNT_LABELS) as (keyof CleanupCounts)[]).filter((key) => cleanup.removed[key] > 0);
  return (
    <div className="space-y-3 text-sm" aria-label="Cleanup result">
      {!cleanup.finishedAt ? (
        <p className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Cleaning up…
        </p>
      ) : (
        <p>
          About <strong>{formatBytes(cleanup.reclaimedBytes)}</strong> freed.
        </p>
      )}
      {counts.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5">
          {counts.map((key) => (
            <li key={key}>
              {cleanup.removed[key]} {COUNT_LABELS[key]}
            </li>
          ))}
        </ul>
      ) : (
        cleanup.finishedAt && <p className="text-muted-foreground">Nothing to remove so far.</p>
      )}
      {cleanup.volumesPending > 0 && (
        <p className="text-muted-foreground">
          {cleanup.volumesPending === 1 ? '1 worker volume is' : `${cleanup.volumesPending} worker volumes are`} still to be cleaned, as soon as a container of
          {cleanup.volumesPending === 1 ? ' its worker' : ' their workers'} runs.
        </p>
      )}
      {cleanup.errors.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-destructive">{cleanup.errors.length === 1 ? '1 error' : `${cleanup.errors.length} errors`}</p>
          <ul className="max-h-40 space-y-1 overflow-y-auto font-mono text-xs text-muted-foreground">
            {cleanup.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One line under the Workers list header: the last Cleanup, automatic or manual. */
export function LastCleanup() {
  const cleanup = useCleanup(true).data;
  const [details, setDetails] = useState(false);
  if (!cleanup) return null;
  return (
    <div className="mb-6 text-sm text-muted-foreground" aria-label="Last cleanup">
      Last cleanup <Time iso={cleanup.startedAt} />
      {cleanup.trigger === 'automatic' ? ' (automatic)' : cleanup.requestedBy ? ` by ${cleanup.requestedBy.name}` : ''}
      {cleanup.finishedAt ? ` · about ${formatBytes(cleanup.reclaimedBytes)} freed` : ' · running…'}
      {cleanup.errors.length > 0 && (
        <>
          {' · '}
          <button type="button" className="text-destructive underline-offset-2 hover:underline" onClick={() => setDetails(true)}>
            {cleanup.errors.length === 1 ? '1 error' : `${cleanup.errors.length} errors`}
          </button>
        </>
      )}
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Last cleanup</DialogTitle>
            <DialogDescription>
              {new Date(cleanup.startedAt).toLocaleString()}, {cleanup.trigger === 'automatic' ? 'automatic' : `asked by ${cleanup.requestedBy?.name ?? 'an admin'}`}
            </DialogDescription>
          </DialogHeader>
          <CleanupResult cleanup={cleanup} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
