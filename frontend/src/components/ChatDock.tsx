import { AGENTS_TOPIC, taskTopic } from '@claude-task/shared';
import { ArrowUpRight, BookOpen, Bot, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ApiError, errorMessage } from '../api/client';
import { useAgents, useProject, useTask, useTaskPreferences, useTaskSession, useUsers, useWiki, useWikiChats } from '../api/queries';
import { MAX_DOCK_ENTRIES, removeFromDock, toggleInDock, useDock, useDockAvailable } from '../lib/dock';
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

/** Minimized conversations, right-aligned in a row above the page, one card per conversation. */
export function ChatDock() {
  const { entries } = useDock();
  const available = useDockAvailable();
  const viewport = useViewport();
  if (!available || entries.length === 0) return null;

  const pageWidth = viewport.width - SIDEBAR_WIDTH - DOCK_INSET * 2;
  const capacity = Math.max(1, Math.min(MAX_DOCK_ENTRIES, Math.floor((pageWidth + PANEL_GAP) / (PANEL_MIN + PANEL_GAP))));
  const shown = entries.slice(-capacity);
  const width = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor((pageWidth - PANEL_GAP * (shown.length - 1)) / shown.length)));
  const height = Math.min(470, Math.round(viewport.height * 0.6));

  // Above a page's own composer (a Task's or a Wiki Chat's), measured by TaskActivity, never over it.
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-30 flex justify-end px-4"
      style={{ bottom: 'calc(var(--chat-composer-height, 0px) + 1rem)' }}
    >
      {/* The row spans every panel, so only the panels themselves take clicks: the room above a collapsed one shows the page. */}
      <section aria-label="Minimized chats" className="pointer-events-none flex max-w-full items-end gap-3">
        {shown.map((entry) => (
          <DockPanel key={entry.taskId} entry={entry} width={width} height={height} />
        ))}
      </section>
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
 * One conversation in the Dock: the title bar stays, the conversation mounts only while the panel is open, so a
 * collapsed chat neither takes room nor marks itself read. The same TaskActivity as the page keeps drafts, the
 * live Turn and the read position shared.
 */
function DockPanel({ entry, width, height }: { entry: DockEntry; width: number; height: number }) {
  const { collapsed: collapsedIds } = useDock();
  const collapsed = collapsedIds.includes(entry.taskId);
  const navigate = useNavigate();
  const task = useTask(entry.taskId);
  const session = useTaskSession(entry.taskId);
  const users = useUsers();
  const agents = useAgents();
  const wiki = useWiki(entry.wikiId);
  const project = useProject(entry.wikiId ? undefined : task.data?.projectId);
  const chats = useWikiChats(entry.wikiId);
  const preferences = useTaskPreferences(entry.wikiId ? undefined : task.data?.projectId);
  const chat = entry.wikiId ? chats.data?.find((c) => c.id === entry.taskId) : undefined;
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

  const open = () => {
    if (!href) return;
    // The conversation moves to its page: it must not be in both places.
    removeFromDock(entry.taskId);
    navigate(href);
  };

  return (
    <article
      aria-label={title ? `Minimized chat: ${title}` : 'Minimized chat'}
      style={{ width, height: collapsed ? 50 : height }}
      className={cn(
        'pointer-events-auto flex shrink-0 flex-col overflow-hidden rounded-xl border bg-card shadow-2xl shadow-black/50',
        'animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none',
        'transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
      )}
    >
      <header className={cn('flex h-[50px] shrink-0 items-center gap-1 pr-1.5 pl-2.5', !collapsed && 'border-b')}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Open ${title ?? 'chat'}` : `Collapse ${title ?? 'chat'}`}
          onClick={() => toggleInDock(entry.taskId)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 pr-1 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {agent ? (
            <AgentAvatar agent={agent} size="sm" state={state} />
          ) : (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-400 ring-2 ring-background">
              {entry.wikiId ? <BookOpen className="size-3.5" /> : <Bot className="size-3.5" />}
            </span>
          )}
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
