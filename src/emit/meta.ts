/**
 * `meta.json` (§9): versions, generation time, a summary per source family (§6.1), counts per
 * level and anomaly counts.
 *
 * A source family is summarised from the store manifests of the current projection version (§6.3)
 * it holds: `fetched_at` is the latest fetch date, `content_hash` the SHA-256 of the canonical JSON
 * of the sorted `[manifest key, content_hash]` pairs, `manifests` their number; a family without
 * manifests is null. `situas-public-reports` covers the stored event lists and counts; `anpr` the
 * stored ANPR archive (one manifest).
 */
import { type IsoDate, maxDate } from '../dates/index.ts';
import { canonicalJson, sha256 } from '../http/index.ts';
import { LEVELS } from '../model/common.ts';
import type { Anomaly, Meta, SourceFamily, SourceSummary } from '../model/public.ts';
import { INTERNAL_REPORTS, type InternalReportNumber } from '../sources/situas-internal/index.ts';
import { EVENT_LISTS, type EventListPfun } from '../sources/situas-public/index.ts';
import type { Store } from '../store/index.ts';
import { toDataVersion } from './changes.ts';
import type { PublicData } from './public.ts';

/** Semantic version of the published data contract (§9); its major is the npm package major. */
export const SCHEMA_VERSION = '1.0.0';

export type SourceSummaries = Record<SourceFamily, SourceSummary | null>;

interface ManifestRef {
  key: string;
  fetched_at: IsoDate;
  content_hash: string;
}

export function summariseManifests(manifests: readonly ManifestRef[]): SourceSummary | null {
  const [first, ...rest] = manifests;
  if (first === undefined) return null;
  const pairs = manifests.map((m) => [m.key, m.content_hash]).sort(([a], [b]) => compare(a ?? '', b ?? ''));
  return {
    fetched_at: maxDate(first.fetched_at, ...rest.map((m) => m.fetched_at)),
    content_hash: sha256(canonicalJson(pairs)),
    manifests: manifests.length,
  };
}

/** The summaries of the store's source families. */
export async function sourceSummaries(store: Store): Promise<SourceSummaries> {
  const snapshots: ManifestRef[] = [];
  for (const level of LEVELS) {
    for (const date of await store.snapshotDates(level)) {
      const manifest = await store.getSnapshotManifest(level, date);
      if (manifest !== undefined) snapshots.push({ key: `${level}/${date}`, ...pick(manifest) });
    }
  }
  const events: ManifestRef[] = [];
  for (const pfun of Object.keys(EVENT_LISTS).map(Number) as EventListPfun[]) {
    for (const m of await store.eventLists(pfun)) events.push({ key: `pfun-${pfun}/${m.from}_${m.to}`, ...pick(m) });
  }
  for (const m of await store.countManifests()) events.push({ key: `count:pfun-${m.pfun}/${m.date}`, ...pick(m) });
  const internal: ManifestRef[] = [];
  for (const report of Object.keys(INTERNAL_REPORTS).map(Number) as InternalReportNumber[]) {
    for (const m of await store.internalReports(report)) internal.push({ key: `r${report}/${m.key}`, ...pick(m) });
  }
  const anpr = await store.getAnpr();
  return {
    'situas-public-snapshots': summariseManifests(snapshots),
    'situas-public-reports': summariseManifests(events),
    'situas-internal': summariseManifests(internal),
    anpr: summariseManifests(anpr === undefined ? [] : [{ key: 'anpr', ...pick(anpr.manifest) }]),
  };
}

export function buildMeta(options: {
  data: PublicData;
  anomalies: readonly Anomaly[];
  generatedAt: string;
  today: IsoDate;
  sources: SourceSummaries;
}): Meta {
  const { data, anomalies } = options;
  const counts = (entities: readonly { status: string; versions: readonly unknown[] }[]) => ({
    entities: entities.length,
    active: entities.filter((e) => e.status === 'active').length,
    versions: entities.reduce((n, e) => n + e.versions.length, 0),
  });
  return {
    schema_version: SCHEMA_VERSION,
    data_version: toDataVersion(options.today),
    generated_at: options.generatedAt,
    sources: {
      'situas-public-snapshots': options.sources['situas-public-snapshots'],
      'situas-public-reports': options.sources['situas-public-reports'],
      'situas-internal': options.sources['situas-internal'],
      anpr: options.sources.anpr,
    },
    counts: {
      regions: counts(data.regions),
      provinces: counts(data.provinces),
      municipalities: counts(data.municipalities),
      variations: data.variations.length,
    },
    anomalies: {
      warning: anomalies.filter((a) => a.level === 'warning').length,
      info: anomalies.filter((a) => a.level === 'info').length,
    },
  };
}

function pick(m: { fetched_at: IsoDate; content_hash: string }): Omit<ManifestRef, 'key'> {
  return { fetched_at: m.fetched_at, content_hash: m.content_hash };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
