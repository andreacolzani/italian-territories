/**
 * Manifests of the store (§6.3). A manifest lists the sorted hashes of the rows of one stored
 * response (duplicates kept) and identifies its content by `content_hash`, the SHA-256 of the
 * canonical JSON of that list: only the normalised projection takes part, so changes to ignored
 * fields are not changes. `adapter_stats` (e.g. historical code fallbacks, §3.5 item 16) is
 * excluded from `content_hash`. `history` holds the contents a refresh replaced.
 */
import { z } from 'zod';
import { canonicalJson, sha256 } from '../http/index.ts';
import { LEVELS } from '../model/common.ts';
import { isoDateSchema } from '../model/public.ts';
import { INTERNAL_REPORTS } from '../sources/situas-internal/index.ts';
import { EVENT_LISTS } from '../sources/situas-public/index.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Counters and code lists (sorted, unique) reported by an adapter about one response; not part
 * of the content.
 */
export const adapterStatsSchema = z.record(z.string(), z.union([z.number(), z.array(z.string())]));
export type AdapterStats = z.output<typeof adapterStatsSchema>;

const historyEntry = z.strictObject({ fetched_at: isoDateSchema, content_hash: hash });
export type HistoryEntry = z.output<typeof historyEntry>;

const content = {
  projection_version: z.int().positive(),
  fetched_at: isoDateSchema,
  content_hash: hash,
  adapter_stats: adapterStatsSchema,
};
const rowsAndHistory = { row_hashes: z.array(hash), history: z.array(historyEntry) };

export const snapshotManifestSchema = z.strictObject({
  level: z.enum(LEVELS),
  date: isoDateSchema,
  pfun: z.int(),
  ...content,
  ...rowsAndHistory,
});
export type SnapshotManifest = z.output<typeof snapshotManifestSchema>;

const eventListPfuns = Object.keys(EVENT_LISTS).map(Number);

export const eventListManifestSchema = z.strictObject({
  pfun: z.int().refine((p) => eventListPfuns.includes(p), 'not an event list pfun'),
  level: z.enum(LEVELS),
  from: isoDateSchema,
  to: isoDateSchema,
  ...content,
  ...rowsAndHistory,
});
export type EventListManifest = z.output<typeof eventListManifestSchema>;

const internalReportNumbers = Object.keys(INTERNAL_REPORTS).map(Number);

export const internalReportManifestSchema = z.strictObject({
  report: z.int().refine((n) => internalReportNumbers.includes(n), 'not an internal report'),
  endpoint: z.string(),
  /** The report URL as built, unencoded (§11.1). */
  report_url: z.string(),
  /** SHA-256 of the normalised report URL: the manifest's file name. */
  key: hash,
  ...content,
  ...rowsAndHistory,
});
export type InternalReportManifest = z.output<typeof internalReportManifestSchema>;

export type Manifest = SnapshotManifest | EventListManifest | InternalReportManifest;

export function contentHash(sortedRowHashes: readonly string[]): string {
  return sha256(canonicalJson(sortedRowHashes));
}

export function sameStats(a: AdapterStats, b: AdapterStats): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
