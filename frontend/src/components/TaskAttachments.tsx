import type { TaskAttachment } from '@claude-task/shared';
import { Bot, Download, Eye, FileText } from 'lucide-react';
import { useTaskAttachments } from '../api/queries';
import { Time } from './common';

/** Image types the backend serves inline; the rest download. */
const PREVIEWABLE = /^image\/(png|jpeg|gif|webp|avif)$/;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Every file of the Task, from its description and its Comments, newest first, right under the description.
 * One compact row per file: a preview for images, who uploaded it and when, and a download.
 */
export function TaskAttachments({ taskId }: { taskId: string }) {
  const { data } = useTaskAttachments(taskId);
  const files = data ?? [];
  // No files, nothing to show: the section appears with the first upload.
  if (files.length === 0) return null;
  return (
    <section aria-label="Attachments" className="mt-6">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        Attachments
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{files.length}</span>
      </h3>
      <ul className="divide-y overflow-hidden rounded-lg border bg-card/40">
        {files.map((file) => (
          <AttachmentRow key={file.id} file={file} />
        ))}
      </ul>
    </section>
  );
}

function AttachmentRow({ file }: { file: TaskAttachment }) {
  const image = PREVIEWABLE.test(file.contentType);
  // A description file is linked from the description text; a Comment one belongs to that Comment.
  const source = file.author ? (
    <span className="flex items-center gap-1">
      {file.author.type === 'agent' ? <Bot className="size-3" aria-hidden /> : null}
      {file.author.displayName}
    </span>
  ) : (
    'Description'
  );
  return (
    <li>
      <a
        href={image ? file.url : `${file.url}?download=1`}
        target="_blank"
        rel="noreferrer"
        className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50"
      >
        {image ? (
          <img
            src={file.url}
            alt=""
            loading="lazy"
            className="size-9 shrink-0 rounded-md border object-cover"
          />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/60 text-muted-foreground">
            <FileText className="size-4" aria-hidden />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{file.filename}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{formatSize(file.size)}</span>
            <span aria-hidden>·</span>
            {source}
            <span aria-hidden>·</span>
            <Time iso={file.createdAt} />
          </span>
        </span>
        <span className="shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100">
          {image ? <Eye className="size-4" aria-label="Preview" /> : <Download className="size-4" aria-label="Download" />}
        </span>
      </a>
    </li>
  );
}
