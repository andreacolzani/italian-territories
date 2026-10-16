import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class StoreCorruptionError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (${path})`);
    this.name = 'StoreCorruptionError';
    this.path = path;
  }
}

/** Offline runs never fetch (§6.3), so the caller treats this as the source being unavailable. */
export class NotInStoreError extends Error {
  constructor(what: string) {
    super(`${what} is not in the store (offline rebuild): run update or rebuild --refetch`);
    this.name = 'NotInStoreError';
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Writes through a temporary file and a rename, so readers never see a partial file. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export function toJsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
