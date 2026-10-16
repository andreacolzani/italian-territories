/**
 * `content_hash` covers only the sorted row hashes (§6.3): changes to fields outside the projection,
 * or to `adapter_stats`, are not changes.
 */
import { z } from 'zod';
import { canonicalJson, sha256 } from '../http/index.ts';
import { LEVELS } from '../model/common.ts';
import { isoDateSchema } from '../model/public.ts';
import { INTERNAL_REPORTS } from '../sources/situas-internal/index.ts';
import { EVENT_LISTS } from '../sources/situas-public/index.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);

const adapterStatsSchema = z.record(z.string(), z.union([z.number(), z.array(z.string())]));
export type AdapterStats = z.output<typeof adapterStatsSchema>;

const historyEntry = z.strictObject({ fetched_at: isoDateSchema, content_hash: hash });

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
  /** Unencoded (§11.1). */
  report_url: z.string(),
  /** SHA-256 of the normalised URL: the manifest's file name. */
  key: hash,
  ...content,
  ...rowsAndHistory,
});
export type InternalReportManifest = z.output<typeof internalReportManifestSchema>;

export const countManifestSchema = z.strictObject({
  pfun: z.int(),
  date: isoDateSchema,
  ...content,
  ...rowsAndHistory,
});
export type CountManifest = z.output<typeof countManifestSchema>;

export const anprManifestSchema = z.strictObject({
  endpoint: z.literal('anpr:archivio-comuni'),
  ...content,
  ...rowsAndHistory,
});
export type AnprManifest = z.output<typeof anprManifestSchema>;

export type Manifest = SnapshotManifest | EventListManifest | InternalReportManifest | CountManifest | AnprManifest;

export function contentHash(sortedRowHashes: readonly string[]): string {
  return sha256(canonicalJson(sortedRowHashes));
}

export function sameStats(a: AdapterStats, b: AdapterStats): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
