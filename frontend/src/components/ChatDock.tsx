import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent, Modifier } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AGENTS_TOPIC, taskTopic } from '@claude-task/shared';
import { ArrowUpRight, BookOpen, Bot, ChevronDown, ChevronUp, GripVertical, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ApiError, errorMessage } from '../api/client';
import { useAgents, useProject, useTask, useTaskPreferences, useTaskSession, useUsers, useWiki, useWikiChats } from '../api/queries';
import { MAX_DOCK_ENTRIES, moveInDock, removeFromDock, toggleInDock, useDock, useDockAvailable } from '../lib/dock';
import type { DockEntry } from '../lib/dock';
import { useTopic } from '../lib/realtime';
import { AgentAvatar } from './agents';
import { ErrorText, Loading } from './common';
import { InDockContext, TaskActivity } from './TaskActivity';

/** Layout's sidebar; the Dock lives in the column beside it. */
const SIDEBAR_WIDTH = 240;
const DOCK_INSET = 16;
const PANEL_GAP = 12;
const PANEL_MIN = 300;
const PANEL_MAX = 380;
const SCREEN_EDGE = 8;

/** The row hugs the right edge, so a bar dragged toward the corner would hang off it: the copy stays inside the window. */
const keepOnScreen: Modifier = ({ transform, draggingNodeRect }) => {
  if (!draggingNodeRect) return transform;
  const { left, top, width, height } = draggingNodeRect;
  const x = Math.min(Math.max(transform.x, SCREEN_EDGE - left), window.innerWidth - SCREEN_EDGE - width - left);
  const y = Math.min(Math.max(transform.y, SCREEN_EDGE - top), window.innerHeight - SCREEN_EDGE - height - top);
  return { ...transform, x, y };
};

/** Minimized conversations, right-aligned in a row above the page, one card per conversation. */
export function ChatDock() {
  const { entries } = useDock();
  const available = useDockAvailable();
  const viewport = useViewport();
  const [dragging, setDragging] = useState<string | null>(null);
  // A click on a bar must stay a click: a pointer drag begins only after a few pixels, and Space starts one from the keyboard.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (!available || entries.length === 0) return null;

  const pageWidth = viewport.width - SIDEBAR_WIDTH - DOCK_INSET * 2;
  const capacity = Math.max(1, Math.min(MAX_DOCK_ENTRIES, Math.floor((pageWidth + PANEL_GAP) / (PANEL_MIN + PANEL_GAP))));
  const shown = entries.slice(-capacity);
  const width = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor((pageWidth - PANEL_GAP * (shown.length - 1)) / shown.length)));
  const height = Math.min(470, Math.round(viewport.height * 0.6));
  const dragged = shown.find((entry) => entry.taskId === dragging);

  // Dropping a panel on another's place reorders the stored entries; nothing else about them changes.
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (over && active.id !== over.id) moveInDock(String(active.id), String(over.id));
  };

  // Above a page's own composer (a Task's or a Wiki Chat's), measured by TaskActivity, never over it.
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-30 flex justify-end px-4"
      style={{ bottom: 'calc(var(--chat-composer-height, 0px) + 1rem)' }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <SortableContext items={shown.map((entry) => entry.taskId)} strategy={horizontalListSortingStrategy}>
          {/* The row spans every panel, so only the panels themselves take clicks: the room above a collapsed one shows the page. */}
          <section aria-label="Minimized chats" className="pointer-events-none flex max-w-full items-end gap-3">
            {shown.map((entry) => (
              <DockPanel key={entry.taskId} entry={entry} width={width} height={height} />
            ))}
          </section>
        </SortableContext>
        {/* What follows the pointer is the bar alone: the conversation it stands for would be as tall as the panel. */}
        <DragOverlay dropAnimation={null} modifiers={[keepOnScreen]}>
          {dragged && <DockDragBar entry={dragged} width={width} />}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function useViewport() {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return viewport;
}

/**
 * Everything a panel's bar and its drag preview read about an entry. The queries are the page's own, cached, so the
 * preview costs no request.
 */
function useDockEntryData(entry: DockEntry) {
  const task = useTask(entry.taskId);
  const session = useTaskSession(entry.taskId);
  const users = useUsers();
  const agents = useAgents();
  const wiki = useWiki(entry.wikiId);
  const project = useProject(entry.wikiId ? undefined : task.data?.projectId);
  const chats = useWikiChats(entry.wikiId);
  const preferences = useTaskPreferences(entry.wikiId ? undefined : task.data?.projectId);
  const chat = entry.wikiId ? chats.data?.find((c) => c.id === entry.taskId) : undefined;

  const agentId = chat?.agentId ?? task.data?.agentId ?? null;
  const agent = agentId ? agents.data?.find((a) => a.id === agentId) : undefined;
  const state = session.data?.state ?? chat?.sessionState ?? null;
  const running = state === 'running';
  const unread = entry.wikiId ? !!chat?.unread : !!preferences.data?.find((p) => p.taskId === entry.taskId)?.unread;
  const title = chat?.title ?? task.data?.title;
  // The Project (or Wiki) and the Task Key stay visible, collapsed too, so a bar is identifiable at a glance.
  const owner = entry.wikiId ? wiki.data?.name : project.data?.project.name;
  const subtitle = [owner, task.data?.key].filter(Boolean).join(' · ') || undefined;
  const otherAgent =
    chat?.agentId && wiki.data && chat.agentId !== wiki.data.agentId
      ? agents.data?.find((a) => a.id === chat.agentId)
      : undefined;
  const readOnly = otherAgent
    ? `This chat is run by ${otherAgent.name}: assign the wiki back to that agent to continue it.`
    : undefined;
  const href = entry.wikiId ? `/wikis/${entry.wikiId}/chats/${entry.taskId}` : task.data ? `/t/${task.data.key}` : undefined;

  return { task, session, users, agent, state, running, unread, title, subtitle, readOnly, href, isWiki: entry.wikiId !== undefined };
}

type DockEntryData = ReturnType<typeof useDockEntryData>;

/**
 * One conversation in the Dock: the title bar stays, the conversation mounts only while the panel is open, so a
 * collapsed chat neither takes room nor marks itself read. The same TaskActivity as the page keeps drafts, the
 * live Turn and the read position shared.
 */
function DockPanel({ entry, width, height }: { entry: DockEntry; width: number; height: number }) {
  const { collapsed: collapsedIds } = useDock();
  const collapsed = collapsedIds.includes(entry.taskId);
  const navigate = useNavigate();
  const info = useDockEntryData(entry);
  const { task, session, users, title, readOnly, href } = info;
  useTopic(taskTopic(entry.taskId));
  useTopic(AGENTS_TOPIC);
  useTopic(entry.wikiId ? 'wikis' : null);

  // Deleting the conversation anywhere takes its panel away silently. A Wiki Chat is cleared, not deleted, so a
  // new Conversation Generation is what tells a Delete Chat from an empty Chat still waiting for its first Comment.
  const missing =
    (task.error instanceof ApiError && task.error.status === 404) ||
    (entry.wikiId !== undefined &&
      task.data !== undefined &&
      typeof entry.generation === 'number' &&
      (task.data.chatGeneration ?? 0) > entry.generation);
  useEffect(() => {
    if (missing) removeFromDock(entry.taskId);
  }, [missing, entry.taskId]);

  const sortable = useSortable({ id: entry.taskId });

  const open = () => {
    if (!href) return;
    // The conversation moves to its page: it must not be in both places.
    removeFromDock(entry.taskId);
    navigate(href);
  };

  return (
    <article
      ref={sortable.setNodeRef}
      aria-label={title ? `Minimized chat: ${title}` : 'Minimized chat'}
      style={{
        width,
        height: collapsed ? 50 : height,
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        'pointer-events-auto flex shrink-0 flex-col overflow-hidden rounded-xl border bg-card shadow-2xl shadow-black/50',
        'animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none',
        'transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        sortable.isDragging && 'opacity-40',
      )}
    >
      <header className={cn('group/bar flex h-[50px] shrink-0 items-center gap-0.5 pr-1.5 pl-1.5', !collapsed && 'border-b')}>
        {/* Out of the way until the bar is hovered or reached from the keyboard, and always shown where a tap replaces the pointer. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={sortable.setActivatorNodeRef}
              type="button"
              aria-label={`Drag ${title ?? 'chat'}`}
              className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground opacity-0 outline-none transition-opacity group-focus-within/bar:opacity-100 group-hover/bar:opacity-100 hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing [@media(pointer:coarse)]:opacity-100"
              {...sortable.attributes}
              {...sortable.listeners}
            >
              <GripVertical className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Drag to reorder</TooltipContent>
        </Tooltip>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Open ${title ?? 'chat'}` : `Collapse ${title ?? 'chat'}`}
          onClick={() => toggleInDock(entry.taskId)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 pr-1 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <DockBarFace info={info} collapsed={collapsed} />
          {collapsed ? (
            <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          )}
        </button>
        {!collapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Open full page"
                disabled={!href}
                onClick={open}
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                <ArrowUpRight className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Open full page</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Close chat"
              onClick={() => removeFromDock(entry.taskId)}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </header>
      {!collapsed &&
        (task.isPending ? (
          <Loading className="flex-1" />
        ) : task.error ? (
          <div className="p-4">
            <ErrorText>{errorMessage(task.error)}</ErrorText>
          </div>
        ) : (
          task.data && (
            <InDockContext.Provider value={true}>
              <TaskActivity
                task={task.data}
                statuses={[]}
                tags={[]}
                users={users.data ?? []}
                session={session.data}
                hideChanges
                readOnly={readOnly}
              />
            </InDockContext.Provider>
          )
        ))}
    </article>
  );
}

/** The bar's face: the Agent and its state, the title, the unread dot and the context line under it. */
function DockBarFace({ info, collapsed = false }: { info: DockEntryData; collapsed?: boolean }) {
  const { agent, state, running, unread, title, subtitle, isWiki } = info;
  // A collapsed bar shows no conversation, so unread activity has to be visible on the bar itself: the dot alone is
  // easy to miss, and a halo around the avatar is not. Opening the panel reads it, and the halo goes with the dot.
  const showUnreadHalo = collapsed && unread;
  return (
    <>
      <span className="relative inline-flex shrink-0">
        {showUnreadHalo && (
          <span aria-hidden className="dock-unread-halo pointer-events-none absolute -inset-1 rounded-xl" />
        )}
        {agent ? (
          <AgentAvatar agent={agent} size="sm" state={state} />
        ) : (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-400 ring-2 ring-background">
            {isWiki ? <BookOpen className="size-3.5" /> : <Bot className="size-3.5" />}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {unread && <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" />}
          {title ? (
            <span className="truncate text-[13px] leading-5 font-semibold">{title}</span>
          ) : (
            <span className="h-3 w-32 animate-pulse rounded bg-muted" aria-label="Loading chat" />
          )}
        </span>
        {subtitle && (
          <span className="flex items-center gap-1 truncate text-[10.5px] text-muted-foreground">
            {subtitle}
            {running && ' · running'}
          </span>
        )}
      </span>
    </>
  );
}

/** What follows the pointer while a panel is dragged: its bar, without the conversation behind it. */
function DockDragBar({ entry, width }: { entry: DockEntry; width: number }) {
  const info = useDockEntryData(entry);
  return (
    <div
      style={{ width }}
      className="pointer-events-none flex h-[50px] items-center gap-2 rounded-xl border bg-card px-2.5 shadow-2xl shadow-black/50 ring-1 ring-primary/30"
    >
      <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
      <DockBarFace info={info} />
    </div>
  );
}
