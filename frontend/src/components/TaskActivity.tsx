import type { Tag, Status, Task, TaskSession, User } from '@claude-task/shared';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Composer, useCommentDraft } from './Composer';
import { Timeline } from './Timeline';

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
}

/** The Task's conversation: the Timeline, following new output while at the bottom, with the composer docked below. */
export function TaskActivity({ task, statuses, tags, users, session, notice, hideChanges }: Props) {
  const draft = useCommentDraft();
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
    <section aria-label="Task activity" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={viewport}
        aria-label="Task conversation"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const el = event.currentTarget;
          // Reading older activity never snaps back down.
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        }}
      >
        <div ref={content} className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          <Timeline taskId={task.id} hideChanges={hideChanges} statuses={statuses} tags={tags} users={users} />
        </div>
      </div>
      <div className="shrink-0 border-t bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto max-h-[45dvh] max-w-3xl space-y-3 overflow-y-auto">
          {notice}
          <Composer taskId={task.id} agentId={task.agentId} commands={session?.commands} draft={draft} />
        </div>
      </div>
    </section>
  );
}
