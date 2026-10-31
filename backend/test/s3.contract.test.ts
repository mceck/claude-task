// Opt-in: a dedicated S3-compatible bucket. Normal test runs never contact object storage.
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { S3BlobStore } from '../src/blobstore/s3';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_TEST_SECRET_ACCESS_KEY;
const enabled = !!(endpoint && bucket && accessKeyId && secretAccessKey);

describe.skipIf(!enabled)('Live S3 blob store contract (dedicated bucket)', () => {
  const client = new S3Client({
    region: process.env.S3_TEST_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: process.env.S3_TEST_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
  });
  const store = new S3BlobStore({ bucket: bucket!, prefix: 'contract/', client });

  beforeAll(async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket! }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket! }));
    }
  });

  it('stores, reads back and deletes a blob', async () => {
    const text = 'hello from S3'.repeat(1000);
    const { id, size } = await store.put(Readable.from([text]), { filename: 'contratto ✓.txt', contentType: 'text/plain' });
    expect(size).toBe(Buffer.byteLength(text));

    const blob = await store.get(id);
    expect(blob?.metadata).toEqual({ filename: 'contratto ✓.txt', contentType: 'text/plain', size: Buffer.byteLength(text) });
    const chunks: Buffer[] = [];
    for await (const chunk of blob!.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe(text);

    await store.delete(id);
    expect(await store.get(id)).toBeNull();
  });

  it('uploads a blob larger than the multipart part size', async () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024, 42);
    const { id, size } = await store.put(Readable.from([bytes.subarray(0, 1024 * 1024), bytes.subarray(1024 * 1024)]), {
      filename: 'grande.bin',
      contentType: 'application/octet-stream',
    });
    expect(size).toBe(bytes.length);
    const blob = await store.get(id);
    const chunks: Buffer[] = [];
    for await (const chunk of blob!.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    await store.delete(id);
  });
});
