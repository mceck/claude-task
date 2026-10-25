import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES } from '@claude-task/shared';
import type { Comment } from '@claude-task/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, FileText, Lock, Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { errorMessage, post } from '../api/client';
import { putTimelineItem } from '../lib/cache';
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

export function Composer({ taskId, draft }: { taskId: string; draft?: ReturnType<typeof useCommentDraft> }) {
  const localDraft = useCommentDraft();
  const { body, setBody, internal, setInternal, files, setFiles, error, setError, busy, setBusy } = draft ?? localDraft;
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

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
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length > 0) {
      e.preventDefault();
      addFiles(pasted.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.${f.type.split('/')[1] ?? 'png'}`, { type: f.type }))));
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
        label="Comment"
        value={body}
        onChange={setBody}
        rows={3}
        placeholder={internal ? 'Write an internal note…' : 'Leave a comment… Markdown, drop or paste files.'}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={onDrop}
      />
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
          <Switch id={`internal-${taskId}`} size="sm" checked={internal} onCheckedChange={setInternal} className="data-[state=checked]:bg-amber-500" />
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
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
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
