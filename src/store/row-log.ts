/**
 * Append-only, content-addressed row log (§6.3): one `{ "hash", "row" }` per NDJSON line, each
 * row stored once. The row hash is the SHA-256 (hex) of the canonical JSON of the projected row
 * (keys sorted, no whitespace).
 */
import { appendFile, mkdir, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJson, sha256 } from '../http/index.ts';
import { readTextIfExists, StoreCorruptionError } from './fs.ts';

export function rowHash(row: unknown): string {
  return sha256(canonicalJson(row));
}

export interface Hashed<R> {
  hash: string;
  row: R;
}

export class RowLog<R> {
  readonly path: string;
  #rows: Map<string, R> | undefined;
  /** Loads and appends run one at a time, in call order. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Adds the rows not stored yet (one write per call) and returns every input row with its hash,
   * in input order.
   */
  append(rows: readonly R[]): Promise<Hashed<R>[]> {
    return this.#serial(async () => {
      const stored = await this.#load();
      const hashed: Hashed<R>[] = [];
      const added = new Map<string, R>();
      for (const row of rows) {
        const canonical = canonicalJson(row);
        const hash = sha256(canonical);
        hashed.push({ hash, row });
        if (!stored.has(hash) && !added.has(hash)) added.set(hash, JSON.parse(canonical) as R);
      }
      if (added.size > 0) {
        const lines = [...added].map(([hash, row]) => `{"hash":"${hash}","row":${canonicalJson(row)}}\n`);
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, lines.join(''), 'utf8');
        for (const [hash, row] of added) stored.set(hash, row);
      }
      return hashed;
    });
  }

  /** Rows by hash, in the given order; an unknown hash means the store is corrupt. */
  async rows(hashes: readonly string[]): Promise<R[]> {
    return (await this.entries(hashes)).map((e) => e.row);
  }

  /** Like {@link rows}, keeping each hash next to its row. */
  entries(hashes: readonly string[]): Promise<Hashed<R>[]> {
    return this.#serial(async () => {
      const stored = await this.#load();
      return hashes.map((hash) => {
        const row = stored.get(hash);
        if (row === undefined) throw new StoreCorruptionError(`unknown row hash ${hash}`, this.path);
        return { hash, row };
      });
    });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Reads the log once. A last line without its newline is the trace of an interrupted append:
   * no manifest can reference it (rows are appended before manifests are written), so it is cut.
   */
  async #load(): Promise<Map<string, R>> {
    if (this.#rows !== undefined) return this.#rows;
    const text = (await readTextIfExists(this.path)) ?? '';
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    if (complete.length !== text.length) await truncate(this.path, Buffer.byteLength(complete, 'utf8'));

    const rows = new Map<string, R>();
    const lines = complete.split('\n');
    lines.pop();
    lines.forEach((line, index) => {
      let entry: { hash?: unknown; row?: unknown };
      try {
        entry = JSON.parse(line) as { hash?: unknown; row?: unknown };
      } catch {
        throw new StoreCorruptionError(`line ${index + 1} is not JSON`, this.path);
      }
      if (typeof entry.hash !== 'string' || entry.row === undefined || rowHash(entry.row) !== entry.hash) {
        throw new StoreCorruptionError(`line ${index + 1} does not match its hash`, this.path);
      }
      if (rows.has(entry.hash)) throw new StoreCorruptionError(`line ${index + 1} duplicates a row`, this.path);
      rows.set(entry.hash, entry.row as R);
    });
    this.#rows = rows;
    return rows;
  }
}
