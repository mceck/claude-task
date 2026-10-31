import type { Tag, Status, Task, TaskSession, User } from '@claude-task/shared';
import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { put } from '../api/client';
import { useTimeline } from '../api/queries';
import { ActiveRuns } from './ActiveRuns';
import { Composer, useCommentDraft } from './Composer';
import { ScheduledStrip } from './ScheduledMessages';
import { StopFollowing, Timeline } from './Timeline';

interface Props {
  task: Task;
  statuses: Status[];
  tags: Tag[];
  users: User[];
  session: TaskSession | null | undefined;
  /** Shown just above the composer, e.g. the "agent hasn't seen the changes" notice. */
  notice?: ReactNode;
  /** Leaves field changes off the Timeline. */
  hideChanges: boolean;
  /** Replaces the composer with this reason when the conversation cannot be written in. */
  readOnly?: string;
  /** The composer is bottom chrome of the page: the Chat Dock keeps its panels above it. */
  reserveDockSpace?: boolean;
}

/** Set inside the Chat Dock, so a Dock panel's composer does not push the Dock around. */
export const InDockContext = createContext(false);

/** The Task's conversation: the Timeline, following new output while at the bottom, with the composer docked below. */
export function TaskActivity({ task, statuses, tags, users, session, notice, hideChanges, readOnly, reserveDockSpace }: Props) {
  const draft = useCommentDraft(task.id);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const inDock = useContext(InDockContext);
  const following = useRef(true);
  const markRead = useReadPosition(task.id, following);
  // The Dock sits at the bottom of the page, where this composer is: publishing its height keeps the two apart.
  useEffect(() => {
    const el = composer.current;
    if (!el || inDock || !reserveDockSpace) return;
    const publish = () => document.documentElement.style.setProperty('--chat-composer-height', `${el.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--chat-composer-height');
    };
  }, [inDock, reserveDockSpace]);
  useEffect(() => {
    const scroll = viewport.current!;
    const observer = new ResizeObserver(() => {
      if (following.current) scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(content.current!);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);
  // Following resumes when the reader scrolls back to the bottom.
  const stopFollowing = useCallback(() => {
    following.current = false;
  }, []);

  return (
    <section aria-label="Task activity" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={viewport}
        aria-label="Task conversation"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const el = event.currentTarget;
          // Reading older activity never snaps back down.
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          markRead();
        }}
      >
        <div ref={content} className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          <StopFollowing.Provider value={stopFollowing}>
            <Timeline taskId={task.id} agentId={task.agentId} hideChanges={hideChanges} statuses={statuses} tags={tags} users={users} />
          </StopFollowing.Provider>
        </div>
      </div>
      <div ref={composer} className="shrink-0 border-t bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto max-h-[45dvh] max-w-3xl space-y-3 overflow-y-auto">
          <ActiveRuns taskId={task.id} />
          {notice}
          <ScheduledStrip taskId={task.id} />
          {readOnly ? (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{readOnly}</p>
          ) : (
            <Composer taskId={task.id} agentId={task.agentId} commands={session?.commands} draft={draft} />
          )}
        </div>
      </div>
    </section>
  );
}

/** Moves the User's Read Position to the newest entry while the conversation is on screen and scrolled to the bottom. */
function useReadPosition(taskId: string, atBottom: RefObject<boolean>) {
  const timeline = useTimeline(taskId);
  const newest = timeline.data?.pages[0]?.items[0]?.id;
  const sent = useRef<string | null>(null);
  const markRead = useCallback(() => {
    if (!newest || newest === sent.current || !atBottom.current || document.visibilityState !== 'visible') return;
    sent.current = newest;
    // Best effort: the next entry or scroll tries again.
    put(`/tasks/${taskId}/read-position`, { itemId: newest }).catch(() => {});
  }, [taskId, newest, atBottom]);
  useEffect(() => {
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
  }, [markRead]);
  return markRead;
}
