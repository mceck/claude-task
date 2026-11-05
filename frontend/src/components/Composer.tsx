import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, chatCommands, matchCommands, skillToken } from '@claude-task/shared';
import type { ChatCommand, Comment, ScheduledMessage } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, FileText, Lock, Paperclip, X, Zap } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { errorMessage, post } from '../api/client';
import { putScheduledMessage, putTimelineItem } from '../lib/cache';
import { commentDrafts } from '../lib/drafts';
import { useAgent, useMe, useTimeline, useUsers } from '../api/queries';
import { ErrorText, Kbd } from './common';
import type { CommandToken, CommentEditorHandle } from './RichMarkdownEditor';
import { dueError, SchedulePicker, toInstant } from './ScheduledMessages';

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

const CommentEditor = lazy(() => import('./RichMarkdownEditor').then((m) => ({ default: m.CommentEditor })));

/** Kept by the conversation view so expanding it preserves text, notes and attachments. */
export function useCommentDraft(taskId: string) {
  const [body, setBody] = useState(() => commentDrafts.get(taskId)?.body ?? '');
  const [internal, setInternal] = useState(() => commentDrafts.get(taskId)?.internal ?? false);
  const [files, setFiles] = useState<File[]>(() => commentDrafts.get(taskId)?.files ?? []);
  // A `datetime-local` value; empty sends now. Not kept in the draft: a plan is made per message.
  const [scheduledFor, setScheduledFor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (body.trim() || files.length > 0) commentDrafts.set(taskId, { body, internal, files });
    else commentDrafts.delete(taskId);
  }, [taskId, body, internal, files]);
  return { body, setBody, internal, setInternal, files, setFiles, scheduledFor, setScheduledFor, error, setError, busy, setBusy };
}

export function Composer({
  taskId,
  agentId,
  commands,
  interruptible = false,
  draft,
}: {
  taskId: string;
  agentId?: string | null;
  commands?: ChatCommand[];
  /** The Agent is running a Turn on this Task that Interrupt and send can end. */
  interruptible?: boolean;
  draft: ReturnType<typeof useCommentDraft>;
}) {
  const { body, setBody, internal, setInternal, files, setFiles, scheduledFor, setScheduledFor, error, setError, busy, setBusy } = draft;
  // What the editor holds now, which can be ahead of `body` in a send started a few renders ago.
  const latestBody = useRef(body);
  latestBody.current = body;
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const users = useUsers();
  const [mention, setMention] = useState<{ query: string } | null>(null);
  const agent = useAgent(agentId ?? undefined);
  const editor = useRef<CommentEditorHandle>(null);
  const listId = useId();
  const [token, setToken] = useState<CommandToken | null>(null);
  const [active, setActive] = useState(0);
  // Escape hides the suggestions for this token only; typing on shows them again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const tokenKey = mention ? `@${mention.query}|${body}` : token && `${token.query}|${token.atStart}|${body}`;
  const available = commands ?? (agentId ? chatCommands(null, agent.data?.skillCommands ?? []) : []);
  const suggestions =
    token && !mention && !internal && dismissed !== tokenKey
      ? matchCommands(available.filter((s) => token.atStart || s.kind === 'skill'), token.query)
      : [];
  const people = mention && dismissed !== tokenKey
    ? (users.data ?? []).filter((u) => u.active && `${u.displayName} ${u.email}`.toLowerCase().includes(mention.query))
    : [];
  const count = mention ? people.length : suggestions.length;
  const selected = Math.min(active, count - 1);
  useEffect(() => {
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [listId, selected]);
  const chooseSkill = (name: string) => {
    editor.current?.chooseCommand(name);
    setActive(0);
  };
  const onCommandKey = (key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape') => {
    if (count === 0) return false;
    if (key === 'ArrowDown' || key === 'ArrowUp') setActive((selected + (key === 'ArrowDown' ? 1 : -1) + count) % count);
    else if (key === 'Escape') setDismissed(tokenKey);
    else if (mention) {
      const user = people[selected]!;
      editor.current?.chooseMention(user.id, user.displayName);
      setActive(0);
    } else chooseSkill(suggestions[selected]!.name);
    return true;
  };

  const addFiles = (incoming: File[]) => {
    const tooBig = incoming.find((f) => f.size > ATTACHMENT_MAX_BYTES);
    if (tooBig) return setError(`${tooBig.name} is larger than ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
    const next = [...files, ...incoming];
    if (next.length > ATTACHMENT_MAX_FILES) return setError(`At most ${ATTACHMENT_MAX_FILES} files per comment`);
    setError(null);
    setFiles(next);
  };

  const me = useMe();
  const timeline = useTimeline(taskId);
  // One of the User's own Comments the Agent hasn't read yet: an empty Interrupt and send hurries it.
  const waiting = (timeline.data?.pages[0]?.items ?? []).some(
    (i) => i.type === 'comment' && i.comment.author.type === 'user' && i.comment.author.id === me.data?.id &&
      (i.comment.delivery?.state === 'queued' || i.comment.delivery?.state === 'delivered'),
  );
  const empty = !body.trim() && files.length === 0;
  // Interrupt and send stops the Agent's Turn so it reads the Comment at once, instead of after its current
  // step. With nothing typed it hurries the User's waiting Comments, so it shows only when there are some.
  const canInterrupt = interruptible && !internal && !scheduledFor && (!empty || waiting);
  const interruptWaiting = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/tasks/${taskId}/session/interrupt`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (interrupt = false) => {
    if (busy) return;
    if (empty) {
      if (interrupt && canInterrupt) await interruptWaiting();
      return;
    }
    const problem = scheduledFor ? dueError(scheduledFor) : null;
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      let payload: Record<string, unknown> | FormData = { body, internal };
      if (scheduledFor) payload.dueAt = toInstant(scheduledFor);
      else if (interrupt && canInterrupt) payload.interrupt = true;
      if (files.length > 0) {
        const form = new FormData();
        for (const [name, value] of Object.entries(payload)) form.set(name, String(value));
        for (const f of files) form.append('files', f, f.name);
        payload = form;
      }
      if (scheduledFor) {
        const { message } = await post<{ message: ScheduledMessage }>(`/tasks/${taskId}/scheduled-messages`, payload);
        putScheduledMessage(qc, message);
        setScheduledFor('');
      } else {
        const { comment } = await post<{ comment: Comment }>(`/tasks/${taskId}/comments`, payload);
        putTimelineItem(qc, taskId, { type: 'comment', id: comment.id, createdAt: comment.createdAt, comment });
      }
      // Only what was sent goes: text typed or files added while sending stay. Text that changed what was
      // sent is kept whole, rather than guessing which part is new.
      const now = latestBody.current;
      if (now === body || now.startsWith(body)) {
        const rest = now.slice(body.length).trimStart();
        editor.current?.setValue(rest);
        setBody(rest);
      }
      setFiles((current) => current.filter((f) => !files.includes(f)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Files become attachments of the comment, so they're caught before the editor would embed them.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      addFiles(
        pasted.map((f, i) =>
          f.name && f.name !== 'image.png'
            ? f
            : new File([f], `pasted-${Date.now()}-${i}.${f.type.split('/')[1] ?? 'png'}`, { type: f.type }),
        ),
      );
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      addFiles([...e.dataTransfer.files]);
    }
  };

  const placeholder = internal ? 'Write an internal chat…' : 'Leave a comment…';
  const submitLabel = scheduledFor ? 'Schedule' : internal ? 'Send' : 'Comment';

  return (
    <Popover open={count > 0}>
      <PopoverAnchor asChild>
        <div
          data-internal={internal}
          onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
          onDragLeave={() => setDragOver(false)}
          onPasteCapture={onPaste}
          onDropCapture={onDrop}
          className={cn(
            '@container rounded-xl border bg-background/50 p-3 transition-colors focus-within:border-ring/60 dark:bg-input/10',
            internal && 'border-dashed border-slate-400/50 bg-slate-500/[0.08] focus-within:border-slate-400/70 dark:bg-slate-500/[0.08]',
            dragOver && 'border-dashed border-primary',
          )}
        >
          {internal && (
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="size-3" /> Internal chat: only people see this, never the agent.
            </p>
          )}
          <Suspense
            fallback={
              <p className="text-sm leading-relaxed text-muted-foreground">{placeholder}</p>
            }
          >
            <CommentEditor
              handle={editor}
              taskId={taskId}
              label="Comment"
              placeholder={placeholder}
              initialValue={body}
              onChange={setBody}
              onSubmit={({ interrupt }) => void submit(interrupt)}
              compact
              onCommandToken={(next) => {
                if (next?.query !== token?.query || next?.atStart !== token?.atStart) setActive(0);
                setToken(next);
              }}
              onMentionToken={(next) => {
                if (next?.query !== mention?.query) setActive(0);
                setMention(next);
              }}
              onCommandKey={onCommandKey}
              ariaControls={count ? listId : undefined}
              ariaActiveDescendant={count ? `${listId}-${selected}` : undefined}
            />
          </Suspense>
          {files.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Files to attach">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-md border bg-muted/50 py-0.5 pr-1 pl-2 text-xs">
                  <FileText className="size-3 text-muted-foreground" />
                  {f.name}
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t pt-2">
            <div className="flex items-center gap-2">
              <Switch
                id={`internal-${taskId}`}
                size="sm"
                checked={internal}
                onCheckedChange={setInternal}
                className="data-[state=checked]:bg-amber-500"
              />
              <Label htmlFor={`internal-${taskId}`} className={cn('text-xs', internal ? 'text-amber-500' : 'text-muted-foreground')}>
                Internal chat
              </Label>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              aria-label="Attach files"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <div className="ml-auto flex items-center gap-2">
              {/* Hidden in a narrow Dock panel, where it would push the Comment button out of view. */}
              <span className="mr-1 hidden items-center gap-1 text-[11px] text-muted-foreground @sm:flex">
                <Kbd>⇧↵</Kbd> new line
              </span>
              {/* Schedule, Attach and Interrupt are icons only, kept close, so the row fits a narrow Dock panel. */}
              <div className="flex items-center gap-0.5">
                <SchedulePicker value={scheduledFor} onChange={setScheduledFor} disabled={busy} />
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  aria-label="Attach a file"
                  title="Attach a file"
                  onClick={() => fileInput.current?.click()}
                >
                  <Paperclip />
                </Button>
                {canInterrupt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-primary hover:text-primary"
                    onClick={() => void submit(true)}
                    disabled={busy}
                    aria-label={empty ? 'Interrupt so the agent reads your message' : 'Interrupt and send'}
                    title={
                      empty
                        ? `Stops the agent's current step so it reads your waiting message now (${MOD_KEY}+Enter)`
                        : `Interrupt and send: stops the agent's current step so it reads this at once (${MOD_KEY}+Enter)`
                    }
                  >
                    <Zap />
                  </Button>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={busy || empty}
                aria-label={submitLabel}
                className={cn(internal && 'bg-slate-600 text-white hover:bg-slate-600/85')}
              >
                {/* The action keeps its name for screen readers; in a narrow panel only the arrow shows. */}
                <span className="hidden @sm:inline">{submitLabel}</span>
                <ArrowUp />
              </Button>
            </div>
          </div>
        </div>
      </PopoverAnchor>
      {/* Above the composer, over the conversation, so the box keeps its shape. */}
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-(--radix-popper-anchor-width) max-w-xl p-1"
        // The caret stays in the editor, which drives the list with its keys.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <ul id={listId} role="listbox" aria-label={mention ? "Mention people" : "Chat commands"} className="max-h-60 overflow-auto">
          {people.map((user, i) => (
            <li key={user.id}>
              <button
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === selected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => { editor.current?.chooseMention(user.id, user.displayName); setActive(0); }}
                className={cn('w-full rounded-md px-3 py-2 text-left text-sm', i === selected && 'bg-accent')}
              >
                <span className="font-medium">@{user.displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
              </button>
            </li>
          ))}
          {suggestions.map((skill, i) => (
            <li key={skill.name}>
              <button
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === selected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => chooseSkill(skill.name)}
                className={cn('w-full rounded-md px-3 py-2 text-left text-sm', i === selected && 'bg-accent')}
              >
                <span className="font-medium">/{skill.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {skill.kind === 'skill' ? 'Skill' : skill.kind === 'mcp' ? 'MCP' : 'Claude'}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
