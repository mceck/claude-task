import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsBlobStore } from '../src/blobstore';

describe('filesystem blob store', () => {
  let dir: string;
  let store: FsBlobStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ct-blobs-'));
    store = new FsBlobStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads back what it stored and forgets it after delete', async () => {
    const { id, size } = await store.put(Readable.from(['hello']), { filename: 'note.txt', contentType: 'text/plain' });
    expect(size).toBe(5);
    const blob = await store.get(id);
    expect(blob?.metadata).toMatchObject({ filename: 'note.txt', contentType: 'text/plain', size: 5 });
    const chunks: Buffer[] = [];
    for await (const chunk of blob!.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await store.delete(id);
    expect(await store.get(id)).toBeNull();
  });

  it('returns null when the data file is missing but its metadata sidecar remains', async () => {
    const { id } = await store.put(Readable.from(['partial delete']), { filename: 'note.txt', contentType: 'text/plain' });
    await unlink(path.join(dir, id));
    expect(await store.get(id)).toBeNull();
  });
});
