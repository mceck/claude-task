import { ATTACHMENT_MAX_BYTES } from '@claude-task/shared';
import type { Attachment } from '@claude-task/shared';
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  codeBlockPlugin,
  CodeToggle,
  codeMirrorPlugin,
  CreateLink,
  headingsPlugin,
  imagePlugin,
  insertMarkdown$,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  markdownShortcutPlugin,
  MDXEditor,
  quotePlugin,
  Separator,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
  usePublisher,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { Paperclip } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api, errorMessage } from '../api/client';
import { MarkdownEditor } from './Markdown';

const CODE_LANGUAGES = { '': 'Plain text', ts: 'TypeScript', js: 'JavaScript', json: 'JSON', bash: 'Shell', sql: 'SQL', css: 'CSS', html: 'HTML', py: 'Python', go: 'Go' };

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
  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      const uploaded = await uploadFiles(taskId, files);
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

/**
 * A WYSIWYG markdown editor for long documents (task descriptions). MDXEditor parses MDX, so
 * markdown that isn't valid MDX (a stray `<` or `{`) falls back to the plain textarea editor.
 */
export default function RichMarkdownEditor({ taskId, value, onChange, label, autoFocus, placeholder }: { taskId: string; value: string; onChange: (value: string) => void; label: string; autoFocus?: boolean; placeholder?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MarkdownEditor label={label} layout="split" rows={12} value={value} onChange={onChange} autoFocus={autoFocus} />;
  return (
    <div className="rich-editor overflow-hidden rounded-lg border border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
      <MDXEditor
        markdown={value}
        onChange={(md) => onChange(md)}
        onError={() => setFailed(true)}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={label}
        className={cn(typeof document !== 'undefined' && document.documentElement.classList.contains('dark') && 'dark-theme')}
        contentEditableClassName="markdown min-h-48 px-3 py-2 text-sm"
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          tablePlugin(),
          codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
          codeMirrorPlugin({ codeBlockLanguages: CODE_LANGUAGES }),
          imagePlugin({
            disableImageSettingsButton: true,
            imageUploadHandler: async (file) => {
              try {
                return (await uploadFiles(taskId, [file]))[0]!.url;
              } catch (err) {
                toast.error('Couldn’t upload the image', { description: errorMessage(err) });
                throw err;
              }
            },
          }),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <Separator />
                <BlockTypeSelect />
                <BoldItalicUnderlineToggles />
                <CodeToggle />
                <Separator />
                <ListsToggle />
                <CreateLink />
                <InsertTable />
                <InsertImage />
                <AttachFileButton taskId={taskId} />
                <InsertCodeBlock />
              </>
            ),
          }),
        ]}
      />
    </div>
  );
}
