import { ATTACHMENT_MAX_BYTES, skillToken, mentionToken, userMentionPath } from '@claude-task/shared';
import { $createLinkNode, $isLinkNode } from '@lexical/link';
import type { Attachment } from '@claude-task/shared';
import {
  $createCodeBlockNode,
  activeEditor$,
  applyFormat$,
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  codeBlockPlugin,
  codeMirrorPlugin,
  CreateLink,
  createRootEditorSubscription$,
  currentFormat$,
  headingsPlugin,
  iconComponentFor$,
  imagePlugin,
  insertImage$,
  insertMarkdown$,
  InsertTable,
  IS_CODE,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  markdownShortcutPlugin,
  MDXEditor,
  MultipleChoiceToggleGroup,
  quotePlugin,
  realmPlugin,
  Separator,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
  useCellValues,
  usePublisher,
} from '@mdxeditor/editor';
import type { MDXEditorMethods, RealmPlugin } from '@mdxeditor/editor';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from 'lexical';
import type { LexicalCommand, LexicalEditor, TextNode } from 'lexical';
import '@mdxeditor/editor/style.css';
import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Paperclip } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref, RefObject } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { api, errorMessage } from '../api/client';
import { keys } from '../api/queries';
import { MarkdownEditor, RichMarkdownView } from './Markdown';

const CODE_LANGUAGES = { '': 'Plain text', ts: 'TypeScript', js: 'JavaScript', json: 'JSON', bash: 'Shell', sql: 'SQL', css: 'CSS', html: 'HTML', py: 'Python', go: 'Go' };

/**
 * Code blocks look like the rendered ones (see `.markdown pre`): MDXEditor's CodeMirror comes with a light theme
 * and line numbers, so this theme, given first, takes precedence. Syntax colors are tokens in index.css.
 */
const CODE_BLOCK_THEME = [
  EditorView.theme({
    '&': { backgroundColor: 'transparent', color: 'var(--foreground)', fontSize: '0.8rem' },
    '&.cm-editor': { padding: '0' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.625' },
    '.cm-content': { padding: '0', caretColor: 'var(--foreground)' },
    '.cm-line': { padding: '0' },
    '.cm-gutters': { display: 'none' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--foreground)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 30%, transparent) !important',
    },
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], color: 'var(--code-keyword)' },
      { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--code-string)' },
      { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-number)' },
      { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--code-function)' },
      { tag: [tags.typeName, tags.className, tags.tagName], color: 'var(--code-type)' },
      { tag: [tags.propertyName, tags.attributeName], color: 'var(--code-property)' },
      { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--muted-foreground)', fontStyle: 'italic' },
    ]),
  ),
];

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Uploads to the task; the description then links the files by URL, and the agent gets them too. */
async function uploadFiles(taskId: string, files: File[]): Promise<Attachment[]> {
  const tooBig = files.find((f) => f.size > ATTACHMENT_MAX_BYTES);
  if (tooBig) throw new Error(`${tooBig.name} is larger than ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
  const form = new FormData();
  for (const f of files) form.append('files', f);
  return (await api<{ attachments: Attachment[] }>('POST', `/tasks/${taskId}/attachments`, form)).attachments;
}

const escapeText = (s: string) => s.replace(/[[\]\\]/g, '\\$&');

function AttachFileButton({ taskId }: { taskId: string }) {
  const insert = usePublisher(insertMarkdown$);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      const uploaded = await uploadFiles(taskId, files);
      // The Task's attachment list shows description files as soon as they exist, before the edit is saved.
      void qc.invalidateQueries({ queryKey: keys.attachments(taskId) });
      insert(uploaded.map((a) => `${IMAGE_TYPES.includes(a.contentType) ? '!' : ''}[${escapeText(a.filename)}](${a.url})`).join('\n\n'));
    } catch (err) {
      toast.error('Couldn’t attach the file', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        title="Attach a file"
        aria-label="Attach a file"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Paperclip className="size-4" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        aria-label="Attach files to the description"
        className="sr-only"
        onChange={(e) => {
          void attach([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** MDXEditor's inline code toggle, except that a selection spanning several lines becomes one code block. */
function CodeButton() {
  const [editor, currentFormat, iconComponentFor] = useCellValues(activeEditor$, currentFormat$, iconComponentFor$);
  const applyFormat = usePublisher(applyFormat$);
  const codeIsOn = (currentFormat & IS_CODE) !== 0;
  const toCodeBlock = () => {
    let converted = false;
    // Lexical runs the update function synchronously, so `converted` is known right after.
    editor?.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const blocks = [...new Set(selection.getNodes().map((node) => node.getTopLevelElement()))].filter((b): b is NonNullable<typeof b> => b !== null);
      if (blocks.length < 2 && !selection.getTextContent().includes('\n')) return;
      const block = $createCodeBlockNode({ code: blocks.map((b) => b.getTextContent()).join('\n'), language: '', meta: '' });
      blocks[0]!.insertBefore(block);
      for (const b of blocks) b.remove();
      converted = true;
    });
    if (!converted) applyFormat('code');
  };
  return (
    <MultipleChoiceToggleGroup
      items={[{ title: codeIsOn ? 'Remove code format' : 'Code (a code block for several lines)', contents: iconComponentFor('code'), active: codeIsOn, onChange: toCodeBlock }]}
    />
  );
}

/** Replaces MDXEditor's image dialog: upload an image to the task, or link one by URL. */
function InsertImageButton({ taskId }: { taskId: string }) {
  const insertImage = usePublisher(insertImage$);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState('');
  const [alt, setAlt] = useState('');
  const qc = useQueryClient();
  const show = (next: boolean) => {
    setOpen(next);
    if (next) {
      setUrl('');
      setAlt('');
    }
  };
  const upload = async (files: File[]) => {
    const file = files.find((f) => IMAGE_TYPES.includes(f.type));
    if (!file) return void toast.error('Choose a PNG, JPEG, GIF or WebP image');
    setBusy(true);
    try {
      const [attachment] = await uploadFiles(taskId, [file]);
      void qc.invalidateQueries({ queryKey: keys.attachments(taskId) });
      insertImage({ src: attachment!.url, altText: alt.trim() || attachment!.filename });
      setOpen(false);
    } catch (err) {
      toast.error('Couldn’t upload the image', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        title="Insert image"
        aria-label="Insert image"
        onClick={() => show(true)}
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ImagePlus className="size-4" />
      </button>
      <Dialog open={open} onOpenChange={show}>
        {/* data-editor-popup: working in it doesn't end the description edit. */}
        <DialogContent data-editor-popup="" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Insert image</DialogTitle>
            <DialogDescription>Upload it to the task, or link an image from the web.</DialogDescription>
          </DialogHeader>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload([...e.dataTransfer.files]);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center text-sm transition-colors hover:border-foreground/30 hover:bg-muted/40 has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/30',
              dragging && 'border-primary bg-primary/5',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            <ImagePlus className="size-6 text-muted-foreground" />
            <span className="font-medium">{busy ? 'Uploading…' : 'Choose an image or drop it here'}</span>
            <span className="text-xs text-muted-foreground">PNG, JPEG, GIF or WebP, up to {ATTACHMENT_MAX_BYTES / 1024 / 1024} MB</span>
            <input
              type="file"
              accept={IMAGE_TYPES.join(',')}
              aria-label="Upload an image"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                void upload([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </label>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <form
            id="insert-image-url"
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!url.trim()) return;
              insertImage({ src: url.trim(), altText: alt.trim() });
              setOpen(false);
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="insert-image-src">Image URL</Label>
              <Input id="insert-image-src" type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="insert-image-alt">Alt text</Label>
              <Input id="insert-image-alt" placeholder="Describe the image for screen readers" value={alt} onChange={(e) => setAlt(e.target.value)} />
            </div>
          </form>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" form="insert-image-url" disabled={!url.trim() || busy}>
              Insert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Puts the caret where the reader clicked on the rendered markdown, which the editor lays out the same way. */
function placeCaret(root: HTMLElement, point: { x: number; y: number }): boolean {
  const editable = root.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!editable) return false;
  let range: Range | null = null;
  if ('caretPositionFromPoint' in document) {
    const pos = document.caretPositionFromPoint(point.x, point.y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    }
  } else {
    range = (document as Document & { caretRangeFromPoint(x: number, y: number): Range | null }).caretRangeFromPoint(point.x, point.y);
  }
  if (!range || !editable.contains(range.startContainer)) return false;
  editable.focus({ preventScroll: true });
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

/** What every markdown editor understands; the toolbar is up to each. */
function contentPlugins(taskId: string, opts: { images?: boolean; onImageUploaded?: () => void } = {}): RealmPlugin[] {
  const { images = true, onImageUploaded } = opts;
  return [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    tablePlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
    codeMirrorPlugin({ codeBlockLanguages: CODE_LANGUAGES, codeMirrorExtensions: CODE_BLOCK_THEME }),
    // Pasting or dropping an image uploads it: a comment editor has no description to link it from.
    ...(images
      ? [
          imagePlugin({
            disableImageSettingsButton: true,
            imageUploadHandler: async (file) => {
              try {
                const url = (await uploadFiles(taskId, [file]))[0]!.url;
                onImageUploaded?.();
                return url;
              } catch (err) {
                toast.error('Couldn’t upload the image', { description: errorMessage(err) });
                throw err;
              }
            },
          }),
        ]
      : []),
    // Last: it picks its shortcuts from the plugins above.
    markdownShortcutPlugin(),
  ];
}

/**
 * MDXEditor builds a new code block's CodeMirror asynchronously (after loading the language), so its own
 * focusing usually fires too early: focus each new code editor as soon as it exists.
 */
function useFocusNewCodeBlocks(root: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const known = new WeakSet(root.current!.querySelectorAll('.cm-editor'));
    const observer = new MutationObserver(() => {
      for (const el of root.current!.querySelectorAll('.cm-editor')) {
        if (known.has(el)) continue;
        known.add(el);
        el.querySelector<HTMLElement>('.cm-content')?.focus();
      }
    });
    observer.observe(root.current!, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root, enabled]);
}

const isDark = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

/**
 * A WYSIWYG markdown editor for task descriptions that also shows them: it stays mounted read-only, so starting
 * to edit is instant and moves nothing. The toolbar has a reserved row above the text (see `.rich-editor` in
 * index.css), hidden while read-only. MDXEditor parses MDX, so markdown that isn't valid MDX (a stray `<` or `{`)
 * falls back to rendered markdown and the plain textarea editor.
 */
export default function RichMarkdownEditor({
  taskId,
  value,
  onChange,
  label,
  readOnly,
  overlayContainer,
  caretAt,
  placeholder,
}: {
  taskId: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
  readOnly: boolean;
  /** Where the editor's popups (image and link dialogs, menus) go; inside a modal they must stay in it. */
  overlayContainer?: HTMLElement | null;
  /** Where the reader clicked to start editing; the caret goes there. */
  caretAt?: { x: number; y: number };
  placeholder?: string;
}) {
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<MDXEditorMethods>(null);
  const qc = useQueryClient();
  /** The markdown the editor holds, to tell remote changes from our own. */
  const shown = useRef(value);
  useEffect(() => {
    if (!readOnly || failed || value === shown.current) return;
    shown.current = value;
    editor.current?.setMarkdown(value);
  }, [readOnly, failed, value]);
  useEffect(() => {
    if (failed) return;
    if (readOnly) {
      // Leaving the editor mustn't scroll anything: drop the focus where it is.
      if (root.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      return;
    }
    // Wait for Lexical to make the content editable before looking for the clicked text.
    const frame = requestAnimationFrame(() => {
      if (!caretAt || !placeCaret(root.current!, caretAt)) editor.current?.focus(undefined, { defaultSelection: 'rootEnd', preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [readOnly, failed]); // Only where the editing started, not on later renders.

  useFocusNewCodeBlocks(root, !readOnly && !failed);

  if (failed) {
    if (readOnly) return <RichMarkdownView source={value} placeholder={placeholder} />;
    return <MarkdownEditor label={label} layout="split" rows={12} value={value} onChange={onChange} autoFocus />;
  }
  return (
    <div ref={root} className="rich-editor" data-readonly={readOnly || undefined}>
      <MDXEditor
        ref={editor}
        markdown={value}
        // MDXEditor renders HTML tags with any attribute (onerror, srcdoc…). Agents write descriptions,
        // so HTML is not parsed: a description with HTML fails over to the plain Markdown view.
        suppressHtmlProcessing
        readOnly={readOnly}
        overlayContainer={overlayContainer}
        onChange={(md, initialMarkdownNormalize) => {
          shown.current = md;
          // Normalizing the markdown (bullet symbols, whitespace) isn't an edit, and mustn't be saved.
          if (!initialMarkdownNormalize && !readOnly) onChange(md);
        }}
        onError={() => setFailed(true)}
        placeholder={placeholder}
        aria-label={label}
        className={cn(isDark() && 'dark-theme')}
        contentEditableClassName="markdown min-h-6 p-0! outline-none"
        plugins={[
          ...contentPlugins(taskId, { onImageUploaded: () => void qc.invalidateQueries({ queryKey: keys.attachments(taskId) }) }),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <Separator />
                <BlockTypeSelect />
                {/* No underline: it isn't markdown, and rendered markdown drops raw HTML. */}
                <BoldItalicUnderlineToggles options={['Bold', 'Italic']} />
                <CodeButton />
                <Separator />
                <ListsToggle />
                <CreateLink />
                <InsertTable />
                <InsertImageButton taskId={taskId} />
                <AttachFileButton taskId={taskId} />
              </>
            ),
          }),
        ]}
      />
    </div>
  );
}

/** A `/command` being typed: what follows the slash, and whether it opens the comment. */
export interface CommandToken {
  query: string;
  atStart: boolean;
}

export interface CommentEditorHandle {
  setValue(markdown: string): void;
  focus(): void;
  /** Replaces the `/command` being typed with the chosen one. */
  chooseCommand(name: string): void;
  chooseMention(id: string, displayName: string): void;
}

type ChatKey = 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape';
interface ChatHooks {
  onMentionToken?: (token: { query: string } | null) => void;
  onSubmit?: () => void;
  onCommandToken?: (token: CommandToken | null) => void;
  /** Keys for an open suggestion list; returns whether it used the key. */
  onCommandKey?: (key: ChatKey) => boolean;
}

/** The `/command` right before a collapsed caret. Call inside a Lexical read or update. */
function $commandAtCaret(): { node: TextNode; offset: number; start: number; query: string } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const node = selection.anchor.getNode();
  if (!$isTextNode(node)) return null;
  const offset = selection.anchor.offset;
  const token = skillToken(node.getTextContent(), offset);
  return token && { node, offset, ...token };
}

/** Ignore code and existing links while completing a User mention. */
function $mentionAtCaret() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const node = selection.anchor.getNode();
  if (!$isTextNode(node) || node.hasFormat('code') || $isLinkNode(node.getParent())) return null;
  const offset = selection.anchor.offset;
  const token = mentionToken(node.getTextContent(), offset);
  return token && { node, offset, ...token };
}

/** Chat keys on the Lexical editor itself, so they run before its own handling (new paragraphs, list items…). */
const chatPlugin = realmPlugin<{ hooks: { current: ChatHooks }; editor: { current: LexicalEditor | null } }>({
  init(realm, params) {
    const { hooks, editor } = params!;
    realm.pub(createRootEditorSubscription$, (theEditor) => {
      editor.current = theEditor;
      const key = (name: ChatKey, command: LexicalCommand<KeyboardEvent | null>) =>
        theEditor.registerCommand(
          command,
          (event) => {
            if (event?.isComposing) return false;
            if (!(name === 'Enter' && event?.shiftKey) && hooks.current.onCommandKey?.(name)) {
              event?.preventDefault();
              return true;
            }
            // Enter sends, Shift+Enter breaks the line; inside a list Enter still adds an item.
            if (name !== 'Enter' || !hooks.current.onSubmit || event?.shiftKey) return false;
            const selection = $getSelection();
            if ($isRangeSelection(selection) && selection.anchor.getNode().getTopLevelElement()?.getType() === 'list') return false;
            event?.preventDefault();
            hooks.current.onSubmit();
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        );
      const unregister = [
        key('ArrowUp', KEY_ARROW_UP_COMMAND),
        key('ArrowDown', KEY_ARROW_DOWN_COMMAND),
        key('Enter', KEY_ENTER_COMMAND),
        key('Tab', KEY_TAB_COMMAND),
        key('Escape', KEY_ESCAPE_COMMAND),
        theEditor.registerUpdateListener(({ editorState }) =>
          editorState.read(() => {
            const mention = $mentionAtCaret();
            hooks.current.onMentionToken?.(mention ? { query: mention.query } : null);
            const command = $commandAtCaret();
            const first = $getRoot().getFirstChild();
            hooks.current.onCommandToken?.(
              command && {
                query: command.query,
                atStart: command.start === 0 && command.node.getPreviousSibling() === null && !!first && command.node.getTopLevelElement()?.is(first) === true,
              },
            );
          }),
        ),
      ];
      return () => unregister.forEach((off) => off());
    });
  },
});

/**
 * The same WYSIWYG editor for comments: no toolbar (keyboard and markdown shortcuts format), Enter to send (when `onSubmit` is given) and
 * `/command` completion through `onCommandToken`/`onCommandKey`, shown by the caller. Files pasted or dropped
 * are the caller's to handle (comments attach them rather than embed them).
 */
export function CommentEditor({
  taskId,
  label,
  placeholder,
  initialValue,
  onChange,
  onSubmit,
  onCommandToken,
  onMentionToken,
  onCommandKey,
  handle,
  autoFocus,
  ariaControls,
  ariaActiveDescendant,
  compact,
}: ChatHooks & {
  taskId: string;
  label: string;
  placeholder?: string;
  initialValue: string;
  onChange: (value: string) => void;
  handle?: Ref<CommentEditorHandle>;
  autoFocus?: boolean;
  ariaControls?: string;
  ariaActiveDescendant?: string;
  /** One line that grows to three, then scrolls (the composer). */
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [fallbackValue, setFallbackValue] = useState(initialValue);
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<MDXEditorMethods>(null);
  const hooks = useRef<ChatHooks>({});
  hooks.current = { onSubmit, onCommandToken, onMentionToken, onCommandKey };
  const lexical = useRef<LexicalEditor | null>(null);
  // The plugin list is built once: MDXEditor initializes plugins on mount only.
  const [plugins] = useState(() => [
    // A comment has no description to link an image from: attachments belong to the Comment being written.
    ...contentPlugins(taskId, { images: false }),
    chatPlugin({ hooks, editor: lexical }),
  ]);
  useFocusNewCodeBlocks(root, !failed);
  useEffect(() => {
    if (!autoFocus) return;
    // A frame later: whatever opened the editor (a menu) restores its own focus first.
    const frame = requestAnimationFrame(() => editor.current?.focus(undefined, { defaultSelection: 'rootEnd' }));
    return () => cancelAnimationFrame(frame);
  }, []); // Only on mount.
  // The contenteditable is MDXEditor's: point it at the suggestion list for screen readers.
  useEffect(() => {
    const editable = root.current?.querySelector('[contenteditable="true"]');
    if (!editable) return;
    for (const [name, value] of [['aria-controls', ariaControls], ['aria-activedescendant', ariaActiveDescendant]] as const) {
      if (value) editable.setAttribute(name, value);
      else editable.removeAttribute(name);
    }
  }, [ariaControls, ariaActiveDescendant]);
  useImperativeHandle(handle, () => ({
    setValue: (markdown) => {
      if (failed) return setFallbackValue(markdown);
      const typing = !!root.current?.contains(document.activeElement);
      editor.current?.setMarkdown(markdown);
      // Someone typing goes on at the end of the text.
      if (typing) lexical.current?.update(() => $getRoot().selectEnd());
    },
    focus: () => {
      if (failed) root.current?.querySelector('textarea')?.focus();
      else editor.current?.focus(undefined, { defaultSelection: 'rootEnd' });
    },
    chooseMention: (id, displayName) => {
      if (failed) {
        const textarea = root.current?.querySelector('textarea');
        if (!textarea) return;
        const token = mentionToken(textarea.value, textarea.selectionStart);
        if (!token) return;
        const label = displayName.replace(/[\\[\]]/g, '\\$&');
        const replacement = `[@${label}](${userMentionPath(id)}) `;
        const caret = textarea.selectionStart;
        const rest = /^[^\s@\[\]()]*/.exec(textarea.value.slice(caret))![0].length;
        const next = textarea.value.slice(0, token.start) + replacement + textarea.value.slice(caret + rest);
        setFallbackValue(next);
        onChange(next);
        onMentionToken?.(null);
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(token.start + replacement.length, token.start + replacement.length);
        });
        return;
      }
      lexical.current?.update(() => {
        const mention = $mentionAtCaret();
        if (!mention) return;
        const rest = /^[^\s@\[\]()]*/.exec(mention.node.getTextContent().slice(mention.offset))![0].length;
        const selection = mention.node.select(mention.start, mention.offset + rest);
        const link = $createLinkNode(userMentionPath(id));
        link.append($createTextNode(`@${displayName}`));
        const space = $createTextNode(' ');
        selection.insertNodes([link, space]);
        space.selectEnd();
      });
      lexical.current?.focus();
    },
    chooseCommand: (name) => {
      lexical.current?.update(() => {
        const command = $commandAtCaret();
        if (!command) return;
        const rest = /^[a-zA-Z0-9_:-]*/.exec(command.node.getTextContent().slice(command.offset))![0].length;
        command.node.spliceText(command.start, command.offset + rest - command.start, `/${name} `, true);
      });
      lexical.current?.focus();
    },
  }));

  if (failed) {
    return (
      <div ref={root}>
        <MarkdownEditor
          label={label}
          rows={compact ? 1 : 3}
          value={fallbackValue}
          onChange={(md) => (setFallbackValue(md), onChange(md))}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onCaretChange={(caret) => onMentionToken?.(mentionToken(root.current?.querySelector('textarea')?.value ?? '', caret))}
          onSelect={(e) => onMentionToken?.(e.currentTarget.selectionStart === e.currentTarget.selectionEnd ? mentionToken(e.currentTarget.value, e.currentTarget.selectionStart) : null)}
          ariaControls={ariaControls}
          ariaActiveDescendant={ariaActiveDescendant}
          onKeyDown={(e) => {
            if (!e.nativeEvent.isComposing && !e.shiftKey && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key) && onCommandKey?.(e.key as ChatKey)) {
              e.preventDefault();
              return;
            }
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
    );
  }
  return (
    <div ref={root} className="rich-editor rich-editor-comment">
      <MDXEditor
        ref={editor}
        markdown={initialValue}
        suppressHtmlProcessing
        onChange={(md, initialMarkdownNormalize) => !initialMarkdownNormalize && onChange(md)}
        onError={() => setFailed(true)}
        placeholder={placeholder}
        // MDXEditor labels its contenteditable through this one translation.
        translation={(key, defaultValue) => (key === 'contentArea.editableMarkdown' ? label : defaultValue)}
        className={cn(isDark() && 'dark-theme')}
        contentEditableClassName={cn('markdown p-0! outline-none', compact ? 'max-h-[3lh] overflow-y-auto' : 'min-h-16')}
        plugins={plugins}
      />
    </div>
  );
}
