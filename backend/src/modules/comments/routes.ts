import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, createCommentBody, updateCommentBody } from '@claude-task/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, userActor } from '../../auth/guard';
import { transact } from '../../context';
import type { AppContext } from '../../context';
import { HttpError, notFound, parse } from '../../errors';
import { getTaskRow } from '../tasks/service';
import { createUserComment, deleteComment, getAttachment, updateComment } from './service';
import type { NewAttachment } from './service';

const taskParams = z.object({ taskId: z.string().min(1).max(64) });
const params = z.object({ id: z.uuid() });

/** Images we let the browser render inline; everything else downloads. SVG can carry scripts. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

export function commentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/tasks/:taskId/comments', async (request, reply) => {
    const { taskId } = parse(taskParams, request.params);
    const author = userActor(currentUser(request));
    const task = await getTaskRow(ctx.db, taskId);

    const { fields, files } = request.isMultipart()
      ? await receiveMultipart(ctx, request)
      : { fields: request.body, files: [] as NewAttachment[] };
    try {
      const body = parse(createCommentBody, fields);
      const comment = await transact(ctx, (tx, after) =>
        createUserComment(tx, after, task, { ...body, attachments: files }, author),
      );
      return reply.status(201).send({ comment });
    } catch (err) {
      await Promise.all(files.map((f) => ctx.blobs.delete(f.blobId)));
      throw err;
    }
  });

  app.patch('/comments/:id', async (request) => {
    const { id } = parse(params, request.params);
    const { body } = parse(updateCommentBody, request.body);
    const user = currentUser(request);
    const comment = await transact(ctx, (tx, after) => updateComment(tx, after, id, body, user));
    return { comment };
  });

  app.delete('/comments/:id', async (request, reply) => {
    const { id } = parse(params, request.params);
    const user = currentUser(request);
    await transact(ctx, (tx, after) => deleteComment(tx, after, id, user, (blobId) => ctx.blobs.delete(blobId)));
    return reply.status(204).send();
  });

  app.get('/attachments/:id', async (request, reply) => {
    const { id } = parse(params, request.params);
    const attachment = await getAttachment(ctx.db, id);
    const blob = await ctx.blobs.get(attachment.blobId);
    if (!blob) throw notFound('Attachment');
    const inline = INLINE_TYPES.has(attachment.contentType) && (request.query as { download?: string }).download === undefined;
    return reply
      .header('content-type', inline ? attachment.contentType : 'application/octet-stream')
      .header('content-length', String(blob.metadata.size))
      .header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', attachment.filename))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=3600')
      .send(blob.stream);
  });
}

/** Streams uploaded files into the BlobStore and collects the text fields. */
async function receiveMultipart(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<{ fields: Record<string, unknown>; files: NewAttachment[] }> {
  const fields: Record<string, unknown> = {};
  const files: NewAttachment[] = [];
  try {
    for await (const part of request.parts({ limits: { fileSize: ATTACHMENT_MAX_BYTES, files: ATTACHMENT_MAX_FILES } })) {
      if (part.type === 'field') {
        const value = String(part.value);
        fields[part.fieldname] = part.fieldname === 'internal' ? value === 'true' : value;
        continue;
      }
      const filename = sanitizeFilename(part.filename);
      const contentType = part.mimetype || 'application/octet-stream';
      const { id, size } = await ctx.blobs.put(part.file, { filename, contentType });
      files.push({ blobId: id, filename, contentType, size });
      if (part.file.truncated) {
        throw new HttpError(413, 'file_too_large', `Files must be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
      }
    }
  } catch (err) {
    await Promise.all(files.map((f) => ctx.blobs.delete(f.blobId)));
    if (err instanceof HttpError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'FST_FILES_LIMIT') {
      throw new HttpError(413, 'too_many_files', `At most ${ATTACHMENT_MAX_FILES} files per comment`);
    }
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new HttpError(413, 'file_too_large', `Files must be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
    }
    throw err;
  }
  return { fields, files };
}

function sanitizeFilename(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // Drop control characters and keep it a sane length.
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return clean || 'file';
}

function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
