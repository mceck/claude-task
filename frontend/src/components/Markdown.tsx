import { isUserMentionPath } from '@claude-task/shared';
import { useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/** Renders user markdown. Raw HTML is not rendered. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _n, ...props }) => isUserMentionPath(props.href ?? '') ? <span className="rounded bg-primary/10 px-0.5 font-medium text-primary">{props.children}</span> : <a {...props} target="_blank" rel="noreferrer noopener" /> }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** The description laid out like the editor (toolbar row, then the text), while it loads or when it can't parse it. */
export function RichMarkdownView({ source, placeholder }: { source: string; placeholder?: string }) {
  return (
    <div className="rich-editor">
      <div className="rich-editor-toolbar-space" />
      {source ? <Markdown source={source} /> : <p className="text-sm text-muted-foreground">{placeholder}</p>}
    </div>
  );
}

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Side-by-side live preview (descriptions) or Write/Preview tabs (comments). */
  layout?: 'split' | 'tabs';
  rows?: number;
  autoFocus?: boolean;
  label: string;
  className?: string;
  /** Rendered on the right of the Write/Preview tabs. */
  toolbar?: React.ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop?: (e: DragEvent<HTMLTextAreaElement>) => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  onSelect?: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  onCaretChange?: (caret: number) => void;
  ariaControls?: string;
  ariaActiveDescendant?: string;
}

export function MarkdownEditor({ value, onChange, placeholder, layout = 'tabs', rows = 4, autoFocus, label, className, toolbar, onKeyDown, onPaste, onDrop, inputRef, onSelect, onCaretChange, ariaControls, ariaActiveDescendant }: EditorProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const textarea = (
    <textarea
      ref={inputRef}
      onSelect={onSelect}
      aria-controls={ariaControls}
      aria-activedescendant={ariaActiveDescendant}
      aria-autocomplete={ariaControls ? 'list' : undefined}
      aria-label={label}
      autoFocus={autoFocus}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => { onChange(e.target.value); onCaretChange?.(e.target.selectionStart); }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onDrop={onDrop}
      className={cn(
        'w-full resize-y bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground',
        layout === 'split' && 'rounded-lg border border-input p-3 font-mono text-[13px] focus:border-ring focus:ring-3 focus:ring-ring/30 dark:bg-input/20',
        className,
      )}
    />
  );
  const preview = (
    <div aria-label={`${label} preview`} className={cn('min-h-16', layout === 'split' && 'rounded-lg border border-dashed p-3')}>
      {value.trim() ? <Markdown source={value} /> : <p className="text-sm text-muted-foreground">Nothing to preview</p>}
    </div>
  );

  if (layout === 'split') {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {textarea}
        {preview}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        {(['write', 'preview'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-2 py-0.5 text-xs capitalize transition-colors',
              tab === t ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t}
          </button>
        ))}
        {toolbar && <div className="ml-auto flex items-center gap-2">{toolbar}</div>}
      </div>
      {tab === 'write' ? textarea : preview}
    </div>
  );
}
