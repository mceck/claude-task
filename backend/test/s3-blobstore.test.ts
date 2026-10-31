import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { S3BlobStore } from '../src/blobstore/s3';
import type { S3Sender } from '../src/blobstore/s3';

interface StoredObject {
  body: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
}

interface MultipartUpload {
  key: string;
  contentType?: string;
  metadata?: Record<string, string>;
  parts: Map<number, Buffer>;
}

class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly requests: string[] = [];
  /** The parts of `S3Client` lib-storage reads directly. */
  readonly config = {
    endpoint: async () => ({ protocol: 'http:', hostname: 's3.test', port: undefined, path: '/' }),
    forcePathStyle: true,
    requestHandler: {},
    requestChecksumCalculation: async () => 'WHEN_REQUIRED',
  };
  private readonly uploads = new Map<string, MultipartUpload>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      this.requests.push('put');
      this.objects.set(command.input.Key!, {
        body: await bodyBytes(command.input.Body!),
        contentType: command.input.ContentType,
        metadata: command.input.Metadata,
      });
      return {};
    }
    if (command instanceof CreateMultipartUploadCommand) {
      this.requests.push('createMultipartUpload');
      const uploadId = randomUUID();
      this.uploads.set(uploadId, {
        key: command.input.Key!,
        contentType: command.input.ContentType,
        metadata: command.input.Metadata,
        parts: new Map(),
      });
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      this.requests.push('uploadPart');
      this.uploads.get(command.input.UploadId!)!.parts.set(command.input.PartNumber!, await bodyBytes(command.input.Body!));
      return { ETag: `"${command.input.PartNumber}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      this.requests.push('completeMultipartUpload');
      const upload = this.uploads.get(command.input.UploadId!)!;
      const parts = command.input.MultipartUpload!.Parts!.map((part) => upload.parts.get(part.PartNumber!)!);
      this.objects.set(upload.key, { body: Buffer.concat(parts), contentType: upload.contentType, metadata: upload.metadata });
      this.uploads.delete(command.input.UploadId!);
      return {};
    }
    if (command instanceof GetObjectCommand) {
      this.requests.push('get');
      const object = this.objects.get(command.input.Key!);
      if (!object) {
        const error = new Error('The specified key does not exist.');
        error.name = 'NoSuchKey';
        throw error;
      }
      return {
        Body: Readable.from([object.body]),
        ContentType: object.contentType,
        ContentLength: object.body.length,
        Metadata: object.metadata,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.requests.push('delete');
      this.objects.delete(command.input.Key!);
      return {};
    }
    throw new Error('unexpected command');
  }
}

async function bodyBytes(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function makeStore(fake: FakeS3, prefix = 'blobs/') {
  return new S3BlobStore({ bucket: 'files', prefix, client: fake as unknown as S3Sender });
}

describe('S3 blob store', () => {
  it('stores a blob as an object with its name, type and size', async () => {
    const fake = new FakeS3();
    const store = makeStore(fake);
    const { id, size } = await store.put(Readable.from(['hello', ' world']), { filename: 'note ✓.txt', contentType: 'text/plain' });

    expect(size).toBe(11);
    expect(fake.objects.get(`blobs/${id}`)).toMatchObject({ body: Buffer.from('hello world'), contentType: 'text/plain' });

    const blob = await store.get(id);
    expect(blob?.metadata).toEqual({ filename: 'note ✓.txt', contentType: 'text/plain', size: 11 });
    const chunks: Buffer[] = [];
    for await (const chunk of blob!.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
  });

  it('returns null for an unknown blob and for an id that cannot name one', async () => {
    const fake = new FakeS3();
    const store = makeStore(fake);
    expect(await store.get('0f7f8e4e-0b51-4a1c-8cbf-3f0d5c1a2b3c')).toBeNull();
    expect(await store.get('../../etc/passwd')).toBeNull();
    expect(fake.requests).toEqual(['get']);
  });

  it('surfaces a missing bucket instead of reporting every blob as missing', async () => {
    const fake = new FakeS3();
    fake.send = async () => {
      const error = new Error('The specified bucket does not exist.');
      error.name = 'NoSuchBucket';
      throw error;
    };
    await expect(makeStore(fake).get('0f7f8e4e-0b51-4a1c-8cbf-3f0d5c1a2b3c')).rejects.toThrow(/bucket does not exist/);
  });

  it('deletes the object and ignores an id that cannot name one', async () => {
    const fake = new FakeS3();
    const store = makeStore(fake);
    const { id } = await store.put(Readable.from(['gone']), { filename: 'a.txt', contentType: 'text/plain' });

    await store.delete(id);
    await store.delete('not-an-id');

    expect(fake.requests).toEqual(['put', 'delete']);
    expect(await store.get(id)).toBeNull();
  });

  it('streams large blobs through a multipart upload', async () => {
    const fake = new FakeS3();
    const store = makeStore(fake);
    const payload = Buffer.alloc(6 * 1024 * 1024, 7);
    const { id, size } = await store.put(Readable.from([payload.subarray(0, 3 * 1024 * 1024), payload.subarray(3 * 1024 * 1024)]), {
      filename: 'big.bin',
      contentType: 'application/octet-stream',
    });

    expect(size).toBe(payload.length);
    expect(fake.requests).toContain('createMultipartUpload');
    expect(fake.objects.get(`blobs/${id}`)?.body.equals(payload)).toBe(true);
  });

  it('writes the object at the root when no prefix is configured', async () => {
    const fake = new FakeS3();
    const { id } = await makeStore(fake, '').put(Readable.from(['x']), { filename: 'a.txt', contentType: 'text/plain' });
    expect([...fake.objects.keys()]).toEqual([id]);
  });
});
