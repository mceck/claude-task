import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { badRequest, HttpError } from '../errors';

/** Stores one raster avatar; failed multipart requests clean up their new blob. */
export async function receiveAvatar(
  ctx: AppContext,
  request: FastifyRequest,
  maxBytes: number,
  types: readonly string[],
): Promise<string> {
  const tooLarge = () => new HttpError(413, 'file_too_large', `The avatar must be at most ${maxBytes / 1024 / 1024} MB`);
  if (!request.isMultipart()) throw badRequest('Send the image as multipart/form-data');
  let blobId: string | null = null;
  try {
    for await (const part of request.parts({ limits: { fileSize: maxBytes, files: 1 } })) {
      if (part.type !== 'file') continue;
      const contentType = part.mimetype;
      if (!types.includes(contentType)) {
        part.file.resume();
        throw badRequest('The avatar must be a PNG, JPEG, GIF or WebP image');
      }
      blobId = (await ctx.blobs.put(part.file, { filename: 'avatar', contentType })).id;
      if (part.file.truncated) throw tooLarge();
    }
    if (!blobId) throw badRequest('Missing image file');
    return blobId;
  } catch (err) {
    if (blobId) await ctx.blobs.delete(blobId);
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
    throw err;
  }
}
