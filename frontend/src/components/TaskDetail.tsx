import { VoiceRoomPanel } from './VoiceRoom';
import { BranchLink, PullRequestBadge, capitalize, withProvider } from './Git';
import { AGENTS_TOPIC, PRIORITIES, projectTopic, pullRequestNoun, pullRequestRef, taskTopic } from '@claude-task/shared';
import type { ConflictResponse, Tag, Priority, Task, UpdateTaskBody } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Expand, Eye, GitMerge, EyeOff, FileText, Link2, MessagesSquare, MoreHorizontal, PanelBottomClose, PanelRightClose, PanelRightOpen, Pencil, Plus, Trash2, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ApiError, del, errorMessage, patch, post, put } from '../api/client';
import { keys, useAgents, useProject, useTask, useTaskSession, useUsers } from '../api/queries';
import { removeCard, removeTask, setTask, toCard, upsertCard } from '../lib/cache';
import { minimizeInDock, removeFromDock, useDockAvailable } from '../lib/dock';
import { useTopic } from '../lib/realtime';
import { TagChip, Loading, PriorityIcon, PRIORITY_STYLE, StatusDot, Time, useConfirm, UserAvatar } from './common';
import { RichMarkdownView } from './Markdown';

// It also shows the description, so it loads with the task: editing then starts without a swap.
const RichMarkdownEditor = lazy(() => import('./RichMarkdownEditor'));

/** Colors handed to tags created inline, cycling so neighbours differ. */
const TAG_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9', '#a855f7', '#ec4899', '#14b8a6'];
const nextTagColor = (existing: number) => TAG_COLORS[existing % TAG_COLORS.length]!;
import { MultiPick } from './MultiPick';
import { TaskActivity } from './TaskActivity';
import { TaskAttachments } from './TaskAttachments';
import { AgentAvatar, AgentFreeDot, SessionChip } from './agents';

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
  const [merging, setMerging] = useState(false);
  const layout = useTaskLayout();
  const [hideChanges, setHideChanges] = useState(true);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const dockable = useDockAvailable();
  const saves = useRef({ queue: Promise.resolve<unknown>(undefined), version: -1, count: 0, owners: new Map<string, number>() });
  // Values of saves still queued or in flight, shown over the Task meanwhile.
  const [pending, setPending] = useState<Fields>({});
  useTopic(task ? taskTopic(task.id) : null);
  // Statuses and Tags come from the Project bundle, which only the Board used to keep current.
  useTopic(task ? projectTopic(task.projectId) : null);
  useTopic(AGENTS_TOPIC);
  // Shown on a page or in the Board dialog, the conversation is no longer minimized: it can't be in both places.
  useEffect(() => {
    if (task) removeFromDock(task.id);
  }, [task?.id]);

  if (taskQuery.isPending) return <Loading className="h-full" />;
  const missing = taskQuery.error instanceof ApiError && taskQuery.error.status === 404;
  if (!task || missing) {
    return (
      <div className="flex h-full flex-col">
        {onClose && (
          <div className="flex justify-end p-3">
            <CloseButton onClose={onClose} />
          </div>
        )}
        <p className="p-8 text-center text-sm text-muted-foreground">
          {missing ? 'This task doesn’t exist (or was deleted).' : errorMessage(taskQuery.error)}
        </p>
      </div>
    );
  }
  const shown = { ...task, ...pending };
  const statuses = [...(bundle.data?.statuses ?? [])].sort((a, b) => a.position - b.position);
  const tags = bundle.data?.tags ?? [];
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

  /**
   * Patches against the version the user saw; on 409 shows what changed instead of overwriting. Saves run one
   * at a time, each also counting our previous one as seen, so quick repeated edits don't conflict with each other.
   */
  const save = (fields: Fields): Promise<boolean> => {
    const state = saves.current;
    const id = ++state.count;
    const seen = task.version;
    for (const field of Object.keys(fields)) state.owners.set(field, id);
    setPending((p) => ({ ...p, ...fields }));
    const run = state.queue.then(async () => {
      try {
        const { task: saved } = await patch<{ task: Task }>(`/tasks/${task.id}`, { version: Math.max(seen, state.version), ...fields });
        state.version = saved.version;
        applied(saved);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          applied((err.body as ConflictResponse).task);
          toast.warning('Someone else changed this task', { description: 'It has been refreshed and your change was not saved.' });
        } else {
          toast.error('Couldn’t save', { description: errorMessage(err) });
        }
        return false;
      } finally {
        // A field edited again meanwhile stays pending until that later save is done.
        const done = Object.keys(fields).filter((field) => state.owners.get(field) === id);
        for (const field of done) state.owners.delete(field);
        setPending((p) => Object.fromEntries(Object.entries(p).filter(([field]) => !done.includes(field))));
      }
    });
    state.queue = run;
    return run;
  };

  const moveTo = async (statusId: string) => {
    try {
      applied((await post<{ task: Task }>(`/tasks/${task.id}/move`, { statusId })).task);
    } catch (err) {
      toast.error('Couldn’t change the status', { description: errorMessage(err) });
    }
  };

  // Closing moves the Task to the first closed-category Status, which ends its Session.
  const closedStatus = statuses.find((s) => s.category === 'closed');
  const closed = statuses.find((s) => s.id === task.statusId)?.category === 'closed';
  const close = async () => {
    if (!closedStatus) return;
    const working = session.data && (session.data.state === 'running' || session.data.queuePosition !== null);
    if (working) {
      const ok = await confirm({
        title: `Close ${task.key}?`,
        description: `The agent is working on it: closing stops its work and ends the session. The task moves to “${closedStatus.name}”.`,
        confirmLabel: 'Close task',
      });
      if (!ok) return;
    }
    await moveTo(closedStatus.id);
  };

  // An Agent takes a Task out of Backlog, into the first open Status.
  const todoStatus = statuses.find((s) => s.category === 'open');
  const changeAgent = async (agentId: string | null) => {
    const current = statuses.find((s) => s.id === shown.statusId);
    if (agentId && current?.category === 'backlog' && todoStatus) {
      const ok = await confirm({
        title: `Assign an agent to ${task.key}?`,
        description: `The task moves from “${current.name}” to “${todoStatus.name}”.`,
        confirmLabel: 'Assign and move',
      });
      if (!ok) return;
      await save({ agentId, statusId: todoStatus.id });
      return;
    }
    await save({ agentId });
  };

  const mergePullRequest = async (pr: NonNullable<Task['pullRequest']>) => {
    const noun = pullRequestNoun(pr.provider);
    const ok = await confirm({
      title: `Merge ${noun} ${pullRequestRef(pr)}?`,
      description: `The ${noun} is merged into the base branch with the provider’s default merge method. This can’t be undone from here. If there is a later status, the task advances to it.`,
      confirmLabel: 'Merge',
    });
    if (!ok) return;
    setMerging(true);
    try {
      const mergedTask = (await post<{ task: Task }>(`/tasks/${task.id}/pull-request/merge`)).task;
      applied(mergedTask);
      const movedTo = mergedTask.statusId === task.statusId ? undefined : statuses.find((s) => s.id === mergedTask.statusId);
      toast.success(`${capitalize(noun)} ${pullRequestRef(pr)} merged`, movedTo ? { description: `The task moved to “${movedTo.name}”.` } : undefined);
    } catch (err) {
      toast.error(`Couldn’t merge the ${noun}`, { description: errorMessage(err) });
    } finally {
      setMerging(false);
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
      removeTask(qc, task.id);
      toast.success(`${task.key} deleted`);
      if (onClose) onClose();
      else navigate(`/p/${projectKey}`);
    } catch (err) {
      toast.error('Couldn’t delete the task', { description: errorMessage(err) });
    }
  };

  const setAutoResume = async (enabled: boolean) => {
    try {
      const res = await put<{ task: Task }>(`/tasks/${task.id}/auto-resume`, { enabled });
      setTask(qc, res.task);
      upsertCard(qc, toCard(res.task));
    } catch (err) {
      toast.error('Couldn’t change automatic resume', { description: errorMessage(err) });
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/t/${task.key}`);
      toast.success('Link copied');
    } catch (err) {
      toast.error('Couldn’t copy the link', { description: errorMessage(err) });
    }
  };

  // Minimizing hands the conversation to the Dock and leaves the Task: the Board dialog closes, the Task page
  // goes back to its Board. A conversation is either in the Dock or on a page, never both.
  const minimize = () => {
    minimizeInDock({ taskId: task.id });
    if (onClose) onClose();
    else navigate(`/p/${projectKey}`);
  };

  const asideName = layout.focus === 'activity' ? 'details' : 'activity';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <VoiceRoomPanel task={task} />
      <div className="flex shrink-0 flex-wrap items-start gap-x-4 gap-y-2 border-b px-5 py-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex items-center gap-2 text-xs">
            <Link to={`/p/${projectKey}`} className="text-muted-foreground hover:text-foreground">
              {projectKey}
            </Link>
            <span className="text-muted-foreground/50">/</span>
            <span className="font-mono font-medium">{task.key}</span>
            <span className="truncate text-[10px] text-muted-foreground">
              · Created by {task.createdBy.displayName} <Time iso={task.createdAt} />
            </span>
          </div>
          <Title title={shown.title} onSave={(title) => save({ title })} />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <div className="mr-2 flex flex-wrap items-center gap-2">
            {closedStatus && !closed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Close task"
                    className="text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-500 dark:hover:bg-emerald-500/10"
                    onClick={close}
                  >
                    <CircleCheck /> Close
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Move to “{closedStatus.name}” and end the agent session</TooltipContent>
              </Tooltip>
            )}
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              aria-label="Hide changes"
              aria-pressed={hideChanges}
              onClick={() => setHideChanges((v) => !v)}
            >
              {hideChanges ? <EyeOff /> : <Eye />} Changes
            </Button>
            {session.data && <>
              <SessionChip session={session.data} />
              {session.data.state === 'running' && <Button size="xs" variant="outline" onClick={() => sessionAction('stop')}>Stop</Button>}
              {task.agentId && session.data.held && <Button size="xs" variant="outline" onClick={() => sessionAction('retry')}>Retry</Button>}
              {session.data.unseenChanges && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="xs" variant="outline" className="border-amber-500/40 text-amber-500" onClick={() => sessionAction('notify')}>Notify agent</Button>
                  </TooltipTrigger>
                  <TooltipContent>The agent hasn’t seen the latest task changes</TooltipContent>
                </Tooltip>
              )}
            </>}
          </div>
          <div role="group" aria-label="Layout" className="flex items-center rounded-md border p-0.5">
            {FOCUS_OPTIONS.map(({ focus, label, icon }) => (
              <Tooltip key={focus}>
                <TooltipTrigger asChild>
                  <Button
                    variant={layout.focus === focus ? 'secondary' : 'ghost'}
                    size="icon-xs"
                    aria-label={label}
                    aria-pressed={layout.focus === focus}
                    onClick={() => layout.setFocus(focus)}
                  >
                    {icon}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${layout.sidebarOpen ? 'Hide' : 'Show'} ${asideName}`}
                aria-expanded={layout.sidebarOpen}
                aria-controls={`${task.key}-${asideName}`}
                onClick={layout.toggleSidebar}
              >
                {layout.sidebarOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`${layout.sidebarOpen ? 'Hide' : 'Show'} ${asideName}`}</TooltipContent>
          </Tooltip>
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
              <DropdownMenuCheckboxItem checked={task.autoResume} onCheckedChange={(on) => void setAutoResume(on)}>
                Automatic resume at limit
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={remove}>
                <Trash2 /> Delete task
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {dockable && (onClose !== undefined || bundle.data !== undefined) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Minimize chat" onClick={minimize}>
                  <PanelBottomClose />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Minimize chat</TooltipContent>
            </Tooltip>
          )}
          {onClose && <CloseButton onClose={onClose} />}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <Panel id={`${task.key}-activity`} main={layout.focus === 'activity'} open={layout.sidebarOpen} wide>
          <TaskActivity
            task={task}
            statuses={statuses}
            tags={tags}
            users={people}
            session={session.data}
            hideChanges={hideChanges}
            reserveDockSpace={layout.focus === 'activity' || layout.sidebarOpen}
          />
        </Panel>
        <Panel id={`${task.key}-details`} main={layout.focus === 'details'} open={layout.sidebarOpen} className={cn(layout.focus === 'details' && 'order-first')}>
          <section aria-label="Task details" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className={cn('@container space-y-6', layout.focus === 'details' ? 'mx-auto w-full max-w-3xl px-6 py-6' : 'p-5')}>
              <div className="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-2.5 rounded-xl border bg-muted/20 p-4 text-sm @2xl:grid-cols-[6.5rem_1fr_6.5rem_1fr]">
                <Prop label="Status" className="@2xl:col-start-1 @2xl:row-start-1">
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
                </Prop>

                <Prop label="Priority" className="@2xl:col-start-1 @2xl:row-start-2">
                  <Select value={shown.priority} onValueChange={(p) => save({ priority: p as Priority })}>
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
                </Prop>

                <Prop label="Updated" className="@2xl:col-start-1 @2xl:row-start-3">
                  <span className="px-1.5 text-muted-foreground">
                    <Time iso={task.updatedAt} />
                  </span>
                </Prop>

                <Prop label="Assignees" className="@2xl:col-start-3 @2xl:row-start-1">
                  <MultiPick
                    label="Assignees"
                    highlight={false}
                    options={people
                      .filter((u) => u.active || shown.assigneeIds.includes(u.id))
                      .map((u) => ({ value: u.id, label: u.displayName, icon: <UserAvatar user={u} size="xs" /> }))}
                    selected={shown.assigneeIds}
                    onChange={(assigneeIds) => save({ assigneeIds })}
                    trigger={
                      <button type="button" aria-label="Assign" className="flex min-h-7 w-fit flex-wrap items-center gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-muted">
                        {shown.assigneeIds.length === 0 && <span className="text-muted-foreground">Unassigned</span>}
                        {shown.assigneeIds.map((id) => {
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
                </Prop>

                <Prop label="Agent" className="@2xl:col-start-3 @2xl:row-start-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={shown.agentId ?? 'none'} onValueChange={(id) => void changeAgent(id === 'none' ? null : id)}>
                      <SelectTrigger size="sm" aria-label="Assign agent" className="w-fit min-w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No agent</SelectItem>
                        {(agents.data ?? []).filter((a) => a.enabled || a.id === shown.agentId).map((a) => (
                          <SelectItem key={a.id} value={a.id}><AgentAvatar agent={a} size="xs" /> {a.name}{!a.enabled && ' (disabled)'} <AgentFreeDot agent={a} /></SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </Prop>

                <Prop label="Tags" className="@2xl:col-start-3 @2xl:row-start-3">
                  <MultiPick
                    label="Tags"
                    createNoun="tag"
                    onCreate={async (name) => {
                      try {
                        const { tag } = await post<{ tag: Tag }>(`/projects/${task.projectId}/tags`, { name, color: nextTagColor(tags.length) });
                        // The WebSocket event updates the project's tag list; select the new tag right away.
                        await save({ tagIds: [...shown.tagIds, tag.id] });
                      } catch (err) {
                        toast.error('Couldn’t create the tag', { description: errorMessage(err) });
                      }
                    }}
                    highlight={false}
                    options={tags.map((l) => ({ value: l.id, label: l.name, icon: <span className="size-2 rounded-full" style={{ backgroundColor: l.color }} /> }))}
                    selected={shown.tagIds}
                    onChange={(tagIds) => save({ tagIds })}
                    trigger={
                      <button type="button" aria-label="Edit tags" className="flex min-h-7 w-fit flex-wrap items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-muted">
                        {shown.tagIds.length === 0 && <span className="text-muted-foreground">No tags</span>}
                        {shown.tagIds.map((id) => {
                          const l = tags.find((x) => x.id === id);
                          return l ? <TagChip key={id} name={l.name} color={l.color} /> : null;
                        })}
                        <Plus className="size-3.5 text-muted-foreground" />
                      </button>
                    }
                  />
                </Prop>
              </div>

              {(task.branchName || task.pullRequest) && <section aria-label="Task code" className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                {task.branchName && task.branchUrl && <BranchLink name={task.branchName} url={task.branchUrl} />}
                {task.pullRequest && <PullRequestBadge pr={task.pullRequest} />}
                {task.pullRequest?.state === 'open' && !task.pullRequest.draft && (
                  <Button size="sm" variant="outline" className="ml-auto" disabled={merging} onClick={() => mergePullRequest(task.pullRequest!)}>
                    <GitMerge className="size-3.5" /> {merging ? 'Merging…' : `Merge ${pullRequestNoun(withProvider(task.pullRequest).provider)}`}
                  </Button>
                )}
              </section>}
              <Description taskId={task.id} description={shown.description} onSave={(description) => save({ description })} overlayContainer={overlay} />
              <TaskAttachments taskId={task.id} />
            </div>
          </section>
        </Panel>
      </div>
      {/* The description editor's popups, above both panels and inside the board's task dialog. */}
      <div ref={setOverlay} />
    </div>
  );
}

/**
 * A Task panel, either the main area or the right sidebar. Both panels stay mounted with the same structure,
 * so drafts, open editors and scroll survive swapping and collapsing.
 * The sidebar slides its width on wide screens and overlays from the right on narrow ones; its content keeps
 * a fixed width meanwhile, so it doesn't reflow. Visibility flips at the end of closing, keeping it out of the tab order.
 */
function Panel({ id, main, open, wide, className, children }: { id: string; main: boolean; open: boolean; wide?: boolean; className?: string; children: ReactNode }) {
  const closed = !main && !open;
  return (
    <div
      id={id}
      aria-hidden={closed}
      inert={closed}
      className={cn(
        'flex min-h-0',
        main
          ? 'min-w-0 flex-1'
          : cn(
              'shrink-0 overflow-hidden transition-[width,translate,visibility] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              'max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-10 max-lg:w-full sm:max-lg:w-96',
              open ? (wide ? 'lg:w-[30rem]' : 'lg:w-96') : 'invisible max-lg:translate-x-full lg:w-0',
            ),
        className,
      )}
    >
      <div
        className={cn(
          'flex min-h-0 flex-col',
          main ? 'min-w-0 flex-1' : cn('w-full shrink-0 border-l bg-card max-lg:shadow-2xl sm:w-96', wide && 'lg:w-[30rem]'),
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Which panel takes the main area; the other one sits in the collapsible right sidebar. */
type Focus = 'activity' | 'details';
const FOCUS_OPTIONS: { focus: Focus; label: string; icon: ReactNode }[] = [
  { focus: 'activity', label: 'Focus activity', icon: <MessagesSquare /> },
  { focus: 'details', label: 'Focus details', icon: <FileText /> },
];
const FOCUS_KEY = 'task-layout';
const SIDEBAR_KEY = 'task-sidebar';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Only a per-browser convenience: the default layout is fine without it.
  }
}

/** The viewer's layout preference, shared by every task. The sidebar starts open unless the screen is narrow. */
function useTaskLayout() {
  const [focus, setFocusState] = useState<Focus>(() => (readStored(FOCUS_KEY) === 'details' ? 'details' : 'activity'));
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = readStored(SIDEBAR_KEY);
    return stored ? stored === 'open' : matchMedia('(min-width: 64rem)').matches;
  });
  return {
    focus,
    sidebarOpen,
    setFocus: (next: Focus) => {
      setFocusState(next);
      store(FOCUS_KEY, next);
    },
    toggleSidebar: () => {
      setSidebarOpen(!sidebarOpen);
      store(SIDEBAR_KEY, sidebarOpen ? 'closed' : 'open');
    },
  };
}

/** A property row: label and value share the grid's columns, so rows line up even when placed in the second column. */
function Prop({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('col-span-2 grid grid-cols-subgrid items-center', className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
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
      className="field-sizing-content w-full resize-none rounded-md bg-transparent px-1 -mx-1 text-lg leading-snug font-semibold tracking-tight outline-none hover:bg-muted/40 focus:bg-muted/40"
    />
  );
}

const DESCRIPTION_PLACEHOLDER = 'Add a description…';

/**
 * The description, edited in place: clicking the text makes it editable with the caret there, and the toolbar
 * takes the heading's row. The edit is saved when it ends (clicking outside, Esc, or leaving the task), so each
 * edit is one revision.
 */
function Description({ taskId, description, onSave, overlayContainer }: { taskId: string; description: string; onSave: (d: string) => Promise<boolean>; overlayContainer: HTMLElement | null }) {
  const [editing, setEditing] = useState<{ caretAt?: { x: number; y: number } } | null>(null);
  const [draft, setDraft] = useState(description);
  const [stale, setStale] = useState(false);
  const section = useRef<HTMLElement>(null);
  // The latest values, for the document listener and for saving when the task closes mid-edit.
  const latest = useRef({ draft, dirty: false, onSave, finishing: false });
  latest.current.draft = draft;
  latest.current.onSave = onSave;

  const start = (caretAt?: { x: number; y: number }) => {
    setDraft(description);
    latest.current.dirty = false;
    setStale(false);
    setEditing({ caretAt });
  };
  const discard = () => {
    latest.current.dirty = false;
    setStale(false);
    setEditing(null);
  };
  const finish = async () => {
    const state = latest.current;
    if (state.finishing) return;
    state.finishing = true;
    try {
      // On a conflict the task is refreshed and the draft stays: finishing again saves it over the other change.
      if (state.dirty && !(await state.onSave(state.draft))) return setStale(true);
      discard();
    } finally {
      state.finishing = false;
    }
  };

  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      // The editor's own popups (image and link dialogs, block type menu…) are portaled outside the section.
      if (section.current?.contains(target) || target.closest('.mdxeditor-popup-container, .mdxeditor-select-content, [data-radix-popper-content-wrapper], [data-editor-popup]')) return;
      void finish();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [editing]);
  useEffect(
    () => () => {
      if (latest.current.dirty) void latest.current.onSave(latest.current.draft);
    },
    [],
  );

  return (
    <section
      ref={section}
      aria-label="Description"
      className="relative"
      onKeyDown={(event) => {
        if (editing && event.key === 'Escape' && section.current?.contains(event.target as Node)) {
          event.preventDefault();
          void finish();
        }
      }}
    >
      {!editing && (
        // Over the toolbar's row, which stays reserved so the text never moves.
        <div className="absolute inset-x-0 top-0 z-10 flex h-9 items-center">
          <h3 className="text-sm font-semibold">Description</h3>
          <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => start()}>
            <Pencil /> Edit
          </Button>
        </div>
      )}
      <div
        className={cn(!editing && 'cursor-text')}
        onClick={(event) => {
          if (editing) return;
          const target = event.target as Element;
          const link = target.closest('a');
          if (link) {
            event.preventDefault();
            // Descriptions are untrusted (Agents write them): never a javascript: or data: URL.
            if (/^(https?|mailto):/i.test(link.href)) window.open(link.href, '_blank', 'noopener,noreferrer');
            return;
          }
          // Checkboxes keep working, and selecting text to copy it doesn't start an edit.
          if (target.closest('button, input, label') || getSelection()?.toString()) return;
          start({ x: event.clientX, y: event.clientY });
        }}
      >
        <Suspense fallback={<RichMarkdownView source={description} placeholder={DESCRIPTION_PLACEHOLDER} />}>
          <RichMarkdownEditor
            taskId={taskId}
            label="Description"
            value={editing ? draft : description}
            onChange={(md) => {
              latest.current.dirty = true;
              setDraft(md);
            }}
            readOnly={!editing}
            overlayContainer={overlayContainer}
            caretAt={editing?.caretAt}
            placeholder={DESCRIPTION_PLACEHOLDER}
          />
        </Suspense>
      </div>
      {stale && (
        <p role="status" className="mt-2 text-xs text-amber-500">
          Someone else changed the description while you were editing. Your draft is kept: click outside to save it over theirs, or{' '}
          <button type="button" className="underline underline-offset-2 hover:text-amber-400" onClick={discard}>
            discard your changes
          </button>
          .
        </p>
      )}
    </section>
  );
}
