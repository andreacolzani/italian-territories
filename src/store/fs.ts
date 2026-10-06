/** File helpers of the store (§6.3): atomic writes and tolerant reads. */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The store on disk is unreadable or inconsistent (e.g. a manifest references unknown rows). */
export class StoreCorruptionError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (${path})`);
    this.name = 'StoreCorruptionError';
    this.path = path;
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

/** The file's text, or `undefined` if it does not exist. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Names of the files in `dir` (none if it does not exist). */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Names of the subdirectories of `dir` (none if it does not exist). */
export async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Pretty JSON with a trailing newline, as every store document is written. */
export function toJsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
