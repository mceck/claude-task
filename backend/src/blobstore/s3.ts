import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { BLOB_ID_PATTERN } from './index';
import type { BlobMetadata, BlobStore, StoredBlob } from './index';

/** The part of an S3 client the store uses, so tests can substitute a fake. */
export type S3Sender = Pick<S3Client, 'send'>;

export interface S3BlobStoreOptions {
  bucket: string;
  /** Key prefix, ending in `/` or empty. */
  prefix?: string;
  client: S3Sender;
}

/**
 * Stores each blob as an S3 object: the bytes only, with the file name in the
 * object's metadata and the content type as its `Content-Type`.
 */
export class S3BlobStore implements BlobStore {
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(private readonly options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? '';
  }

  async put(stream: Readable, metadata: BlobMetadata): Promise<{ id: string; size: number }> {
    const id = randomUUID();
    let size = 0;
    // Count the bytes on the way to S3; the size is part of the stored metadata the API needs.
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(null, chunk);
      },
    });
    stream.pipe(counted);
    try {
      // Upload accepts a stream of unknown length (multipart for large files), while a plain
      // PutObject needs ContentLength up front, which an incoming upload does not have.
      await new Upload({
        client: this.options.client as S3Client,
        params: {
          Bucket: this.bucket,
          Key: this.key(id),
          Body: counted,
          ContentType: metadata.contentType,
          // S3 user metadata travels in HTTP headers, so the name is percent-encoded to stay ASCII.
          Metadata: { filename: encodeURIComponent(metadata.filename) },
        },
      }).done();
    } catch (err) {
      stream.unpipe(counted);
      counted.destroy();
      throw err;
    }
    return { id, size };
  }

  async get(id: string): Promise<StoredBlob | null> {
    if (!BLOB_ID_PATTERN.test(id)) return null;
    let response;
    try {
      response = await this.options.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
    } catch (err) {
      if (isMissingObject(err)) return null;
      throw err;
    }
    if (!response.Body) return null;
    return {
      stream: response.Body as Readable,
      metadata: {
        filename: decodeFilename(response.Metadata?.filename),
        contentType: response.ContentType ?? 'application/octet-stream',
        size: response.ContentLength ?? 0,
      },
    };
  }

  async delete(id: string): Promise<void> {
    if (!BLOB_ID_PATTERN.test(id)) return;
    await this.options.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
  }

  private key(id: string): string {
    return `${this.prefix}${id}`;
  }
}

function decodeFilename(raw: string | undefined): string {
  if (!raw) return 'file';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A missing key means "no such blob"; a missing bucket is a configuration error and must surface. */
function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (name === 'NoSuchBucket' || name === 'BucketNotFound') return false;
  return name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
}
