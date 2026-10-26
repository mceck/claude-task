import type { Tag, Status, Task, TaskSession, User } from '@claude-task/shared';
import { Expand, Minimize2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AgentAvatar, SessionChip } from './agents';
import { Composer, useCommentDraft } from './Composer';
import { Timeline } from './Timeline';

type SessionAction = 'stop' | 'retry' | 'notify';
interface Props {
  children: ReactNode;
  task: Task;
  statuses: Status[];
  tags: Tag[];
  users: User[];
  session: TaskSession | null | undefined;
  onSessionAction: (action: SessionAction) => Promise<void>;
}

export function TaskActivity({ children, task, statuses, tags, users, session, onSessionAction }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [composerVisible, setComposerVisible] = useState(false);
  const draft = useCommentDraft();
  const dialog = useRef<HTMLDivElement>(null);
  const expandTrigger = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const activity = useRef<HTMLElement>(null);
  const updateComposerVisibility = () => {
    if (!container.current || !activity.current) return;
    // Use the whole panel's height so showing the dock doesn't change its own threshold.
    const activityBounds = activity.current.getBoundingClientRect();
    const distance = activityBounds.top - container.current.getBoundingClientRect().bottom;
    // Wait until more of the activity is visible, while keeping short conversations reachable.
    const revealDistance = Math.min(160, activityBounds.height);
    // A small buffer keeps the editor from flickering when scrolling around the boundary.
    setComposerVisible((visible) => distance < -revealDistance + (visible ? 56 : 0));
  };
  useEffect(() => {
    const observer = new ResizeObserver(updateComposerVisibility);
    observer.observe(container.current!);
    observer.observe(details.current!);
    return () => observer.disconnect();
  }, []);
  const timeline = <Timeline taskId={task.id} statuses={statuses} tags={tags} users={users} />;
  const composer = <Composer taskId={task.id} agentId={task.agentId} commands={session?.commands} draft={draft} />;

  return (
    <Dialog open={expanded} onOpenChange={(open) => {
      if (open) savedScrollTop.current = viewport.current?.scrollTop ?? 0;
      setExpanded(open);
    }}>
      <div ref={container} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div ref={viewport} aria-label="Task details" className="min-h-0 flex-1 overflow-y-auto overscroll-contain" onScroll={updateComposerVisibility}>
          <div ref={details} className="space-y-6 px-6 py-5">
            {children}
            <section ref={activity} className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Activity</h3>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DialogTrigger asChild>
                      <Button ref={expandTrigger} variant="ghost" size="icon-sm" aria-label="Expand activity">
                        <Expand />
                      </Button>
                    </DialogTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Open activity full screen</TooltipContent>
                </Tooltip>
              </div>
              {!expanded && timeline}
            </section>
          </div>
        </div>
        {!expanded && <ComposerDock visible={composerVisible}>{composer}</ComposerDock>}
      </div>
      <DialogContent
        ref={dialog}
        showCloseButton={false}
        className="inset-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-background p-0 ring-0 data-open:zoom-in-100 data-closed:zoom-out-100 sm:max-w-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialog.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (viewport.current) viewport.current.scrollTop = savedScrollTop.current;
          expandTrigger.current?.focus({ preventScroll: true });
          updateComposerVisibility();
        }}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <span className="font-mono text-muted-foreground">{task.key}</span> Activity
            </DialogTitle>
            <DialogDescription className="mt-1 truncate">{task.title}</DialogDescription>
          </div>
          {session && (
            <div className="flex flex-wrap items-center gap-2">
              <AgentAvatar agent={session.agent} size="sm" />
              <SessionChip session={session} />
              {session.state === 'running' && (
                <Button size="xs" variant="outline" onClick={() => onSessionAction('stop')}>
                  Stop
                </Button>
              )}
              {task.agentId && session.held && (
                <Button size="xs" variant="outline" onClick={() => onSessionAction('retry')}>
                  Retry
                </Button>
              )}
              {session.unseenChanges && (
                <Button size="xs" variant="outline" onClick={() => onSessionAction('notify')}>
                  Notify agent
                </Button>
              )}
            </div>
          )}
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Exit full screen" title="Exit full screen (Esc)">
              <Minimize2 />
            </Button>
          </DialogClose>
        </header>
        <Conversation timeline={timeline} composer={composer} />
      </DialogContent>
    </Dialog>
  );
}

/** Follow new output while at the bottom; reading older activity never snaps back down. */
function Conversation({ timeline, composer }: { timeline: ReactNode; composer: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const scroll = viewport.current!;
    const observer = new ResizeObserver(() => {
      if (following.current) scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(content.current!);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div
        ref={viewport}
        aria-label="Task conversation"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const el = event.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        }}
      >
        <div ref={content} className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
          {timeline}
        </div>
      </div>
      <ComposerDock>{composer}</ComposerDock>
    </>
  );
}

/** Keep the editor outside the scrolling content in every conversation layout. */
function ComposerDock({ children, visible = true }: { children: ReactNode; visible?: boolean }) {
  return (
    <div
      data-slot="composer-dock"
      aria-hidden={!visible}
      inert={!visible}
      className={`grid shrink-0 transition-[grid-template-rows,opacity,transform] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${visible ? 'grid-rows-[1fr] translate-y-0 opacity-100' : 'pointer-events-none grid-rows-[0fr] translate-y-2 opacity-0'}`}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="border-t bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <div className="mx-auto max-h-[45dvh] max-w-4xl overflow-y-auto">{children}</div>
        </div>
      </div>
    </div>
  );
}
