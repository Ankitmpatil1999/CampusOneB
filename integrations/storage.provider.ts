/**
 * Private file storage (CR-07, Q3). `local` keeps objects under UPLOAD_DIR, outside any web root,
 * for development; production uses S3-compatible object storage (not integrated yet, Q3/Q4).
 */
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

export interface StorageProvider {
  put(objectKey: string, data: Buffer): Promise<void>;
  read(objectKey: string): Readable;
  remove(objectKey: string): Promise<void>;
}

export function localStorage(root: string): StorageProvider {
  const base = resolve(root);
  const pathOf = (key: string) => {
    const p = resolve(base, key);
    if (!p.startsWith(base + sep)) throw new Error('object key escapes the upload directory');
    return p;
  };
  return {
    async put(key, data) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data, { flag: 'wx', mode: 0o600 });
    },
    read(key) {
      return createReadStream(pathOf(key));
    },
    async remove(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

export function createStorage(provider: 'local' | 's3', uploadDir: string): StorageProvider {
  if (provider === 'local') return localStorage(uploadDir);
  throw new Error("Storage provider 's3' is not integrated yet (Q3)");
}
