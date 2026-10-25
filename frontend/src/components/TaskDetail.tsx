import { BranchLink, PullRequestBadge } from './Git';
import { AGENTS_TOPIC, PRIORITIES, taskTopic } from '@claude-task/shared';
import type { ConflictResponse, Priority, Task, UpdateTaskBody } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Expand, Link2, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError, del, errorMessage, patch, post } from '../api/client';
import { keys, useAgents, useProject, useTask, useTaskSession, useUsers } from '../api/queries';
import { removeCard, setTask, toCard, upsertCard } from '../lib/cache';
import { useTopic } from '../lib/realtime';
import { LabelChip, Loading, PriorityIcon, PRIORITY_STYLE, StatusDot, Time, useConfirm, UserAvatar } from './common';
import { Composer } from './Composer';
import { Markdown, MarkdownEditor } from './Markdown';
import { MultiPick } from './MultiPick';
import { Timeline } from './Timeline';
import { AgentAvatar, SessionChip } from './agents';

type Fields = Omit<UpdateTaskBody, 'version'>;

export function TaskDetail({ taskKey, onClose }: { taskKey: string; onClose?: () => void }) {
  const taskQuery = useTask(taskKey);
  const task = taskQuery.data;
  const projectKey = taskKey.split('-')[0];
  const bundle = useProject(task ? task.key.split('-')[0] : undefined);
  const users = useUsers();
  const agents = useAgents();
  const session = useTaskSession(task?.id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  useTopic(task ? taskTopic(task.id) : null);
  useTopic(AGENTS_TOPIC);

  if (taskQuery.isPending) return <Loading className="h-full" />;
  if (!task) {
    return (
      <div className="flex h-full flex-col">
        {onClose && (
          <div className="flex justify-end p-3">
            <CloseButton onClose={onClose} />
          </div>
        )}
        <p className="p-8 text-center text-sm text-muted-foreground">
          {taskQuery.error instanceof ApiError && taskQuery.error.status === 404 ? 'This task doesn’t exist (or was deleted).' : errorMessage(taskQuery.error)}
        </p>
      </div>
    );
  }
  const statuses = [...(bundle.data?.statuses ?? [])].sort((a, b) => a.position - b.position);
  const labels = bundle.data?.labels ?? [];
  const people = users.data ?? [];

  const sessionAction = async (action: 'stop' | 'retry' | 'notify') => {
    try {
      await post(`/tasks/${task.id}/session/${action}`);
      // Dispatch can advance the Session before this HTTP response arrives.
      // Refetch instead of overwriting a newer WebSocket update with that snapshot.
      await qc.invalidateQueries({ queryKey: keys.session(task.id) });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const applied = (t: Task) => {
    setTask(qc, t);
    upsertCard(qc, toCard(t));
  };

  /** Patches against the version we have; on 409 shows what changed instead of overwriting. */
  const save = async (fields: Fields): Promise<boolean> => {
    try {
      applied((await patch<{ task: Task }>(`/tasks/${task.id}`, { version: task.version, ...fields })).task);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        applied((err.body as ConflictResponse).task);
        toast.warning('Someone else changed this task', { description: 'It has been refreshed and your change was not saved.' });
      } else {
        toast.error('Couldn’t save', { description: errorMessage(err) });
      }
      return false;
    }
  };

  const moveTo = async (statusId: string) => {
    try {
      applied((await post<{ task: Task }>(`/tasks/${task.id}/move`, { statusId })).task);
    } catch (err) {
      toast.error('Couldn’t change the status', { description: errorMessage(err) });
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${task.key}?`,
      description: `“${task.title}” is deleted with its comments and attachments. This can’t be undone.`,
      confirmLabel: 'Delete task',
      destructive: true,
    });
    if (!ok) return;
    try {
      await del(`/tasks/${task.id}`);
      removeCard(qc, task.projectId, task.id);
      toast.success(`${task.key} deleted`);
      if (onClose) onClose();
      else navigate(`/p/${projectKey}`);
    } catch (err) {
      toast.error('Couldn’t delete the task', { description: errorMessage(err) });
    }
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(`${location.origin}/t/${task.key}`);
    toast.success('Link copied');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-5">
        <Link to={`/p/${projectKey}`} className="text-sm text-muted-foreground hover:text-foreground">
          {projectKey}
        </Link>
        <span className="text-muted-foreground/50">/</span>
        <span className="font-mono text-sm font-medium">{task.key}</span>
        <div className="ml-auto flex items-center gap-1">
          {onClose && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon-sm" aria-label="Open full page">
                  <Link to={`/t/${task.key}`}>
                    <Expand />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open full page</TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Task actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={copyLink}>
                <Link2 /> Copy link
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={remove}>
                <Trash2 /> Delete task
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {onClose && <CloseButton onClose={onClose} />}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-6 px-6 py-5">
          <Title title={task.title} onSave={(title) => save({ title })} />

          <div className="grid grid-cols-[7.5rem_1fr] items-center gap-x-4 gap-y-2.5 rounded-xl border bg-muted/20 p-4 text-sm">
            <PropLabel>Status</PropLabel>
            <Select value={task.statusId} onValueChange={moveTo}>
              <SelectTrigger size="sm" aria-label="Status" className="w-fit min-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <StatusDot color={s.color} className="size-2" /> {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <PropLabel>Priority</PropLabel>
            <Select value={task.priority} onValueChange={(p) => save({ priority: p as Priority })}>
              <SelectTrigger size="sm" aria-label="Priority" className="w-fit min-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    <PriorityIcon priority={p} /> {PRIORITY_STYLE[p].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <PropLabel>Assignees</PropLabel>
            <MultiPick
              label="Assignees"
              highlight={false}
              options={people
                .filter((u) => u.active || task.assigneeIds.includes(u.id))
                .map((u) => ({ value: u.id, label: u.displayName, icon: <UserAvatar user={u} size="xs" /> }))}
              selected={task.assigneeIds}
              onChange={(assigneeIds) => save({ assigneeIds })}
              trigger={
                <button type="button" aria-label="Assign" className="flex min-h-7 w-fit flex-wrap items-center gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-muted">
                  {task.assigneeIds.length === 0 && <span className="text-muted-foreground">Unassigned</span>}
                  {task.assigneeIds.map((id) => {
                    const u = people.find((p) => p.id === id);
                    return (
                      <span key={id} className="flex items-center gap-1.5">
                        <UserAvatar user={u ?? { id, displayName: '?' }} size="xs" /> {u?.displayName}
                      </span>
                    );
                  })}
                  <Plus className="size-3.5 text-muted-foreground" />
                </button>
              }
            />

            <PropLabel>Agent</PropLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={task.agentId ?? 'none'} onValueChange={(id) => save({ agentId: id === 'none' ? null : id })}>
                <SelectTrigger size="sm" aria-label="Assign agent" className="w-fit min-w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No agent</SelectItem>
                  {(agents.data ?? []).filter((a) => a.enabled || a.id === task.agentId).map((a) => (
                    <SelectItem key={a.id} value={a.id}><AgentAvatar agent={a} size="xs" /> {a.name}{!a.enabled && ' (disabled)'}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {session.data && <SessionChip session={session.data} />}
              {session.data?.state === 'running' && <Button size="xs" variant="outline" onClick={() => sessionAction('stop')}>Stop</Button>}
              {task.agentId && session.data?.held && <Button size="xs" variant="outline" onClick={() => sessionAction('retry')}>Retry</Button>}
            </div>

            <PropLabel>Labels</PropLabel>
            <MultiPick
              label="Labels"
              highlight={false}
              options={labels.map((l) => ({ value: l.id, label: l.name, icon: <span className="size-2 rounded-full" style={{ backgroundColor: l.color }} /> }))}
              selected={task.labelIds}
              onChange={(labelIds) => save({ labelIds })}
              trigger={
                <button type="button" aria-label="Edit labels" className="flex min-h-7 w-fit flex-wrap items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-muted">
                  {task.labelIds.length === 0 && <span className="text-muted-foreground">No labels</span>}
                  {task.labelIds.map((id) => {
                    const l = labels.find((x) => x.id === id);
                    return l ? <LabelChip key={id} name={l.name} color={l.color} /> : null;
                  })}
                  <Plus className="size-3.5 text-muted-foreground" />
                </button>
              }
            />

            <PropLabel>Created</PropLabel>
            <span className="flex items-center gap-2 px-1.5 text-muted-foreground">
              <UserAvatar name={task.createdBy.displayName} user={task.createdBy.id ? { id: task.createdBy.id, displayName: task.createdBy.displayName } : undefined} size="xs" />
              <span className="text-foreground">{task.createdBy.displayName}</span> · <Time iso={task.createdAt} />
            </span>
            <PropLabel>Updated</PropLabel>
            <span className="px-1.5 text-muted-foreground">
              <Time iso={task.updatedAt} />
            </span>
          </div>

          {(task.branchName || task.pullRequest) && <section aria-label="Task code" className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
            {task.branchName && task.branchUrl && <BranchLink name={task.branchName} url={task.branchUrl} />}
            {task.pullRequest && <PullRequestBadge pr={task.pullRequest} />}
          </section>}
          <Description description={task.description} onSave={(description) => save({ description })} />

          {session.data?.unseenChanges && (
            <div role="status" className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <span className="flex-1">The agent hasn’t seen the latest task changes.</span>
              <Button size="sm" variant="outline" onClick={() => sessionAction('notify')}>Notify agent</Button>
            </div>
          )}

          <Separator />

          <section className="space-y-4">
            <h3 className="text-sm font-semibold">Activity</h3>
            <Timeline taskId={task.id} statuses={statuses} labels={labels} users={people} />
            <Composer taskId={task.id} />
          </section>
        </div>
      </div>
    </div>
  );
}

function PropLabel({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
      <X />
    </Button>
  );
}

function Title({ title, onSave }: { title: string; onSave: (title: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(title);
  const [focused, setFocused] = useState(false);
  // Follow remote renames, but never while the user is typing.
  useEffect(() => {
    if (!focused) setDraft(title);
  }, [title, focused]);
  const commit = async () => {
    setFocused(false);
    const next = draft.trim();
    if (!next || next === title) return setDraft(title);
    if (!(await onSave(next))) setDraft(title);
  };
  return (
    <textarea
      aria-label="Title"
      rows={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, ''))}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') setDraft(title);
      }}
      className="field-sizing-content w-full resize-none rounded-md bg-transparent px-1 -mx-1 text-xl leading-snug font-semibold tracking-tight outline-none hover:bg-muted/40 focus:bg-muted/40"
    />
  );
}

function Description({ description, onSave }: { description: string; onSave: (d: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(description);
  const [stale, setStale] = useState(false);

  if (!editing) {
    return (
      <section className="group space-y-2">
        <div className="flex items-center">
          <h3 className="text-sm font-semibold">Description</h3>
          <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => (setDraft(description), setStale(false), setEditing(true))}>
            <Pencil /> Edit
          </Button>
        </div>
        {description ? (
          <Markdown source={description} />
        ) : (
          <button
            type="button"
            onClick={() => (setDraft(''), setEditing(true))}
            className="w-full rounded-lg border border-dashed p-4 text-left text-sm text-muted-foreground hover:border-foreground/20 hover:text-foreground"
          >
            Add a description… Markdown with checklists and code blocks is supported.
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Description</h3>
      <MarkdownEditor label="Description" layout="split" rows={12} value={draft} onChange={setDraft} autoFocus />
      {stale && (
        <p className="text-xs text-amber-500">The task changed while you were editing. Your draft is kept: review the description above and save again.</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={async () => {
            // On a conflict the draft stays here, so it can be re-applied by hand.
            if (await onSave(draft)) setEditing(false);
            else setStale(true);
          }}
        >
          Save
        </Button>
      </div>
    </section>
  );
}
