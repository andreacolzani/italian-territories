/**
 * §6.1. An entry is written as soon as a valid response arrives, so an interrupted run resumes by
 * re-issuing its requests.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { compareDates, daysBetween, type IsoDate } from '../dates/index.ts';
import { isoDateSchema } from '../model/public.ts';
import { isReportBody } from './encode.ts';
import type { HttpRequest } from './transport.ts';

/** `fetchedSince` lets an interrupted `rebuild --refetch` resume the same day (§6.1). */
export type CachePolicy = 'prefer' | 'refresh' | { maxAgeDays: number } | { fetchedSince: IsoDate };

const cacheEntrySchema = z.strictObject({
  version: z.literal(1),
  key: z.string().regex(/^[0-9a-f]{64}$/),
  request: z.strictObject({
    method: z.enum(['GET', 'POST']),
    url: z.string(),
    body: z.unknown().optional(),
  }),
  fetched_at: isoDateSchema,
  status: z.int(),
  content_type: z.string().nullable(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Hash of the content a refresh replaced. */
  previous_content_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  body: z.string(),
});

export type CacheEntry = z.output<typeof cacheEntrySchema>;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sortQuery(query: string): string {
  return query
    .split('&')
    .filter((segment) => segment !== '')
    .map((segment, index) => ({ segment, name: segment.split('=', 1)[0] ?? '', index }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index))
    .map((p) => p.segment)
    .join('&');
}

export function normaliseUrl(url: string): string {
  const trimmed = url.trim();
  const q = trimmed.indexOf('?');
  let base = q < 0 ? trimmed : trimmed.slice(0, q);
  const origin = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)/i.exec(base);
  if (origin?.[1] !== undefined) base = origin[1].toLowerCase() + base.slice(origin[1].length);
  return q < 0 ? base : `${base}?${sortQuery(trimmed.slice(q + 1))}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function cacheKey(request: HttpRequest): string {
  const body = isReportBody(request.body) ? { ...request.body, url: normaliseUrl(request.body.url) } : request.body;
  return sha256(`${request.method}\n${normaliseUrl(request.url)}\n${body === undefined ? '' : canonicalJson(body)}`);
}

export function isFresh(entry: CacheEntry, policy: CachePolicy, today: IsoDate): boolean {
  if (policy === 'prefer') return true;
  if (policy === 'refresh') return false;
  if ('fetchedSince' in policy) return compareDates(entry.fetched_at, policy.fetchedSince) >= 0;
  return daysBetween(entry.fetched_at, today) <= policy.maxAgeDays;
}

export class ResponseCache {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  pathFor(key: string): string {
    return join(this.#dir, key.slice(0, 2), `${key}.json`);
  }

  /** An unreadable entry is a miss. */
  async get(key: string): Promise<CacheEntry | undefined> {
    let text: string;
    try {
      text = await readFile(this.pathFor(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const entry = cacheEntrySchema.parse(JSON.parse(text));
      return entry.key === key ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  /** Temporary file and rename, so readers never see a partial entry. */
  async put(entry: CacheEntry): Promise<void> {
    const path = this.pathFor(entry.key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(cacheEntrySchema.parse(entry)), 'utf8');
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }
}
