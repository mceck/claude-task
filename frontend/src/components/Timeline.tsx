import { PRIORITIES } from '@claude-task/shared';
import type { Attachment, Comment, Label, Priority, Revision, RevisionChange, Status, User } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Bot, Download, FileText, Flag, Lock, MoreHorizontal, Pencil, Tag, Trash2, Type, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { del, errorMessage, patch } from '../api/client';
import { useMe, useTimeline } from '../api/queries';
import { putTimelineItem } from '../lib/cache';
import { ErrorText, Loading, Time, useConfirm, UserAvatar } from './common';
import { Markdown, MarkdownEditor } from './Markdown';

interface Lookups {
  statuses: Status[];
  labels: Label[];
  users: User[];
}

/** Comments and field changes of a Task, oldest first, with older pages loaded on demand. */
export function Timeline({ taskId, ...lookups }: { taskId: string } & Lookups) {
  const timeline = useTimeline(taskId);
  if (timeline.isPending) return <Loading />;
  if (timeline.error) return <ErrorText>{errorMessage(timeline.error)}</ErrorText>;
  const items = timeline.data.pages.flatMap((p) => p.items).reverse();

  return (
    <ol aria-label="Timeline" className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-border">
      {timeline.hasNextPage && (
        <li className="relative text-center">
          <Button variant="outline" size="sm" onClick={() => timeline.fetchNextPage()} disabled={timeline.isFetchingNextPage}>
            Load older activity
          </Button>
        </li>
      )}
      {items.length === 0 && <li className="relative pl-10 text-sm text-muted-foreground">No activity yet.</li>}
      {items.map((item) =>
        item.type === 'comment' ? (
          <CommentItem key={item.id} comment={item.comment} taskId={taskId} />
        ) : (
          <RevisionItem key={item.id} revision={item.revision} {...lookups} />
        ),
      )}
    </ol>
  );
}

function CommentItem({ comment, taskId }: { comment: Comment; taskId: string }) {
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

  return (
    <li aria-label={comment.internal ? 'Internal note' : 'Comment'} className="relative flex gap-3">
      <div className="z-10 shrink-0">
        {comment.kind === 'agent' ? (
          <span className="flex size-8 items-center justify-center rounded-full bg-violet-500/20 text-violet-400 ring-2 ring-background">
            <Bot className="size-4" />
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
          comment.internal && 'border-amber-500/40 bg-amber-500/[0.06] dark:bg-amber-500/[0.06]',
          comment.kind === 'agent' && 'border-violet-500/30 bg-violet-500/[0.05]',
        )}
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="text-sm font-medium text-foreground">{comment.author.displayName}</span>
          {comment.kind === 'agent' && <Badge className="h-4 bg-violet-500/20 px-1.5 text-[10px] text-violet-400">Agent</Badge>}
          {comment.kind === 'system' && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">System</Badge>}
          {comment.internal && (
            <Badge variant="outline" className="h-4 gap-1 border-amber-500/40 px-1.5 text-[10px] text-amber-500">
              <Lock /> Internal note
            </Badge>
          )}
          <Time iso={comment.createdAt} />
          {comment.editedAt && <span>· edited</span>}
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
              <MarkdownEditor label="Edit comment" value={draft} onChange={setDraft} autoFocus />
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
        ) : (
          comment.body && <Markdown source={comment.body} />
        )}
        {comment.attachments.length > 0 && <Attachments files={comment.attachments} />}
      </div>
    </li>
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
  labelIds: Tag,
  assigneeIds: UserRound,
};

function RevisionItem({ revision, ...lookups }: { revision: Revision } & Lookups) {
  const Icon = FIELD_ICON[revision.changes[0]?.field ?? 'title'];
  return (
    <li className="relative flex items-start gap-3 pl-1.5 text-xs text-muted-foreground">
      <span className="z-10 flex size-5 shrink-0 items-center justify-center rounded-full border bg-background">
        <Icon className="size-3" />
      </span>
      <span className="pt-0.5 leading-relaxed">
        <span className="font-medium text-foreground/90">{revision.actor.displayName}</span>{' '}
        {revision.changes.map((c, i) => (
          <span key={c.field}>
            {i > 0 && (i === revision.changes.length - 1 ? ' and ' : ', ')}
            {describeChange(c, lookups)}
          </span>
        ))}{' '}
        · <Time iso={revision.createdAt} />
      </span>
    </li>
  );
}

export function describeChange(c: RevisionChange, { statuses, labels, users }: Lookups): string {
  const status = (id: unknown) => statuses.find((s) => s.id === id)?.name ?? 'a deleted status';
  const label = (id: string) => labels.find((l) => l.id === id)?.name ?? 'a deleted label';
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
    case 'labelIds': {
      const { added, removed } = delta(c.before, c.after);
      return [
        added.length && `added ${plural(added.length, 'label')} ${added.map(label).join(', ')}`,
        removed.length && `removed ${plural(removed.length, 'label')} ${removed.map(label).join(', ')}`,
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
  }
}
