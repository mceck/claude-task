import { agentTopic } from '@claude-task/shared';
import type { Agent, AgentBuild, QueueEntry } from '@claude-task/shared';
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
import { keys, useAgent, useBuilds, useContainerLogs, useJob, useJobs, useMe, useQueue, useUsage } from '../api/queries';
import { AgentAvatar, AgentStateBadge, formatCost, formatDuration, formatTokens } from '../components/agents';
import { AgentForm, applyAvatarChange, LogView } from '../components/AgentForm';
import { ErrorText, Loading, Time, useConfirm } from '../components/common';
import { useTopic } from '../lib/realtime';
import { NotFoundPage } from './NotFoundPage';

export function AgentPage() {
  const { agentId } = useParams();
  const query = useAgent(agentId);
  useTopic(agentId ? agentTopic(agentId) : null);
  if (query.isPending) return <Loading className="h-full" />;
  if (!query.data)
    return query.error && (query.error as { status?: number }).status !== 404 ? (
      <ErrorText>{errorMessage(query.error)}</ErrorText>
    ) : (
      <NotFoundPage what="Agent" />
    );
  return <AgentDetail key={query.data.id} agent={query.data} />;
}

function AgentDetail({ agent }: { agent: Agent }) {
  const admin = useMe().data?.role === 'admin';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('work');
  const refresh = async () => {
    await Promise.all([keys.agents, keys.agent(agent.id), keys.queue(agent.id), keys.builds(agent.id)].map((key) => qc.invalidateQueries({ queryKey: key })));
  };
  const action = async (name: string, force = false) => {
    if (
      (name === 'restart' || force) &&
      !(await confirm({
        title: force ? 'Force recreate this container?' : 'Restart this container?',
        description: 'This interrupts the current job. Its session will be resumed after reconnecting.',
        confirmLabel: force ? 'Force recreate' : 'Restart',
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await post(`/agents/${agent.id}/${name}`, name === 'recreate' ? { force } : undefined);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: `Delete ${agent.name}?`,
        description: 'Its container, images, volume and Claude transcripts are deleted. Unassign all open tasks first.',
        confirmLabel: 'Delete agent',
        destructive: true,
      }))
    )
      return;
    try {
      await del(`/agents/${agent.id}`);
      await qc.invalidateQueries({ queryKey: keys.agents });
      navigate('/agents');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-8 py-8">
      <Button asChild variant="ghost" size="sm">
        <Link to="/agents">
          <ArrowLeft /> Agents
        </Link>
      </Button>
      <header className="flex flex-wrap items-center gap-4">
        <AgentAvatar agent={agent} size="lg" state={agent.state} />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <p className="text-sm text-muted-foreground">{agent.description}</p>
        </div>
        <AgentStateBadge state={agent.state} taskKey={agent.currentTask?.key} />
      </header>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4 text-sm">
        <span>
          Container: <b>{agent.containerState}</b>
        </span>
        <span>Runner: {agent.runnerConnected ? 'connected' : 'disconnected'}</span>
        <span>Credential: {agent.credentialName}</span>
        <span>{agent.queueLength} queued</span>
        {agent.lastActivityAt && (
          <span className="text-muted-foreground">
            Active <Time iso={agent.lastActivityAt} />
          </span>
        )}
        {agent.recreatePending && (
          <p role="status" className="w-full text-amber-400">
            Container recreation is waiting for the current job to finish.
          </p>
        )}
        {admin && (
          <div className="flex w-full flex-wrap gap-2 border-t pt-3">
            <Button variant="outline" size="sm" disabled={busy || agent.state === 'building'} onClick={() => action('rebuild')}>
              Rebuild image
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => action('restart')}>
              Restart
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => action('recreate')}>
              Recreate when idle
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => action('recreate', true)}>
              Force recreate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await post<{ agent: Agent }>(`/agents/${agent.id}/duplicate`, {});
                  await refresh();
                  navigate(`/agents/${result.agent.id}`);
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
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
          <TabsTrigger value="work">Work & queue</TabsTrigger>
          <TabsTrigger value="builds">Builds</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          {admin && (
            <>
              <TabsTrigger value="logs">Container logs</TabsTrigger>
              <TabsTrigger value="config">Configuration</TabsTrigger>
            </>
          )}
        </TabsList>
        <TabsContent value="work">
          <QueuePanel agent={agent} />
          <JobsPanel agentId={agent.id} />
        </TabsContent>
        <TabsContent value="builds">
          <BuildsPanel agentId={agent.id} />
        </TabsContent>
        <TabsContent value="usage">
          <UsagePanel agentId={agent.id} />
        </TabsContent>
        {admin && (
          <>
            <TabsContent value="logs">
              <ContainerLogs agentId={agent.id} />
            </TabsContent>
            <TabsContent value="config">
              <div className="rounded-xl border bg-card p-5">
                <AgentForm
                  agent={agent}
                  onSave={async (body, avatar) => {
                    await patch(`/agents/${agent.id}`, body);
                    await applyAvatarChange(agent.id, avatar);
                    await refresh();
                    toast.success('Agent saved');
                  }}
                />
              </div>
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}

function QueuePanel({ agent }: { agent: Agent }) {
  const query = useQueue(agent.id);
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
      const result = await post<{ entries: QueueEntry[] }>(`/agents/${agent.id}/queue/${id}/move`, { beforeEntryId: other[to]?.id ?? null });
      qc.setQueryData(keys.queue(agent.id), result.entries);
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
      await del(`/agents/${agent.id}/queue/${entry.id}`);
      await qc.invalidateQueries({ queryKey: keys.queue(agent.id) });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-6 space-y-3">
      <h2 className="font-semibold">Current work & queue</h2>
      {agent.currentTask && (
        <Link className="block rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm" to={`/t/${agent.currentTask.key}`}>
          Working on <b>{agent.currentTask.key}</b> · {agent.currentTask.title}
        </Link>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorText>{errorMessage(query.error)}</ErrorText>
      ) : !entries.length ? (
        <p className="text-sm text-muted-foreground">The queue is empty.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
            <ol aria-label="Agent queue" className="divide-y rounded-lg border">
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
      className="flex items-center gap-2 bg-card p-3 text-sm"
    >
      <button type="button" aria-label={`Drag ${entry.task.key}`} className="touch-none cursor-grab" {...sortable.attributes} {...sortable.listeners}>
        <GripVertical className="size-4 text-muted-foreground" />
      </button>
      <span className="text-xs text-muted-foreground">#{index + 1}</span>
      <Link className="min-w-0 flex-1 truncate" to={`/t/${entry.task.key}`}>
        <b>{entry.task.key}</b> · {entry.task.title}
      </Link>
      <span className="text-xs text-muted-foreground">
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

function BuildsPanel({ agentId }: { agentId: string }) {
  const query = useBuilds(agentId);
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = query.data?.find((b) => b.id === selected) ?? query.data?.[0];
  const detail = useQuery({
    queryKey: ['build', agentId, chosen?.id],
    queryFn: () => get<{ build: AgentBuild }>(`/agents/${agentId}/builds/${chosen!.id}`).then((r) => r.build),
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

function ContainerLogs({ agentId }: { agentId: string }) {
  const query = useContainerLogs(agentId, true);
  return (
    <div className="space-y-3">
      <h2 className="font-semibold">Container logs</h2>
      <p className="text-xs text-muted-foreground">Latest 500 lines, refreshed every three seconds.</p>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorText>{errorMessage(query.error)}</ErrorText>
      ) : (
        <LogView label="Container logs">{query.data}</LogView>
      )}
    </div>
  );
}

function JobsPanel({ agentId }: { agentId: string }) {
  const query = useJobs(agentId);
  const [selected, setSelected] = useState<string | null>(null);
  const job = useJob(selected);
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">Recent jobs</h2>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorText>{errorMessage(query.error)}</ErrorText>
      ) : !query.data.length ? (
        <p className="text-sm text-muted-foreground">No jobs yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {query.data.map((j) => (
            <li key={j.id} className="flex items-center gap-3 p-3 text-sm">
              <Link className="font-mono text-xs underline" to={`/t/${j.task.key}`}>
                {j.task.key}
              </Link>
              <span>{j.state}</span>
              <span className="text-xs text-muted-foreground">
                {j.turns} turns · {formatCost(j.usage.costUsd)} · <Time iso={j.createdAt} />
              </span>
              <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setSelected(j.id)}>
                Details
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Job details</DialogTitle>
            <DialogDescription>Setup output and process diagnostics.</DialogDescription>
          </DialogHeader>
          {job.isPending ? (
            <Loading />
          ) : job.error ? (
            <ErrorText>{errorMessage(job.error)}</ErrorText>
          ) : (
            job.data && (
              <div className="space-y-3">
                <p className="text-sm">
                  {job.data.task.key} · {job.data.state} · Claude {job.data.claudeVersion ?? 'unknown'}
                  {job.data.startedAt && job.data.finishedAt && ` · ${formatDuration(Date.parse(job.data.finishedAt) - Date.parse(job.data.startedAt))}`}
                </p>
                {job.data.error && (
                  <ErrorText>
                    {job.data.failureStage}: {job.data.error}
                  </ErrorText>
                )}
                <h3 className="text-sm font-medium">Setup script</h3>
                <LogView>{job.data.setupOutput}</LogView>
                <h3 className="text-sm font-medium">Stderr</h3>
                <LogView>{job.data.stderr}</LogView>
              </div>
            )
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function UsagePanel({ agentId }: { agentId: string }) {
  const query = useUsage(agentId);
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const usage = query.data;
  const tokens = (r: typeof usage.total) => formatTokens(r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        {[
          ['Estimated cost', formatCost(usage.total.costUsd)],
          ['Tokens', tokens(usage.total)],
          ['Turns', usage.total.turns],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      {(
        [
          ['Per day (last 30 days, UTC)', usage.byDay],
          ['Per task', usage.byTask],
        ] as const
      ).map(([title, rows]) => (
        <section key={title}>
          <h2 className="mb-3 font-semibold">{title}</h2>
          {rows.length ? (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">{title.startsWith('Per day') ? 'Day' : 'Task'}</th>
                  <th>Turns</th>
                  <th>Tokens</th>
                  <th>Estimated cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t">
                    <td className="p-2">
                      {'taskId' in r && r.key !== 'deleted' ? (
                        <Link className="underline" to={`/t/${r.key}`}>
                          {r.key}
                        </Link>
                      ) : (
                        r.key
                      )}
                    </td>
                    <td>{r.turns}</td>
                    <td>{tokens(r)}</td>
                    <td>{formatCost(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">No usage yet.</p>
          )}
        </section>
      ))}
      <section>
        <h2 className="mb-3 font-semibold">Latest rate-limit status</h2>
        {usage.rateLimit ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              <Time iso={usage.rateLimit.observedAt} />
            </p>
            <LogView>{JSON.stringify(usage.rateLimit.info, null, 2)}</LogView>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No rate-limit observations yet.</p>
        )}
      </section>
    </div>
  );
}
