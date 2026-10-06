/**
 * Snapshot store (§6.3): normalised, projected rows stored once by hash, plus one manifest per
 * stored response.
 *
 * Layout under the store directory:
 * - `rows/<level>.ndjson`, `snapshots/<level>/<date>.json`;
 * - `events/rows/pfun-<id>.ndjson`, `events/lists/pfun-<id>/<from>_<to>.json`;
 * - `internal/rows/r<n>.ndjson`, `internal/reports/r<n>/<key>.json`, where `key` is the SHA-256
 *   of the unencoded, normalised report URL;
 * - `counts/rows.ndjson`, `counts/pfun-<id>/<date>.json` (snapshot counts, I13);
 * - `anpr/rows.ndjson`, `anpr/manifest.json` (the ANPR archive without CSV lines, §6.11).
 *
 * Every manifest carries the `projection_version` of its kind (`projection-versions.ts`): a
 * manifest with another version is never returned and never compared with new content.
 *
 * A put whose content equals the stored one writes nothing (`fetched_at` stays the date of the
 * first fetch of that content); a different content appends the replaced one to `history`.
 * Event lists also report what changed **semantically**: the rows of the new list are compared
 * with every row the store knows in the same date range, whichever list they came from (§10.2:
 * consecutive updates fetch overlapping ranges with different `from`).
 */
import { join } from 'node:path';
import type { z } from 'zod';
import { compareDates, isBetweenInclusive, isAfter, maxDate, minDate, type IsoDate } from '../dates/index.ts';
import { normaliseUrl, sha256 } from '../http/index.ts';
import type { Level } from '../model/common.ts';
import type { SnapshotRowByLevel } from '../model/internal.ts';
import {
  INTERNAL_REPORTS,
  type InternalMunicipalityEvent,
  type InternalRegionEvent,
  type InternalReportNumber,
  type InternalUtsEvent,
  type MunicipalityEventDetail,
  type MunicipalityListRecord,
  type RegionEventDetail,
  type RegionListRecord,
  type UtsEventDetail,
  type UtsListRecord,
} from '../sources/situas-internal/index.ts';
import {
  EVENT_LISTS,
  snapshotPfun,
  type EventListPfun,
  type EventRowByLevel,
  type SnapshotPfun,
} from '../sources/situas-public/index.ts';
import { listDirs, listFiles, readTextIfExists, StoreCorruptionError, toJsonDocument, writeFileAtomic } from './fs.ts';
import type { AnprRecord } from '../sources/anpr/index.ts';
import {
  anprManifestSchema,
  contentHash,
  countManifestSchema,
  eventListManifestSchema,
  internalReportManifestSchema,
  sameStats,
  snapshotManifestSchema,
  type AdapterStats,
  type AnprManifest,
  type CountManifest,
  type EventListManifest,
  type InternalReportManifest,
  type Manifest,
  type SnapshotManifest,
} from './manifest.ts';
import { PROJECTION_VERSIONS, type ProjectionVersions } from './projection-versions.ts';
import { RowLog, type Hashed } from './row-log.ts';

/** Rows of an event list `pfun`. */
export type EventRowOf<P extends EventListPfun> = EventRowByLevel[(typeof EVENT_LISTS)[P]['level']];

/** Rows of an internal report. */
export interface InternalRowByReport {
  1: RegionListRecord;
  2: UtsListRecord;
  3: MunicipalityListRecord;
  4: InternalRegionEvent;
  5: InternalUtsEvent;
  6: InternalMunicipalityEvent;
  7: RegionEventDetail;
  8: UtsEventDetail;
  9: MunicipalityEventDetail;
}

/** The stored row of a count response. */
export interface CountRow {
  count: number;
}

/** One normalised response to store. */
export interface StoreInput<R> {
  /** `fetched_at` of the response (from the HTTP client). */
  fetchedAt: IsoDate;
  rows: readonly R[];
  adapterStats?: AdapterStats;
}

/**
 * `created`: no manifest of the current projection version existed; `reprojected`: one of another
 * version was replaced; `unchanged`: same content, nothing written (or only `adapter_stats`
 * updated); `changed`: different content, the previous one moved to `history`.
 */
export type PutOutcome = 'created' | 'reprojected' | 'unchanged' | 'changed';

export interface PutResult<M extends Manifest> {
  outcome: PutOutcome;
  manifest: M;
}

/** Rows of an event list that differ from what the store knew in the same range. */
export interface EventListPutResult<P extends EventListPfun> extends PutResult<EventListManifest> {
  added: EventRowOf<P>[];
  removed: EventRowOf<P>[];
}

export interface Stored<M extends Manifest, R> {
  manifest: M;
  /** Rows in `row_hashes` order. */
  rows: R[];
}

export interface StoreOptions {
  projectionVersions?: ProjectionVersions;
}

type ManifestContent = Pick<
  Manifest,
  'projection_version' | 'fetched_at' | 'content_hash' | 'adapter_stats' | 'row_hashes' | 'history'
>;

const MANIFEST_SUFFIX = '.json';

export class Store {
  readonly dir: string;
  readonly #versions: ProjectionVersions;
  readonly #logs = new Map<string, RowLog<unknown>>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Event list manifests per `pfun`, by file name (every projection version). */
  readonly #eventManifests = new Map<EventListPfun, Map<string, EventListManifest>>();

  constructor(dir: string, options: StoreOptions = {}) {
    this.dir = dir;
    this.#versions = options.projectionVersions ?? PROJECTION_VERSIONS;
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------------------------

  putSnapshot<L extends Level>(
    level: L,
    date: IsoDate,
    pfun: SnapshotPfun,
    input: StoreInput<SnapshotRowByLevel[L]>,
  ): Promise<PutResult<SnapshotManifest>> {
    const expected = snapshotPfun(level, date);
    if (pfun !== expected) throw new RangeError(`the ${level} snapshot of ${date} comes from pfun ${expected}`);
    const path = this.#snapshotPath(level, date);
    return this.#lock(path, async () => {
      const hashes = (await this.#snapshotLog(level).append(input.rows)).map((e) => e.hash);
      return this.#putManifest(path, snapshotManifestSchema, this.#versions.snapshot[level], hashes, input, (c) => ({
        level,
        date,
        pfun,
        ...c,
      }));
    });
  }

  async getSnapshot<L extends Level>(
    level: L,
    date: IsoDate,
  ): Promise<Stored<SnapshotManifest, SnapshotRowByLevel[L]> | undefined> {
    const manifest = await this.getSnapshotManifest(level, date);
    if (manifest === undefined) return undefined;
    return { manifest, rows: await this.#snapshotLog(level).rows(manifest.row_hashes) };
  }

  /** Like {@link getSnapshot}, keeping each row's hash next to it (equal rows, equal hashes). */
  async getSnapshotEntries<L extends Level>(
    level: L,
    date: IsoDate,
  ): Promise<Stored<SnapshotManifest, Hashed<SnapshotRowByLevel[L]>> | undefined> {
    const manifest = await this.getSnapshotManifest(level, date);
    if (manifest === undefined) return undefined;
    return { manifest, rows: await this.#snapshotLog(level).entries(manifest.row_hashes) };
  }

  /** The snapshot manifest of the current projection version, without reading its rows. */
  async getSnapshotManifest(level: Level, date: IsoDate): Promise<SnapshotManifest | undefined> {
    const manifest = await this.#readManifest(this.#snapshotPath(level, date), snapshotManifestSchema);
    return manifest?.projection_version === this.#versions.snapshot[level] ? manifest : undefined;
  }

  /** Dates with a stored snapshot manifest, ascending (`getSnapshot` still checks the version). */
  async snapshotDates(level: Level): Promise<IsoDate[]> {
    return manifestNames(await listFiles(join(this.dir, 'snapshots', level))).sort(compareDates);
  }

  // -------------------------------------------------------------------------------------------
  // Event lists
  // -------------------------------------------------------------------------------------------

  /** Stores the rows of event list `pfun` over `[from, to]` and reports the semantic difference. */
  putEventList<P extends EventListPfun>(
    pfun: P,
    from: IsoDate,
    to: IsoDate,
    input: StoreInput<EventRowOf<P>>,
  ): Promise<EventListPutResult<P>> {
    if (isAfter(from, to)) throw new RangeError(`empty range ${from}…${to}`);
    return this.#lock(`events:${pfun}`, async () => {
      const known = await this.#effectiveEventRows(pfun, from, to);
      const hashed = await this.#eventLog(pfun).append(input.rows);
      const fresh = hashed.filter((e) => isBetweenInclusive(e.row.date, from, to));
      const fileName = `${from}_${to}${MANIFEST_SUFFIX}`;
      const result = await this.#putManifest(
        join(this.#eventListDir(pfun), fileName),
        eventListManifestSchema,
        this.#versions.events[pfun],
        hashed.map((e) => e.hash),
        input,
        (c) => ({ pfun, level: EVENT_LISTS[pfun].level, from, to, ...c }),
      );
      (await this.#eventManifestsOf(pfun)).set(fileName, result.manifest);
      return { ...result, added: multisetMinus(fresh, known), removed: multisetMinus(known, fresh) };
    });
  }

  async getEventList<P extends EventListPfun>(
    pfun: P,
    from: IsoDate,
    to: IsoDate,
  ): Promise<Stored<EventListManifest, EventRowOf<P>> | undefined> {
    const manifest = (await this.#eventManifestsOf(pfun)).get(`${from}_${to}${MANIFEST_SUFFIX}`);
    if (manifest?.projection_version !== this.#versions.events[pfun]) return undefined;
    return { manifest, rows: await this.#eventLog(pfun).rows(manifest.row_hashes) };
  }

  /** Manifests of event list `pfun` with the current projection version, by `from`, then `to`. */
  async eventLists(pfun: EventListPfun): Promise<EventListManifest[]> {
    return [...(await this.#eventManifestsOf(pfun)).values()]
      .filter((m) => m.projection_version === this.#versions.events[pfun])
      .sort((a, b) => compareDates(a.from, b.from) || compareDates(a.to, b.to));
  }

  /**
   * What the store knows of event list `pfun` on `[from, to]`: for every date, the rows of the
   * most recently fetched list covering it. Dates no list covers have no rows.
   */
  eventRows<P extends EventListPfun>(pfun: P, from: IsoDate, to: IsoDate): Promise<EventRowOf<P>[]> {
    return this.#lock(`events:${pfun}`, async () => (await this.#effectiveEventRows(pfun, from, to)).map((r) => r.row));
  }

  // -------------------------------------------------------------------------------------------
  // Internal reports
  // -------------------------------------------------------------------------------------------

  putInternalReport<N extends InternalReportNumber>(
    report: N,
    reportUrl: string,
    input: StoreInput<InternalRowByReport[N]>,
  ): Promise<PutResult<InternalReportManifest>> {
    const key = internalReportKey(report, reportUrl);
    const path = join(this.dir, 'internal', 'reports', `r${report}`, `${key}${MANIFEST_SUFFIX}`);
    return this.#lock(path, async () => {
      const hashes = (await this.#internalLog(report).append(input.rows)).map((e) => e.hash);
      return this.#putManifest(
        path,
        internalReportManifestSchema,
        this.#versions.internal[report],
        hashes,
        input,
        (c) => ({
          report,
          endpoint: INTERNAL_REPORTS[report].endpoint,
          report_url: reportUrl,
          key,
          ...c,
        }),
      );
    });
  }

  async getInternalReport<N extends InternalReportNumber>(
    report: N,
    reportUrl: string,
  ): Promise<Stored<InternalReportManifest, InternalRowByReport[N]> | undefined> {
    const key = internalReportKey(report, reportUrl);
    const path = join(this.dir, 'internal', 'reports', `r${report}`, `${key}${MANIFEST_SUFFIX}`);
    const manifest = await this.#readManifest(path, internalReportManifestSchema);
    if (manifest?.projection_version !== this.#versions.internal[report]) return undefined;
    return { manifest, rows: await this.#internalLog(report).rows(manifest.row_hashes) };
  }

  /** Manifests of report `report` with the current projection version, by `key`. */
  async internalReports(report: InternalReportNumber): Promise<InternalReportManifest[]> {
    const dir = join(this.dir, 'internal', 'reports', `r${report}`);
    const manifests: InternalReportManifest[] = [];
    for (const name of (await listFiles(dir)).filter((n) => n.endsWith(MANIFEST_SUFFIX)).sort()) {
      const manifest = await this.#readManifest(join(dir, name), internalReportManifestSchema);
      if (manifest?.projection_version === this.#versions.internal[report]) manifests.push(manifest);
    }
    return manifests;
  }

  // -------------------------------------------------------------------------------------------
  // Counts and ANPR
  // -------------------------------------------------------------------------------------------

  /** Stores the count of the snapshot request of `pfun` on `date` (one row). */
  putCount(pfun: SnapshotPfun, date: IsoDate, input: StoreInput<CountRow>): Promise<PutResult<CountManifest>> {
    const path = this.#countPath(pfun, date);
    return this.#lock(path, async () => {
      const hashes = (await this.#log<CountRow>(join('counts', 'rows.ndjson')).append(input.rows)).map((e) => e.hash);
      return this.#putManifest(path, countManifestSchema, this.#versions.counts, hashes, input, (c) => ({
        pfun,
        date,
        ...c,
      }));
    });
  }

  async getCount(pfun: SnapshotPfun, date: IsoDate): Promise<Stored<CountManifest, CountRow> | undefined> {
    const manifest = await this.#readManifest(this.#countPath(pfun, date), countManifestSchema);
    if (manifest?.projection_version !== this.#versions.counts) return undefined;
    return { manifest, rows: await this.#log<CountRow>(join('counts', 'rows.ndjson')).rows(manifest.row_hashes) };
  }

  /** Count manifests of the current projection version, by `pfun`, then date. */
  async countManifests(): Promise<CountManifest[]> {
    const manifests: CountManifest[] = [];
    const root = join(this.dir, 'counts');
    for (const pfun of (await listDirs(root)).sort()) {
      for (const name of (await listFiles(join(root, pfun))).filter((n) => n.endsWith(MANIFEST_SUFFIX)).sort()) {
        const manifest = await this.#readManifest(join(root, pfun, name), countManifestSchema);
        if (manifest?.projection_version === this.#versions.counts) manifests.push(manifest);
      }
    }
    return manifests.sort((a, b) => a.pfun - b.pfun || compareDates(a.date, b.date));
  }

  /** Stores the ANPR archive (one manifest: the latest content, earlier ones in `history`). */
  putAnpr(input: StoreInput<AnprRecord>): Promise<PutResult<AnprManifest>> {
    const path = join(this.dir, 'anpr', `manifest${MANIFEST_SUFFIX}`);
    return this.#lock(path, async () => {
      const hashes = (await this.#anprLog().append(input.rows)).map((e) => e.hash);
      return this.#putManifest(path, anprManifestSchema, this.#versions.anpr, hashes, input, (c) => ({
        endpoint: 'anpr:archivio-comuni' as const,
        ...c,
      }));
    });
  }

  async getAnpr(): Promise<Stored<AnprManifest, AnprRecord> | undefined> {
    const manifest = await this.#readManifest(join(this.dir, 'anpr', `manifest${MANIFEST_SUFFIX}`), anprManifestSchema);
    if (manifest?.projection_version !== this.#versions.anpr) return undefined;
    return { manifest, rows: await this.#anprLog().rows(manifest.row_hashes) };
  }

  // -------------------------------------------------------------------------------------------

  async #putManifest<M extends Manifest>(
    path: string,
    schema: z.ZodType<M>,
    version: number,
    hashes: readonly string[],
    input: StoreInput<unknown>,
    build: (content: ManifestContent) => M,
  ): Promise<PutResult<M>> {
    const rowHashes = [...hashes].sort();
    const hash = contentHash(rowHashes);
    const stats = input.adapterStats ?? {};
    const existing = await this.#readManifest(path, schema);
    const write = async (manifest: M, outcome: PutOutcome): Promise<PutResult<M>> => {
      await writeFileAtomic(path, toJsonDocument(schema.parse(manifest)));
      return { outcome, manifest };
    };
    const content = (fetchedAt: IsoDate, history: Manifest['history']): ManifestContent => ({
      projection_version: version,
      fetched_at: fetchedAt,
      content_hash: hash,
      adapter_stats: stats,
      row_hashes: rowHashes,
      history,
    });

    if (existing?.projection_version !== version) {
      return write(build(content(input.fetchedAt, [])), existing === undefined ? 'created' : 'reprojected');
    }
    if (existing.content_hash === hash) {
      if (sameStats(existing.adapter_stats, stats)) return { outcome: 'unchanged', manifest: existing };
      return write(build(content(existing.fetched_at, existing.history)), 'unchanged');
    }
    const replaced = { fetched_at: existing.fetched_at, content_hash: existing.content_hash };
    return write(build(content(input.fetchedAt, [...existing.history, replaced])), 'changed');
  }

  async #readManifest<M>(path: string, schema: z.ZodType<M>): Promise<M | undefined> {
    const text = await readTextIfExists(path);
    if (text === undefined) return undefined;
    try {
      return schema.parse(JSON.parse(text));
    } catch (error) {
      throw new StoreCorruptionError(`invalid manifest: ${(error as Error).message}`, path);
    }
  }

  async #effectiveEventRows<P extends EventListPfun>(
    pfun: P,
    from: IsoDate,
    to: IsoDate,
  ): Promise<Hashed<EventRowOf<P>>[]> {
    const newestFirst = (await this.eventLists(pfun)).sort(
      (a, b) => compareDates(b.fetched_at, a.fetched_at) || compareDates(b.to, a.to) || compareDates(a.from, b.from),
    );
    const covered: [IsoDate, IsoDate][] = [];
    const result: Hashed<EventRowOf<P>>[] = [];
    for (const manifest of newestFirst) {
      const lo = maxDate(manifest.from, from);
      const hi = minDate(manifest.to, to);
      if (isAfter(lo, hi)) continue;
      for (const entry of await this.#eventLog(pfun).entries(manifest.row_hashes)) {
        const date = entry.row.date;
        if (!isBetweenInclusive(date, lo, hi)) continue;
        if (covered.some(([a, b]) => isBetweenInclusive(date, a, b))) continue;
        result.push(entry);
      }
      covered.push([lo, hi]);
    }
    return result;
  }

  async #eventManifestsOf(pfun: EventListPfun): Promise<Map<string, EventListManifest>> {
    let manifests = this.#eventManifests.get(pfun);
    if (manifests === undefined) {
      const dir = this.#eventListDir(pfun);
      manifests = new Map();
      for (const name of (await listFiles(dir)).filter((n) => n.endsWith(MANIFEST_SUFFIX))) {
        const manifest = await this.#readManifest(join(dir, name), eventListManifestSchema);
        if (manifest !== undefined) manifests.set(name, manifest);
      }
      this.#eventManifests.set(pfun, manifests);
    }
    return manifests;
  }

  #snapshotPath(level: Level, date: IsoDate): string {
    return join(this.dir, 'snapshots', level, `${date}${MANIFEST_SUFFIX}`);
  }

  #eventListDir(pfun: EventListPfun): string {
    return join(this.dir, 'events', 'lists', `pfun-${pfun}`);
  }

  #countPath(pfun: SnapshotPfun, date: IsoDate): string {
    return join(this.dir, 'counts', `pfun-${pfun}`, `${date}${MANIFEST_SUFFIX}`);
  }

  #anprLog(): RowLog<AnprRecord> {
    return this.#log(join('anpr', 'rows.ndjson'));
  }

  #snapshotLog<L extends Level>(level: L): RowLog<SnapshotRowByLevel[L]> {
    return this.#log(join('rows', `${level}.ndjson`));
  }

  #eventLog<P extends EventListPfun>(pfun: P): RowLog<EventRowOf<P>> {
    return this.#log(join('events', 'rows', `pfun-${pfun}.ndjson`));
  }

  #internalLog<N extends InternalReportNumber>(report: N): RowLog<InternalRowByReport[N]> {
    return this.#log(join('internal', 'rows', `r${report}.ndjson`));
  }

  #log<R>(relative: string): RowLog<R> {
    let log = this.#logs.get(relative);
    if (log === undefined) {
      log = new RowLog(join(this.dir, relative));
      this.#logs.set(relative, log);
    }
    return log as RowLog<R>;
  }

  /** Runs `task` after every earlier task with the same key. */
  #lock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.#locks.set(key, settled);
    void settled.then(() => {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    });
    return run;
  }
}

/** File name of an internal report manifest: SHA-256 of the unencoded, normalised report URL. */
export function internalReportKey(report: InternalReportNumber, reportUrl: string): string {
  const prefix = `${INTERNAL_REPORTS[report].report}?`;
  if (!reportUrl.startsWith(prefix)) throw new RangeError(`'${reportUrl}' is not a URL of report r${report}`);
  return sha256(normaliseUrl(reportUrl));
}

function manifestNames(files: string[]): string[] {
  return files.filter((n) => n.endsWith(MANIFEST_SUFFIX)).map((n) => n.slice(0, -MANIFEST_SUFFIX.length));
}

/** Items of `a` not matched one-to-one by an item of `b` with the same hash, in `a` order. */
function multisetMinus<R>(a: readonly Hashed<R>[], b: readonly { hash: string }[]): R[] {
  const counts = new Map<string, number>();
  for (const { hash } of b) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  return a.flatMap(({ hash, row }) => {
    const n = counts.get(hash) ?? 0;
    if (n === 0) return [row];
    counts.set(hash, n - 1);
    return [];
  });
}
