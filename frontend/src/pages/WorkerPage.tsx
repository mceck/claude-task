import { workerTopic } from '@claude-task/shared';
import type { QueueEntry, Worker, WorkerBuild, WorkerContainer } from '@claude-task/shared';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, GripVertical, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { del, errorMessage, get, patch, post } from '../api/client';
import { keys, useBuilds, useContainerLogs, useMe, useQueue, useWorker } from '../api/queries';
import { AgentAvatar } from '../components/agents';
import { ErrorText, Loading, LogView, Time, useConfirm } from '../components/common';
import { WorkerForm } from '../components/WorkerForm';
import { ContainerStateBadge, WorkerStateBadge } from '../components/workers';
import { useTopic } from '../lib/realtime';
import { NotFoundPage } from './NotFoundPage';

export function WorkerPage() {
  const { workerId } = useParams();
  const query = useWorker(workerId);
  useTopic(workerId ? workerTopic(workerId) : null);
  if (query.isPending) return <Loading className="h-full" />;
  if (!query.data)
    return query.error && (query.error as { status?: number }).status !== 404 ? (
      <ErrorText>{errorMessage(query.error)}</ErrorText>
    ) : (
      <NotFoundPage what="Worker" />
    );
  return <WorkerDetail key={query.data.id} worker={query.data} />;
}

function WorkerDetail({ worker }: { worker: Worker }) {
  const admin = useMe().data?.role === 'admin';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('containers');
  const refresh = async () => {
    await Promise.all([keys.workers, keys.worker(worker.id), keys.builds(worker.id)].map((key) => qc.invalidateQueries({ queryKey: key })));
  };
  const action = async (name: 'rebuild' | 'recreate') => {
    setBusy(true);
    try {
      const result = await post<{ worker: Worker }>(`/workers/${worker.id}/${name}`);
      qc.setQueryData(keys.worker(worker.id), result.worker);
      await refresh();
      toast.success(name === 'rebuild' ? 'Build started' : 'Each container is recreated as soon as it is free');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const duplicate = async () => {
    setBusy(true);
    try {
      const result = await post<{ worker: Worker }>(`/workers/${worker.id}/duplicate`, {});
      await qc.invalidateQueries({ queryKey: keys.workers });
      navigate(`/workers/${result.worker.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: `Delete ${worker.name}?`,
        description: 'Its containers, images, volumes and every Claude transcript on it are deleted. No project may use it.',
        confirmLabel: 'Delete worker',
        destructive: true,
      }))
    )
      return;
    try {
      await del(`/workers/${worker.id}`);
      await qc.invalidateQueries({ queryKey: keys.workers });
      navigate('/workers');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-8 py-8">
      <Button asChild variant="ghost" size="sm">
        <Link to="/workers">
          <ArrowLeft /> Workers
        </Link>
      </Button>
      <header className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{worker.name}</h1>
          <p className="text-sm text-muted-foreground">{worker.description}</p>
        </div>
        <WorkerStateBadge state={worker.state} />
      </header>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4 text-sm">
        <span>
          Containers: <b>{worker.busy}</b> busy · <b>{worker.running}</b> running · cap {worker.cap} · minimum {worker.minimum}
        </span>
        <span>{worker.queueLength} queued</span>
        <span>Image: {worker.imageState}</span>
        {worker.profileErrors.length > 0 && (
          <ul aria-label="Agent profile errors" className="w-full space-y-1">
            {worker.profileErrors.map((e) => (
              <li key={e.agentId} role="alert" className="text-destructive">
                <Link className="font-medium underline" to={`/agents/${e.agentId}`}>
                  {e.agentName}
                </Link>
                : {e.error}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <div className="flex w-full flex-wrap gap-2 border-t pt-3">
            <Button variant="outline" size="sm" disabled={busy || worker.state === 'building'} onClick={() => action('rebuild')}>
              Rebuild image
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => action('recreate')}>
              Recreate when idle
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={duplicate}>
              Duplicate
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto text-destructive" onClick={remove}>
              Delete
            </Button>
          </div>
        )}
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="containers">Containers</TabsTrigger>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="builds">Builds</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
        </TabsList>
        <TabsContent value="containers">
          <ContainersPanel worker={worker} admin={admin} />
        </TabsContent>
        <TabsContent value="queue">
          <QueuePanel workerId={worker.id} />
        </TabsContent>
        <TabsContent value="builds">
          <BuildsPanel workerId={worker.id} />
        </TabsContent>
        <TabsContent value="config">
          <div className="rounded-xl border bg-card p-5">
            {!admin && <p className="mb-4 text-sm text-muted-foreground">Only admins change a worker’s configuration.</p>}
            <WorkerForm
              key={worker.id}
              worker={worker}
              readOnly={!admin}
              onUpdate={async (body) => {
                const result = await patch<{ worker: Worker }>(`/workers/${worker.id}`, body);
                qc.setQueryData(keys.worker(worker.id), result.worker);
                await refresh();
                if (body.dockerfile !== undefined) toast.success('Docker configuration saved');
              }}
            />
          </div>
        </TabsContent>
        <TabsContent value="projects">
          <ProjectsPanel worker={worker} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ContainersPanel({ worker, admin }: { worker: Worker; admin: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<number | null>(null);
  const act = async (container: WorkerContainer, name: 'restart' | 'force-recreate') => {
    if (
      !(await confirm({
        title: name === 'restart' ? `Restart container ${container.slot}?` : `Force recreate container ${container.slot}?`,
        description: 'This interrupts its current job. Its session resumes after the runner reconnects.',
        confirmLabel: name === 'restart' ? 'Restart' : 'Force recreate',
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    try {
      const result = await post<{ worker: Worker }>(`/workers/${worker.id}/containers/${container.slot}/${name}`);
      qc.setQueryData(keys.worker(worker.id), result.worker);
      void qc.invalidateQueries({ queryKey: keys.workers });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3">
      <ul aria-label="Worker containers" className="divide-y rounded-lg border">
        {worker.containers.map((c) => (
          <li key={c.slot} aria-label={`Container ${c.slot}`} className="flex flex-wrap items-center gap-3 bg-card p-3 text-sm">
            <span className="w-20 font-medium">Slot {c.slot}</span>
            <ContainerStateBadge state={c.state} />
            <span className="text-xs text-muted-foreground">
              Docker: {c.containerState} · Runner {c.runnerConnected ? 'connected' : 'disconnected'}
              {c.claudeVersion ? ` · Claude ${c.claudeVersion}` : ''}
            </span>
            {c.job && (
              <span className="flex min-w-0 items-center gap-2">
                {c.job.agent && <AgentAvatar agent={c.job.agent} size="xs" />}
                <Link className="truncate underline" to={`/t/${c.job.task.key}`}>
                  {c.job.task.key} · {c.job.task.title}
                </Link>
                {c.job.agent && <span className="text-xs text-muted-foreground">{c.job.agent.name}</span>}
              </span>
            )}
            {c.lastActivityAt && (
              <span className="text-xs text-muted-foreground">
                Active <Time iso={c.lastActivityAt} />
              </span>
            )}
            {admin && (
              <span className="ml-auto flex gap-1">
                <Button variant="ghost" size="xs" disabled={busy} onClick={() => act(c, 'restart')}>
                  Restart
                </Button>
                <Button variant="ghost" size="xs" disabled={busy} onClick={() => act(c, 'force-recreate')}>
                  Force recreate
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setLogs(c.slot)}>
                  Logs
                </Button>
              </span>
            )}
            {c.recreatePending && (
              <p role="status" className="w-full text-xs text-amber-400">
                Recreation is waiting for the current job to finish.
              </p>
            )}
          </li>
        ))}
      </ul>
      <Dialog open={logs !== null} onOpenChange={(open) => !open && setLogs(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Container {logs} logs</DialogTitle>
            <DialogDescription>Latest 500 lines, refreshed every three seconds.</DialogDescription>
          </DialogHeader>
          {logs !== null && <ContainerLogs workerId={worker.id} slot={logs} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ContainerLogs({ workerId, slot }: { workerId: string; slot: number }) {
  const query = useContainerLogs(workerId, slot, true);
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  return <LogView label="Container logs">{query.data}</LogView>;
}

function QueuePanel({ workerId }: { workerId: string }) {
  const query = useQueue(workerId);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [busy, setBusy] = useState(false);
  const entries = query.data ?? [];
  const move = async (id: string, to: number) => {
    const other = entries.filter((e) => e.id !== id);
    setBusy(true);
    try {
      const result = await post<{ entries: QueueEntry[] }>(`/workers/${workerId}/queue/${id}/move`, { beforeEntryId: other[to]?.id ?? null });
      qc.setQueryData(keys.queue(workerId), result.entries);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id)
      void move(
        String(active.id),
        entries.findIndex((e) => e.id === over.id),
      );
  };
  const remove = async (entry: QueueEntry) => {
    if (
      !(await confirm({
        title: `Remove ${entry.task.key} from the queue?`,
        description: 'Pending comments will be marked not delivered.',
        confirmLabel: 'Remove',
      }))
    )
      return;
    setBusy(true);
    try {
      await del(`/workers/${workerId}/queue/${entry.id}`);
      await qc.invalidateQueries({ queryKey: keys.queue(workerId) });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3">
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorText>{errorMessage(query.error)}</ErrorText>
      ) : !entries.length ? (
        <p className="text-sm text-muted-foreground">The queue is empty.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
            <ol aria-label="Worker queue" className="divide-y rounded-lg border">
              {entries.map((entry, index) => (
                <QueueRow
                  key={entry.id}
                  entry={entry}
                  index={index}
                  length={entries.length}
                  disabled={busy}
                  onMove={(to) => move(entry.id, to)}
                  onRemove={() => remove(entry)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

function QueueRow({
  entry,
  index,
  length,
  disabled,
  onMove,
  onRemove,
}: {
  entry: QueueEntry;
  index: number;
  length: number;
  disabled: boolean;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const sortable = useSortable({ id: entry.id, disabled });
  return (
    <li
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      className="flex flex-wrap items-center gap-2 bg-card p-3 text-sm"
    >
      <button type="button" aria-label={`Drag ${entry.task.key}`} className="touch-none cursor-grab" {...sortable.attributes} {...sortable.listeners}>
        <GripVertical className="size-4 text-muted-foreground" />
      </button>
      <span className="text-xs text-muted-foreground">#{index + 1}</span>
      <Link className="min-w-48 flex-1 truncate" to={`/t/${entry.task.key}`}>
        <b>{entry.task.key}</b> · {entry.task.title}
      </Link>
      {entry.agent ? (
        <span className="flex min-w-0 max-w-52 items-center gap-1.5 truncate text-xs text-muted-foreground">
          <AgentAvatar agent={entry.agent} size="xs" />
          {entry.agent.name}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">No agent</span>
      )}
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {entry.held ? 'Waiting for retry' : entry.kind.replace(/_/g, ' ')} · {entry.pendingMessages} messages
      </span>
      <Button variant="ghost" size="icon-xs" aria-label={`Move ${entry.task.key} up`} disabled={disabled || index === 0} onClick={() => onMove(index - 1)}>
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Move ${entry.task.key} down`}
        disabled={disabled || index === length - 1}
        onClick={() => onMove(index + 1)}
      >
        <ArrowDown />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${entry.task.key}`}
        title={entry.kind === 'start' ? 'Unassign the agent to remove a session start.' : undefined}
        disabled={disabled || entry.kind === 'start'}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

function BuildsPanel({ workerId }: { workerId: string }) {
  const query = useBuilds(workerId);
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = query.data?.find((b) => b.id === selected) ?? query.data?.[0];
  const detail = useQuery({
    queryKey: ['build', workerId, chosen?.id],
    queryFn: () => get<{ build: WorkerBuild }>(`/workers/${workerId}/builds/${chosen!.id}`).then((r) => r.build),
    enabled: !!chosen && chosen !== query.data?.[0],
  });
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  if (!chosen) return <p className="text-sm text-muted-foreground">No builds yet.</p>;
  return (
    <div className="space-y-4">
      <h2 className="font-semibold">Build history</h2>
      <select aria-label="Build" className="w-full rounded-md border bg-background p-2 text-sm" value={chosen.id} onChange={(e) => setSelected(e.target.value)}>
        {query.data.map((b) => (
          <option key={b.id} value={b.id}>
            {b.status} · {new Date(b.startedAt).toLocaleString()} · {b.baseVersion}
          </option>
        ))}
      </select>
      <p role="status" className="text-sm text-muted-foreground">
        {chosen.status === 'building' ? 'Building image… output updates live.' : `Build ${chosen.status}`}
      </p>
      {detail.error ? (
        <ErrorText>{errorMessage(detail.error)}</ErrorText>
      ) : (
        <LogView label="Build output">{chosen === query.data[0] ? chosen.log : (detail.data?.log ?? '')}</LogView>
      )}
    </div>
  );
}

function ProjectsPanel({ worker }: { worker: Worker }) {
  if (!worker.projects.length) return <p className="text-sm text-muted-foreground">No project runs on this worker.</p>;
  return (
    <ul aria-label="Worker projects" className="divide-y rounded-lg border">
      {worker.projects.map((p) => (
        <li key={p.id} className="flex items-center gap-3 bg-card p-3 text-sm">
          {p.kind === 'wiki' ? (
            <Link className="flex-1 underline" to={`/wikis/${p.id}`}>
              {p.name}
            </Link>
          ) : p.kind === 'schedule' ? (
            <Link className="flex-1 underline" to="/schedules">
              {p.name}
            </Link>
          ) : (
            <Link className="flex-1 underline" to={`/p/${p.key}`}>
              {p.name}
            </Link>
          )}
          <span className="text-xs text-muted-foreground">{p.kind === 'project' ? 'Project' : p.kind === 'wiki' ? 'Wiki' : 'Schedule'}</span>
        </li>
      ))}
    </ul>
  );
}
