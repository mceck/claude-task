import type { Label, Status, Task, TaskSession, User } from '@claude-task/shared';
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
  task: Task;
  statuses: Status[];
  labels: Label[];
  users: User[];
  session: TaskSession | null | undefined;
  onSessionAction: (action: SessionAction) => Promise<void>;
}

export function TaskActivity({ task, statuses, labels, users, session, onSessionAction }: Props) {
  const [expanded, setExpanded] = useState(false);
  const draft = useCommentDraft();
  const dialog = useRef<HTMLDivElement>(null);
  const timeline = <Timeline taskId={task.id} statuses={statuses} labels={labels} users={users} />;
  const composer = <Composer taskId={task.id} draft={draft} />;

  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Activity</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Expand activity">
                  <Expand />
                </Button>
              </DialogTrigger>
            </TooltipTrigger>
            <TooltipContent>Open activity full screen</TooltipContent>
          </Tooltip>
        </div>
        {!expanded && (
          <>
            {timeline}
            {composer}
          </>
        )}
      </section>
      <DialogContent
        ref={dialog}
        showCloseButton={false}
        className="inset-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-background p-0 ring-0 data-open:zoom-in-100 data-closed:zoom-out-100 sm:max-w-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialog.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')?.focus({ preventScroll: true });
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
      <div className="shrink-0 border-t bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto max-h-[45dvh] max-w-4xl overflow-y-auto">{composer}</div>
      </div>
    </>
  );
}
