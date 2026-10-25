import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface BlobMetadata {
  filename: string;
  contentType: string;
}

export interface StoredBlob {
  stream: Readable;
  metadata: BlobMetadata & { size: number };
}

/** Where attachment bytes live. */
export interface BlobStore {
  put(stream: Readable, metadata: BlobMetadata): Promise<{ id: string; size: number }>;
  get(id: string): Promise<StoredBlob | null>;
  delete(id: string): Promise<void>;
}

const ID_PATTERN = /^[0-9a-f-]{36}$/;

/** Stores each blob as a file plus a JSON sidecar under `dir`. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  async put(stream: Readable, metadata: BlobMetadata): Promise<{ id: string; size: number }> {
    await mkdir(this.dir, { recursive: true });
    const id = randomUUID();
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });
    try {
      await pipeline(stream, createWriteStream(this.file(id)));
      await writeFile(this.meta(id), JSON.stringify({ ...metadata, size }));
    } catch (err) {
      await this.delete(id);
      throw err;
    }
    return { id, size };
  }

  async get(id: string): Promise<StoredBlob | null> {
    if (!ID_PATTERN.test(id)) return null;
    let metadata: StoredBlob['metadata'];
    try {
      metadata = JSON.parse(await readFile(this.meta(id), 'utf8'));
    } catch {
      return null;
    }
    return { stream: createReadStream(this.file(id)), metadata };
  }

  async delete(id: string): Promise<void> {
    if (!ID_PATTERN.test(id)) return;
    await rm(this.file(id), { force: true });
    await rm(this.meta(id), { force: true });
  }

  private file(id: string) {
    return path.join(this.dir, id);
  }

  private meta(id: string) {
    return path.join(this.dir, `${id}.json`);
  }
}
