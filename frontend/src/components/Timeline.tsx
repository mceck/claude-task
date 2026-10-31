import { PRIORITIES, pullRequestNoun, pullRequestRef } from '@claude-task/shared';
import type { Agent, AgentItem, Attachment, Comment, GitProviderKind, Tag, Priority, Revision, RevisionChange, Status, TimelineItem, User } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Bot, ChevronDown, ChevronUp, Download, FileText, Flag, Lock, MoreHorizontal, Pencil, Tag as TagIcon, Trash2, TriangleAlert, Type, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { HiddenTimelineItems } from '../lib/timeline-filter';
import { useHiddenTimelineItems } from '../lib/timeline-filter';
import { del, errorMessage, patch } from '../api/client';
import { withProvider } from './Git';
import { useAgents, useMe, useTimeline } from '../api/queries';
import { putTimelineItem } from '../lib/cache';
import { expandedFromLive } from '../lib/live';
import { AgentItemView, LiveTurnView } from './AgentTimeline';
import { AgentAvatar, DeliveryTicks } from './agents';
import { ErrorText, Loading, Time, useConfirm, UserAvatar } from './common';
import { Markdown } from './Markdown';
import { QuestionCard, SurveyCard } from './QuestionCards';
import { LimitResumeCard } from './ScheduledMessages';

interface Row {
  item: TimelineItem;
  /** How many identical Revisions this row stands for. */
  count: number;
}

const CommentEditor = lazy(() => import('./RichMarkdownEditor').then((m) => ({ default: m.CommentEditor })));

interface Lookups {
  statuses: Status[];
  tags: Tag[];
  users: User[];
  agents?: Agent[];
}

/** Comments and field changes of a Task, oldest first, with older pages loaded on demand. */
export function Timeline({ taskId, agentId = null, ...rest }: { taskId: string; agentId?: string | null } & Lookups) {
  const hidden = useHiddenTimelineItems();
  const timeline = useTimeline(taskId);
  const agents = useAgents();
  const lookups = { ...rest, agents: agents.data ?? [] };
  if (timeline.isPending) return <Loading />;
  // Only an initial load with nothing to show replaces the conversation; a later failure keeps what was read.
  if (timeline.isLoadingError) return <ErrorText>{errorMessage(timeline.error)}</ErrorText>;
  // An item can sit on two pages when it moved across a page boundary between fetches.
  const seen = new Set<string>();
  const items = timeline.data.pages
    .flatMap((p) => p.items)
    .filter((i) => !seen.has(i.id) && !!seen.add(i.id))
    .reverse();
  const rows = fold(items, hidden, lookups);
  // A Delivery names the Agent of the Job that carried it, known from that Job's items, else the Task's Agent.
  const jobAgents = new Map(items.flatMap((i) => (i.type === 'agent' && i.item.jobId ? [[i.item.jobId, i.item.agentId] as const] : [])));
  const agentName = (delivery: Comment['delivery']) => {
    const id = (delivery?.jobId && jobAgents.get(delivery.jobId)) || agentId;
    return lookups.agents.find((a) => a.id === id)?.name ?? null;
  };

  return (
    <ol aria-label="Timeline" className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-border">
      {timeline.error && (
        <li className="relative pl-10 text-sm text-destructive">
          {errorMessage(timeline.error)}{' '}
          <button type="button" className="underline" onClick={() => void timeline.refetch()}>
            Try again
          </button>
        </li>
      )}
      {timeline.hasNextPage && (
        <li className="relative text-center">
          <Button variant="outline" size="sm" onClick={() => timeline.fetchNextPage()} disabled={timeline.isFetchingNextPage}>
            Load older activity
          </Button>
        </li>
      )}
      {items.length === 0 && <li className="relative pl-10 text-sm text-muted-foreground">No activity yet.</li>}
      {rows.map(({ item, count }) =>
        item.type === 'comment' ? (
          <CommentItem key={item.id} comment={item.comment} taskId={taskId} agents={lookups.agents} deliveryAgent={agentName(item.comment.delivery)} />
        ) : item.type === 'agent' ? (
          <AgentItemView key={item.id} item={item.item as AgentItem} taskId={taskId} />
        ) : (
          <RevisionItem key={item.id} revision={item.revision} count={count} {...lookups} />
        ),
      )}
      <LiveTurnView taskId={taskId} />
    </ol>
  );
}

/** The Timeline as shown: hidden Revisions and Agent Items left out, and identical consecutive Revisions by the same actor folded into the latest. */
function fold(items: TimelineItem[], hidden: HiddenTimelineItems, lookups: Lookups): Row[] {
  const rows: Row[] = [];
  let lastText: string | null = null;
  for (const item of items) {
    if (item.type === 'agent') {
      if (hidden.activity) continue;
      rows.push({ item, count: 1 });
      lastText = null;
      continue;
    }
    if (item.type !== 'revision') {
      rows.push({ item, count: 1 });
      lastText = null;
      continue;
    }
    if (hidden.changes) continue;
    const text = revisionText(item.revision, lookups);
    const last = rows[rows.length - 1];
    if (lastText === text && last?.item.type === 'revision' && last.item.revision.actor.id === item.revision.actor.id) {
      rows[rows.length - 1] = { item, count: last.count + 1 };
    } else {
      rows.push({ item, count: 1 });
    }
    lastText = text;
  }
  return rows;
}

function CommentItem({ comment, taskId, agents, deliveryAgent }: { comment: Comment; taskId: string; agents: Agent[]; deliveryAgent: string | null }) {
  const me = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const own = comment.kind === 'user' && comment.author.type === 'user' && comment.author.id === me.data?.id;
  const canDelete = own || me.data?.role === 'admin';

  const replace = (c: Comment) => putTimelineItem(qc, taskId, { type: 'comment', id: c.id, createdAt: c.createdAt, comment: c });

  const save = async () => {
    try {
      const { comment: updated } = await patch<{ comment: Comment }>(`/comments/${comment.id}`, { body: draft });
      replace(updated);
      setEditing(false);
    } catch (err) {
      toast.error('Couldn’t save the comment', { description: errorMessage(err) });
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: 'Delete this comment?', description: 'Its attachments are deleted too.', confirmLabel: 'Delete', destructive: true }))) return;
    try {
      await del(`/comments/${comment.id}`);
      replace({ ...comment, body: '', attachments: [], deletedAt: new Date().toISOString() });
    } catch (err) {
      toast.error('Couldn’t delete the comment', { description: errorMessage(err) });
    }
  };

  if (comment.deletedAt) {
    return (
      <li className="relative flex items-center gap-3 pl-1.5 text-xs text-muted-foreground italic">
        <span className="z-10 flex size-5 items-center justify-center rounded-full border bg-background">
          <Trash2 className="size-3" />
        </span>
        {comment.author.displayName} deleted a comment · <Time iso={comment.deletedAt} />
      </li>
    );
  }

  const agent = comment.kind === 'agent' ? agents.find((a) => a.id === comment.author.id) : undefined;
  return (
    <li
      id={`comment-${comment.id}`}
      aria-label={comment.internal ? 'Internal chat' : comment.kind === 'agent' ? 'Agent comment' : comment.kind === 'system' ? 'System comment' : 'Comment'}
      className="relative flex gap-3"
    >
      <div className="z-10 shrink-0">
        {agent ? (
          <AgentAvatar agent={agent} size="md" />
        ) : comment.kind === 'agent' ? (
          <span className="flex size-8 items-center justify-center rounded-lg bg-violet-500/20 text-violet-400 ring-2 ring-background">
            <Bot className="size-4" />
          </span>
        ) : comment.kind === 'system' ? (
          <span className="flex size-8 items-center justify-center rounded-full bg-amber-500/15 text-amber-400 ring-2 ring-background">
            <TriangleAlert className="size-4" />
          </span>
        ) : (
          <UserAvatar
            name={comment.author.displayName}
            user={comment.author.id ? { id: comment.author.id, displayName: comment.author.displayName } : undefined}
            size="md"
          />
        )}
      </div>
      <div
        className={cn(
          'min-w-0 flex-1 rounded-xl border bg-background/40 px-4 py-3 dark:bg-muted/20',
          comment.internal && 'border-dashed border-slate-400/50 bg-slate-500/[0.08] dark:bg-slate-500/[0.08]',
          comment.kind === 'agent' && 'border-violet-500/30 bg-violet-500/[0.05]',
          comment.kind === 'system' && 'border-amber-500/30 bg-amber-500/[0.05] dark:bg-amber-500/[0.05]',
        )}
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="text-sm font-medium text-foreground">{comment.author.displayName}</span>
          {comment.kind === 'agent' && <Badge className="h-4 bg-violet-500/20 px-1.5 text-[10px] text-violet-400">Agent</Badge>}
          {comment.kind === 'system' && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">System</Badge>}
          {comment.internal && (
            <Badge variant="outline" className="h-4 gap-1 border-dashed border-slate-400/50 px-1.5 text-[10px] text-slate-400">
              <Lock /> Internal chat
            </Badge>
          )}
          <Time iso={comment.createdAt} />
          {comment.editedAt && <span>· edited</span>}
          {comment.delivery && <DeliveryTicks delivery={comment.delivery} agentName={deliveryAgent} />}
          {(own || canDelete) && !editing && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Comment actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {own && (
                  <DropdownMenuItem onSelect={() => (setDraft(comment.body), setEditing(true))}>
                    <Pencil /> Edit
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem variant="destructive" onSelect={remove}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <div className="rounded-lg border p-2">
              <Suspense fallback={<Markdown source={draft} className="min-h-16" />}>
                <CommentEditor taskId={comment.taskId} label="Edit comment" initialValue={draft} onChange={setDraft} autoFocus />
              </Suspense>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={!draft.trim()}>
                Save
              </Button>
            </div>
          </div>
        ) : comment.question ? (
          <QuestionCard comment={comment} />
        ) : comment.survey ? (
          <SurveyCard comment={comment} />
        ) : comment.answersCommentId ? (
          <button
            type="button"
            className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => document.getElementById(`comment-${comment.answersCommentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            Answered the question
          </button>
        ) : (
          comment.body && (
            <CollapsibleBody expand={expandedFromLive(comment.id)}>
              <Markdown source={comment.body} />
            </CollapsibleBody>
          )
        )}
        {comment.attachments.length > 0 && <Attachments files={comment.attachments} />}
        {comment.limitResume && <LimitResumeCard comment={comment} />}
      </div>
    </li>
  );
}

const COLLAPSED_MAX_HEIGHT = 320;

/** Stops the conversation from following new output at the bottom, so an expanded box stays put to be read from its top. */
export const StopFollowing = createContext<() => void>(() => {});

/**
 * Clamps long content to a max height with a fade and a toggle to expand it. The clamped box stays anchored at the top, also while streaming.
 * Expanding and collapsing animate the max height between the clamp and the content's height; once settled, an expanded box has no limit, so it keeps growing.
 */
export function CollapsibleBody({
  children,
  expand,
  onExpandedChange,
}: {
  children: React.ReactNode;
  /** Opens the box, e.g. for the Comment that replaces a live box the reader had expanded. */
  expand?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(!!expand);
  // A Comment the live text was appended to is already on screen.
  useEffect(() => {
    if (expand) setExpanded(true);
  }, [expand]);
  const [animatedHeight, setAnimatedHeight] = useState<number>();
  const stopFollowing = useContext(StopFollowing);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 40);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const toggle = () => {
    if (!expanded) stopFollowing();
    const el = ref.current;
    if (el && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (expanded) {
        // No limit can't be animated from: pin the current height and reflow before heading to the clamp.
        flushSync(() => setAnimatedHeight(el.scrollHeight));
        void el.offsetHeight;
        setAnimatedHeight(COLLAPSED_MAX_HEIGHT);
      } else {
        setAnimatedHeight(el.scrollHeight);
      }
    }
    setExpanded(!expanded);
    onExpandedChange?.(!expanded);
  };

  const clamped = overflowing && !expanded;
  const maxHeight = animatedHeight ?? (clamped ? COLLAPSED_MAX_HEIGHT : undefined);
  return (
    <div>
      <div
        ref={ref}
        data-testid="comment-body"
        className={cn('relative transition-[max-height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]', maxHeight !== undefined && 'overflow-hidden')}
        style={maxHeight !== undefined ? { maxHeight } : undefined}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && e.propertyName === 'max-height') setAnimatedHeight(undefined);
        }}
      >
        {children}
        {clamped && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />}
      </div>
      {overflowing && (
        <Button variant="ghost" size="xs" className="mt-1 text-muted-foreground" aria-expanded={expanded} onClick={toggle}>
          {expanded ? <ChevronUp /> : <ChevronDown />}
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

const PREVIEWABLE = /^image\/(png|jpeg|gif|webp|avif)$/;

function Attachments({ files }: { files: Attachment[] }) {
  const images = files.filter((f) => PREVIEWABLE.test(f.contentType));
  const others = files.filter((f) => !PREVIEWABLE.test(f.contentType));
  return (
    <div className="mt-3 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((f) => (
            <a key={f.id} href={f.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-lg border transition-opacity hover:opacity-90">
              <img src={f.url} alt={f.filename} className="max-h-56 max-w-full object-contain" />
            </a>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {others.map((f) => (
            <li key={f.id}>
              <a
                href={`${f.url}?download=1`}
                className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs transition-colors hover:bg-muted"
              >
                <FileText className="size-3.5 text-muted-foreground" />
                <span className="font-medium">{f.filename}</span>
                <span className="text-muted-foreground">{formatSize(f.size)}</span>
                <Download className="size-3 text-muted-foreground" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FIELD_ICON: Record<RevisionChange['field'], LucideIcon> = {
  title: Type,
  description: FileText,
  statusId: ArrowRightLeft,
  priority: Flag,
  tagIds: TagIcon,
  assigneeIds: UserRound,
  agentId: Bot,
  pullRequest: ArrowRightLeft,
};

function RevisionItem({ revision, count, ...lookups }: { revision: Revision; count: number } & Lookups) {
  const Icon = FIELD_ICON[revision.changes[0]?.field ?? 'title'];
  return (
    <li className="relative flex items-start gap-3 pl-1.5 text-xs text-muted-foreground">
      <span className="z-10 flex size-5 shrink-0 items-center justify-center rounded-full border bg-background">
        <Icon className="size-3" />
      </span>
      <span className="pt-0.5 leading-relaxed">
        <span className="font-medium text-foreground/90">{revision.actor.displayName}</span>{' '}
        {revisionText(revision, lookups)}
        {count > 1 && ` ×${count}`} · <Time iso={revision.createdAt} />
      </span>
    </li>
  );
}

function revisionText(revision: Revision, lookups: Lookups): string {
  const parts = revision.changes.map((c) => describeChange(c, lookups));
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function describeChange(c: RevisionChange, { statuses, tags, users, agents = [] }: Lookups): string {
  const status = (id: unknown) => statuses.find((s) => s.id === id)?.name ?? 'a deleted status';
  const label = (id: string) => tags.find((l) => l.id === id)?.name ?? 'a deleted tag';
  const user = (id: string) => users.find((u) => u.id === id)?.displayName ?? 'someone';
  const delta = (before: unknown, after: unknown) => {
    const b = before as string[];
    const a = after as string[];
    return { added: a.filter((x) => !b.includes(x)), removed: b.filter((x) => !a.includes(x)) };
  };
  const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);
  switch (c.field) {
    case 'title':
      return `renamed the task from “${c.before}” to “${c.after}”`;
    case 'description':
      return 'updated the description';
    case 'statusId':
      return `moved it from ${status(c.before)} to ${status(c.after)}`;
    case 'priority': {
      const name = (p: unknown) => (PRIORITIES.includes(p as Priority) ? (p === 'none' ? 'none' : String(p)) : String(p));
      return `changed priority from ${name(c.before)} to ${name(c.after)}`;
    }
    case 'tagIds': {
      const { added, removed } = delta(c.before, c.after);
      return [
        added.length && `added ${plural(added.length, 'tag')} ${added.map(label).join(', ')}`,
        removed.length && `removed ${plural(removed.length, 'tag')} ${removed.map(label).join(', ')}`,
      ]
        .filter(Boolean)
        .join(' and ');
    }
    case 'assigneeIds': {
      const { added, removed } = delta(c.before, c.after);
      return [added.length && `assigned ${added.map(user).join(', ')}`, removed.length && `unassigned ${removed.map(user).join(', ')}`]
        .filter(Boolean)
        .join(' and ');
    }
    case 'pullRequest': {
      const after = c.after as { number: number; state: string; draft: boolean; provider?: GitProviderKind } | null;
      if (!after) return `removed the ${pullRequestNoun(withProvider((c.before as { number: number; provider?: GitProviderKind } | null) ?? { number: 0 }).provider)} link`;
      const pr = withProvider(after);
      return `updated ${pullRequestNoun(pr.provider)} ${pullRequestRef(pr)} (${pr.state === 'open' && pr.draft ? 'draft' : pr.state})`;
    }
    case 'agentId': {
      const agent = (id: unknown) => agents.find((a) => a.id === id)?.name ?? 'a deleted agent';
      if (!c.after) return `unassigned the agent ${agent(c.before)}`;
      return c.before ? `reassigned the task from ${agent(c.before)} to ${agent(c.after)}` : `assigned the agent ${agent(c.after)}`;
    }
  }
}
