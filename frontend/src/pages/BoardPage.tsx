import { PullRequestBadge } from '../components/Git';
import { AGENTS_TOPIC, emptyBoardFilter, isFilterActive, matchesBoardFilter, PRIORITIES, projectTopic } from '@claude-task/shared';
import type { BoardFilter, Tag, Priority, Status, Task, TaskCard, User } from '@claude-task/shared';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { CollisionDetection, DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import { generateKeyBetween } from 'fractional-indexing';
import { Flag, MessageSquare, Plus, Search, Settings, Tag as TagIcon, UserRound, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label as FieldLabel } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { errorMessage, post } from '../api/client';
import { keys, useAgents, useBoardTasks, useProject, useUsers } from '../api/queries';
import { AgentAvatar } from '../components/agents';
import { TagChip, Loading, PriorityIcon, PRIORITY_STYLE, StatusDot, UserAvatar } from '../components/common';
import { MultiPick } from '../components/MultiPick';
import { TaskDetail } from '../components/TaskDetail';
import { compareCards, toCard, upsertCard } from '../lib/cache';
import { useTopic } from '../lib/realtime';
import { NotFoundPage } from './NotFoundPage';

const COLUMN_PREFIX = 'column:';

export function BoardPage() {
  const { projectKey } = useParams();
  const [params, setParams] = useSearchParams();
  const showClosed = params.get('closed') === '1';
  const openTask = params.get('task');
  const bundle = useProject(projectKey);
  const project = bundle.data?.project;
  const tasks = useBoardTasks(project?.id, showClosed);
  const users = useUsers();
  const [filter, setFilter] = useState<BoardFilter>(emptyBoardFilter);
  useTopic(project ? projectTopic(project.id) : null);
  useTopic(AGENTS_TOPIC);

  const setParam = (name: string, value: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value === null) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: name !== 'task' },
    );

  if (bundle.isPending) return <Loading className="h-full" />;
  if (!bundle.data) return <NotFoundPage what="Project" />;
  const { statuses, tags } = bundle.data;
  const columns = statuses
    .filter((s) => showClosed || s.category !== 'closed')
    .sort((a, b) => a.position - b.position);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/15 font-mono text-[10px] font-semibold text-primary ring-1 ring-primary/20">
            {project!.key}
          </span>
          <h1 className="truncate font-semibold tracking-tight">{project!.name}</h1>
          {project!.archivedAt && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-500">
              Archived
            </Badge>
          )}
          <Button asChild variant="ghost" size="sm" className="ml-auto text-muted-foreground">
            <Link to={`/p/${project!.key}/settings`}>
              <Settings /> Settings
            </Link>
          </Button>
        </header>
        <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2.5">
          <Filters filter={filter} onChange={setFilter} users={users.data ?? []} tags={tags} />
          <div className="ml-auto flex items-center gap-2">
            <Switch id="show-closed" size="sm" checked={showClosed} onCheckedChange={(on) => setParam('closed', on ? '1' : null)} />
            <FieldLabel htmlFor="show-closed" className="text-muted-foreground">
              Show closed
            </FieldLabel>
          </div>
        </div>
        {tasks.isPending ? (
          <Loading />
        ) : (
          <Board
            projectId={project!.id}
            columns={columns}
            cards={tasks.data ?? []}
            filter={filter}
            tags={tags}
            users={users.data ?? []}
            selectedKey={openTask}
            onOpen={(key) => setParam('task', key)}
          />
        )}
      </div>
      {openTask && (
        <aside className="flex w-[min(720px,50vw)] shrink-0 flex-col border-l bg-card shadow-2xl shadow-black/30 animate-in slide-in-from-right-8 fade-in-0 duration-200">
          <TaskDetail key={openTask} taskKey={openTask} onClose={() => setParam('task', null)} />
        </aside>
      )}
    </div>
  );
}

interface BoardProps {
  projectId: string;
  columns: Status[];
  cards: TaskCard[];
  filter: BoardFilter;
  tags: Tag[];
  users: User[];
  selectedKey: string | null;
  onOpen: (taskKey: string) => void;
}

type Columns = Record<string, string[]>;

function Board({ projectId, columns, cards, filter, tags, users, selectedKey, onOpen }: BoardProps) {
  const qc = useQueryClient();
  const [drag, setDrag] = useState<{ activeId: string; columns: Columns } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const visible: Columns = useMemo(() => {
    const result: Columns = Object.fromEntries(columns.map((s) => [s.id, []]));
    for (const card of [...cards].sort(compareCards)) {
      if (result[card.statusId] && matchesBoardFilter(card, filter)) result[card.statusId]!.push(card.id);
    }
    return result;
  }, [cards, columns, filter]);
  const shown = drag?.columns ?? visible;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // A column contains its cards, so prefer the card under the pointer; over a column's empty
  // space, pick its nearest card (or the column itself when it has none).
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointer = pointerWithin(args);
    const hits = pointer.length > 0 ? pointer : rectIntersection(args);
    const card = hits.find((h) => !String(h.id).startsWith(COLUMN_PREFIX));
    if (card) return [card];
    const col = hits[0];
    if (!col) return [];
    const items = shownRef.current[String(col.id).slice(COLUMN_PREFIX.length)] ?? [];
    const candidates = args.droppableContainers.filter((c) => items.includes(String(c.id)) && c.id !== args.active.id);
    return candidates.length > 0 ? closestCenter({ ...args, droppableContainers: candidates }) : [col];
  }, []);

  const containerOf = (id: string, cols: Columns): string | undefined =>
    id.startsWith(COLUMN_PREFIX) ? id.slice(COLUMN_PREFIX.length) : Object.keys(cols).find((s) => cols[s]!.includes(id));

  const onDragStart = (e: DragStartEvent) => setDrag({ activeId: String(e.active.id), columns: visible });

  // Crossing into another column moves the card there right away, so it can be placed among its cards.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!drag || !over) return;
    const from = containerOf(String(active.id), drag.columns);
    const to = containerOf(String(over.id), drag.columns);
    if (!from || !to || from === to) return;
    const dragged = active.rect.current.translated;
    const below = !!dragged && dragged.top > over.rect.top + over.rect.height / 2;
    setDrag((d) => {
      if (!d) return d;
      const source = d.columns[from]!.filter((id) => id !== active.id);
      const target = [...d.columns[to]!];
      const overIndex = target.indexOf(String(over.id));
      target.splice(overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length, 0, String(active.id));
      return { ...d, columns: { ...d.columns, [from]: source, [to]: target } };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const state = drag;
    setDrag(null);
    if (!state || !over) return;
    const id = String(active.id);
    const statusId = containerOf(id, state.columns);
    if (!statusId) return;
    let list = state.columns[statusId]!;
    const overIndex = list.indexOf(String(over.id));
    const fromIndex = list.indexOf(id);
    if (overIndex >= 0 && overIndex !== fromIndex) list = arrayMove(list, fromIndex, overIndex);
    const index = list.indexOf(id);
    const card = byId.get(id);
    if (!card) return;
    const after = list[index - 1] ? byId.get(list[index - 1]!) : undefined;
    const before = list[index + 1] ? byId.get(list[index + 1]!) : undefined;
    if (card.statusId === statusId && visible[statusId]!.indexOf(id) === index) return;
    void moveCard(card, statusId, after, before);
  };

  const moveCard = async (card: TaskCard, statusId: string, after?: TaskCard, before?: TaskCard) => {
    const snapshot = qc.getQueriesData<TaskCard[]>({ queryKey: keys.tasks(projectId) });
    let position = card.position;
    try {
      position = generateKeyBetween(after?.position ?? null, before?.position ?? null);
    } catch {
      // Neighbors share a key; the server respaces and its answer replaces this guess.
    }
    upsertCard(qc, { ...card, statusId, position });
    try {
      const body = after ? { statusId, afterTaskId: after.id } : before ? { statusId, afterTaskId: null, beforeTaskId: before.id } : { statusId };
      const { task } = await post<{ task: Task }>(`/tasks/${card.id}/move`, body);
      upsertCard(qc, toCard(task));
    } catch (err) {
      for (const [key, data] of snapshot) qc.setQueryData(key, data);
      toast.error(`Couldn’t move ${card.key}`, { description: errorMessage(err) });
    }
  };

  const active = drag ? byId.get(drag.activeId) : undefined;

  return (
    <div className="min-h-0 flex-1 overflow-x-auto">
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDrag(null)}
      >
        <div className="flex h-full items-start gap-4 px-6 py-5">
          {columns.map((status) => (
            <Column key={status.id} projectId={projectId} status={status} count={shown[status.id]!.length}>
              <SortableContext items={shown[status.id]!} strategy={verticalListSortingStrategy}>
                {shown[status.id]!.map((id) => {
                  const card = byId.get(id);
                  return card ? (
                    <SortableCard key={id} card={card} tags={tags} users={users} selected={card.key === selectedKey} onOpen={onOpen} />
                  ) : null;
                })}
              </SortableContext>
            </Column>
          ))}
        </div>
        {/* No drop animation: while it runs, a new drag can't start, so quick successive moves get lost. */}
        <DragOverlay dropAnimation={null}>{active ? <Card card={active} tags={tags} users={users} dragging /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}

function Column({ projectId, status, count, children }: { projectId: string; status: Status; count: number; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${status.id}` });
  return (
    <section
      aria-label={status.name}
      className={cn(
        'flex max-h-full w-[19rem] shrink-0 flex-col rounded-xl border border-transparent bg-muted/40 transition-colors dark:bg-muted/30',
        isOver && 'border-primary/40 bg-primary/5',
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <StatusDot color={status.color} />
        <h2 className="text-sm font-medium">{status.name}</h2>
        <span className="rounded-md bg-background/60 px-1.5 font-mono text-[11px] text-muted-foreground">{count}</span>
      </header>
      <div ref={setNodeRef} className="flex min-h-14 flex-col gap-2 overflow-y-auto px-2 pb-1">
        {children}
      </div>
      <QuickAdd projectId={projectId} statusId={status.id} />
    </section>
  );
}

function QuickAdd({ projectId, statusId }: { projectId: string; statusId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const qc = useQueryClient();

  const submit = async () => {
    if (!title.trim()) return;
    try {
      const { task } = await post<{ task: Task }>(`/projects/${projectId}/tasks`, { title: title.trim(), statusId });
      upsertCard(qc, toCard(task));
      setTitle('');
    } catch (err) {
      toast.error('Couldn’t create the task', { description: errorMessage(err) });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
    if (e.key === 'Escape') {
      setOpen(false);
      setTitle('');
    }
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="mx-2 mb-2 justify-start text-muted-foreground">
        <Plus /> Add task
      </Button>
    );
  }
  return (
    <div className="px-2 pb-2">
      <textarea
        autoFocus
        rows={2}
        placeholder="Task title… (Enter to add, Esc to close)"
        aria-label="New task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => !title && setOpen(false)}
        className="w-full resize-none rounded-lg border border-primary/40 bg-card p-2.5 text-sm shadow-sm outline-none ring-3 ring-primary/10 placeholder:text-muted-foreground"
      />
    </div>
  );
}

interface CardProps {
  card: TaskCard;
  tags: Tag[];
  users: User[];
  onOpen?: (key: string) => void;
  dragging?: boolean;
  selected?: boolean;
}

function SortableCard(props: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.card.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('rounded-lg outline-none', isDragging && 'opacity-30')}
      {...attributes}
      {...listeners}
    >
      <Card {...props} />
    </div>
  );
}

function Card({ card, tags, users, onOpen, dragging, selected }: CardProps) {
  const agents = useAgents();
  const agent = agents.data?.find((a) => a.id === card.agentId);
  const cardTags = card.tagIds.map((id) => tags.find((l) => l.id === id)).filter((l): l is Tag => !!l);
  const assignees = card.assigneeIds.map((id) => users.find((u) => u.id === id)).filter((u): u is User => !!u);
  return (
    <article
      aria-label={card.key}
      onClick={() => onOpen?.(card.key)}
      className={cn(
        'group cursor-pointer rounded-lg border bg-card p-3 shadow-xs transition-all hover:border-foreground/15 hover:shadow-md',
        selected && 'border-primary/60 ring-2 ring-primary/20',
        dragging && 'rotate-2 cursor-grabbing border-primary/50 shadow-2xl shadow-black/40',
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <PriorityIcon priority={card.priority} />
        <span className="font-mono text-[11px] text-muted-foreground">{card.key}</span>
        {agent && <span aria-label={`Agent ${agent.name}: ${card.session?.queuePosition ? `queued #${card.session.queuePosition}` : card.session?.state ?? 'assigned'}`} className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
          <AgentAvatar agent={agent} size="xs" state={card.session?.state} />
          {card.session?.queuePosition ? `#${card.session.queuePosition}` : null}
        </span>}
        {assignees.length > 0 && (
          <div className="ml-auto flex -space-x-1.5">
            {assignees.slice(0, 3).map((u) => (
              <UserAvatar key={u.id} user={u} size="xs" />
            ))}
          </div>
        )}
      </div>
      {card.pullRequest && <div className="mb-2"><PullRequestBadge pr={card.pullRequest} /></div>}
      <p className="text-[13px] leading-snug font-medium text-foreground/90 group-hover:text-foreground">{card.title}</p>
      {(cardTags.length > 0 || card.commentCount > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          {cardTags.map((l) => (
            <TagChip key={l.id} name={l.name} color={l.color} />
          ))}
          {card.commentCount > 0 && (
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground" title={`${card.commentCount} comments`}>
              <MessageSquare className="size-3" /> {card.commentCount}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

// Filters

function Filters({ filter, onChange, users, tags }: { filter: BoardFilter; onChange: (f: BoardFilter) => void; users: User[]; tags: Tag[] }) {
  const set = (patch: Partial<BoardFilter>) => onChange({ ...filter, ...patch });
  return (
    <>
      <InputGroup className="h-7 w-56">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput placeholder="Filter by text or key" aria-label="Filter text" value={filter.text} onChange={(e) => set({ text: e.target.value })} />
      </InputGroup>
      <MultiPick
        label="Assignee"
        icon={<UserRound />}
        options={[
          { value: 'none', label: 'Unassigned' },
          ...users.filter((u) => u.active).map((u) => ({ value: u.id, label: u.displayName, icon: <UserAvatar user={u} size="xs" /> })),
        ]}
        selected={filter.assignees}
        onChange={(assignees) => set({ assignees })}
      />
      <MultiPick
        label="Tags"
        icon={<TagIcon />}
        options={tags.map((l) => ({ value: l.id, label: l.name, icon: <span className="size-2 rounded-full" style={{ backgroundColor: l.color }} /> }))}
        selected={filter.tags}
        onChange={(l) => set({ tags: l })}
      />
      <MultiPick
        label="Priority"
        icon={<Flag />}
        options={PRIORITIES.map((p: Priority) => ({ value: p, label: PRIORITY_STYLE[p].label, icon: <PriorityIcon priority={p} /> }))}
        selected={filter.priorities}
        onChange={(p) => set({ priorities: p as Priority[] })}
      />
      {isFilterActive(filter) && (
        <Button variant="ghost" size="sm" onClick={() => onChange(emptyBoardFilter)}>
          <X /> Clear
        </Button>
      )}
    </>
  );
}
