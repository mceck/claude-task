import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, chatCommands, skillToken } from '@claude-task/shared';
import type { ChatCommand, Comment } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, FileText, Lock, Paperclip, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { errorMessage, post } from '../api/client';
import { putTimelineItem } from '../lib/cache';
import { useAgent } from '../api/queries';
import { ErrorText, Kbd } from './common';
import { MarkdownEditor } from './Markdown';

/** Kept by the conversation view so expanding it preserves text, notes and attachments. */
export function useCommentDraft() {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return { body, setBody, internal, setInternal, files, setFiles, error, setError, busy, setBusy };
}

export function Composer({
  taskId,
  agentId,
  commands,
  draft,
}: {
  taskId: string;
  agentId?: string | null;
  commands?: ChatCommand[];
  draft?: ReturnType<typeof useCommentDraft>;
}) {
  const localDraft = useCommentDraft();
  const { body, setBody, internal, setInternal, files, setFiles, error, setError, busy, setBusy } = draft ?? localDraft;
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const agent = useAgent(agentId ?? undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0),
    [active, setActive] = useState(0),
    [dismissed, setDismissed] = useState('');
  const token = !internal && dismissed !== `${body}@${caret}` ? skillToken(body, caret) : null;
  const available = commands ?? (agentId ? chatCommands(null, agent.data?.skillCommands ?? []) : []);
  const suggestions = token
    ? available.filter((s) => s.name.toLowerCase().startsWith(token.query) && (token.start === 0 || s.kind === 'skill'))
    : [];
  const selected = Math.min(active, suggestions.length - 1);
  useEffect(() => {
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [listId, selected]);
  const chooseSkill = (name: string) => {
    if (!token) return;
    const suffix = /^[a-zA-Z0-9_:-]*/.exec(body.slice(caret))![0].length;
    const next = `${body.slice(0, token.start)}/${name} ${body.slice(caret + suffix)}`;
    const position = token.start + name.length + 2;
    setBody(next);
    setCaret(position);
    setActive(0);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(position, position);
    });
  };

  const addFiles = (incoming: File[]) => {
    const tooBig = incoming.find((f) => f.size > ATTACHMENT_MAX_BYTES);
    if (tooBig) return setError(`${tooBig.name} is larger than ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
    const next = [...files, ...incoming];
    if (next.length > ATTACHMENT_MAX_FILES) return setError(`At most ${ATTACHMENT_MAX_FILES} files per comment`);
    setError(null);
    setFiles(next);
  };

  const submit = async () => {
    if (busy || (!body.trim() && files.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      let payload: unknown = { body, internal };
      if (files.length > 0) {
        const form = new FormData();
        form.set('body', body);
        form.set('internal', String(internal));
        for (const f of files) form.append('files', f, f.name);
        payload = form;
      }
      const { comment } = await post<{ comment: Comment }>(`/tasks/${taskId}/comments`, payload);
      putTimelineItem(qc, taskId, { type: 'comment', id: comment.id, createdAt: comment.createdAt, comment });
      setBody('');
      setFiles([]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((selected + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        chooseSkill(suggestions[selected]!.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(`${body}@${caret}`);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length > 0) {
      e.preventDefault();
      addFiles(
        pasted.map((f, i) =>
          f.name && f.name !== 'image.png'
            ? f
            : new File([f], `pasted-${Date.now()}-${i}.${f.type.split('/')[1] ?? 'png'}`, { type: f.type }),
        ),
      );
    }
  };
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault();
      addFiles([...e.dataTransfer.files]);
    }
  };

  const empty = !body.trim() && files.length === 0;

  return (
    <div
      data-internal={internal}
      onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
      onDragLeave={() => setDragOver(false)}
      className={cn(
        'rounded-xl border bg-background/50 p-3 transition-colors focus-within:border-ring/60 dark:bg-input/10',
        internal && 'border-amber-500/40 bg-amber-500/5 focus-within:border-amber-500/60 dark:bg-amber-500/5',
        dragOver && 'border-dashed border-primary',
      )}
    >
      {internal && (
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-amber-500">
          <Lock className="size-3" /> Internal note: only people see this, never the agent.
        </p>
      )}
      <MarkdownEditor
        inputRef={textarea}
        onCaretChange={(position) => {
          setCaret(position);
          setActive(0);
        }}
        onSelect={(e) => {
          const position = e.currentTarget.selectionStart === e.currentTarget.selectionEnd ? e.currentTarget.selectionStart : -1;
          if (position !== caret) {
            setCaret(position);
            setActive(0);
          }
        }}
        ariaControls={suggestions.length ? listId : undefined}
        ariaActiveDescendant={suggestions.length ? `${listId}-${selected}` : undefined}
        label="Comment"
        value={body}
        onChange={setBody}
        rows={3}
        placeholder={internal ? 'Write an internal note…' : 'Leave a comment… Markdown, drop or paste files.'}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={onDrop}
      />
      {suggestions.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Chat commands" className="my-2 max-h-60 overflow-auto rounded-lg border bg-popover p-1">
          {suggestions.map((skill, i) => (
            <li key={skill.name}>
              <button
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === selected}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => chooseSkill(skill.name)}
                className={cn('w-full rounded px-3 py-2 text-left text-sm', i === selected && 'bg-accent')}
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
      )}
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
      <div className="mt-2 flex items-center gap-3 border-t pt-2">
        <div className="flex items-center gap-2">
          <Switch
            id={`internal-${taskId}`}
            size="sm"
            checked={internal}
            onCheckedChange={setInternal}
            className="data-[state=checked]:bg-amber-500"
          />
          <Label htmlFor={`internal-${taskId}`} className={cn('text-xs', internal ? 'text-amber-500' : 'text-muted-foreground')}>
            Internal note
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
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => fileInput.current?.click()}>
          <Paperclip /> Attach
        </Button>
        <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
          <Kbd>↵</Kbd> send · <Kbd>⇧</Kbd>
          <Kbd>↵</Kbd> new line
        </span>
        <Button
          size="sm"
          onClick={submit}
          disabled={busy || empty}
          className={cn(internal && 'bg-amber-500 text-black hover:bg-amber-500/85')}
        >
          {internal ? 'Add note' : 'Comment'}
          <ArrowUp />
        </Button>
      </div>
    </div>
  );
}
