/**
 * Per-level interval index of the snapshot store (§6.6): for every ISTAT code, the
 * maximal intervals `[validFrom, validTo)` during which the code identifies the same projected
 * snapshot row.
 *
 * The snapshot of a calendar date holds until the next calendar date (completeness, §6.5), and
 * the snapshot of the last date (today) is open. An interval ends when the code disappears or its
 * row changes, so consecutive intervals of a code may belong to the same entity (a rename) or to
 * different ones (code reuse, §3.5 item 4): the index says nothing about identity, which is
 * decided by identity resolution (§6.7).
 *
 * A code must be unique within a snapshot (§6.7). A duplicated code is a `blocking` anomaly and
 * the code is left out of that date, so every lookup of it there fails instead of guessing.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, containsDate, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import type { Level } from '../model/common.ts';
import type { SnapshotRowByLevel } from '../model/internal.ts';
import type { Hashed, Store } from '../store/index.ts';

/** A code identifying the same snapshot row over `[validFrom, validTo)`. */
export interface SnapshotInterval<L extends Level = Level> extends HalfOpenInterval {
  level: L;
  code: string;
  row: SnapshotRowByLevel[L];
}

/** The rows of the snapshot of one date, each with its row hash. */
export interface IndexedSnapshot<L extends Level> {
  date: IsoDate;
  rows: readonly Hashed<SnapshotRowByLevel[L]>[];
}

export const INTERVAL_INDEX_ANOMALIES = {
  /** Two rows of one snapshot with the same code. */
  duplicateCode: 'snapshot-duplicate-code',
} as const;

export class IntervalIndex<L extends Level = Level> {
  readonly level: L;
  readonly #byCode: ReadonlyMap<string, readonly SnapshotInterval<L>[]>;

  constructor(level: L, byCode: ReadonlyMap<string, readonly SnapshotInterval<L>[]>) {
    this.level = level;
    this.#byCode = byCode;
  }

  /** The interval of `code` containing `date`, if the code exists on that date. */
  at(code: string, date: IsoDate): SnapshotInterval<L> | undefined {
    return this.#byCode.get(code)?.find((interval) => containsDate(interval, date));
  }

  /** Every interval of `code`, sorted by `validFrom`. */
  intervals(code: string): readonly SnapshotInterval<L>[] {
    return this.#byCode.get(code) ?? [];
  }

  /** Every interval of every code, sorted by `validFrom`, then by code. */
  all(): SnapshotInterval<L>[] {
    return [...this.#byCode.values()]
      .flat()
      .sort((a, b) => compareDates(a.validFrom, b.validFrom) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  }

  /** The intervals containing `date` whose row satisfies `match`. */
  findAt(date: IsoDate, match: (row: SnapshotRowByLevel[L]) => boolean): SnapshotInterval<L>[] {
    const found: SnapshotInterval<L>[] = [];
    for (const intervals of this.#byCode.values()) {
      const interval = intervals.find((i) => containsDate(i, date));
      if (interval !== undefined && match(interval.row)) found.push(interval);
    }
    return found;
  }
}

export interface BuildIntervalIndexOptions<L extends Level> {
  level: L;
  /** The snapshots of the calendar dates, ascending and without duplicates. */
  snapshots: Iterable<IndexedSnapshot<L>> | AsyncIterable<IndexedSnapshot<L>>;
  anomalies: AnomalyCollector;
}

export async function buildIntervalIndex<L extends Level>(
  options: BuildIntervalIndexOptions<L>,
): Promise<IntervalIndex<L>> {
  const { level, anomalies } = options;
  const byCode = new Map<string, SnapshotInterval<L>[]>();
  const open = new Map<string, { hash: string; interval: SnapshotInterval<L> }>();
  const close = (code: string, validTo: IsoDate | null): void => {
    const current = open.get(code);
    if (current === undefined) return;
    current.interval.validTo = validTo;
    open.delete(code);
  };

  let previous: IsoDate | undefined;
  for await (const { date, rows } of options.snapshots) {
    if (previous !== undefined && compareDates(previous, date) >= 0) {
      throw new RangeError(`snapshot dates must ascend: ${date} after ${previous}`);
    }
    previous = date;

    const byCodeToday = new Map<string, Hashed<SnapshotRowByLevel[L]>[]>();
    for (const entry of rows) {
      const same = byCodeToday.get(entry.row.code);
      if (same === undefined) byCodeToday.set(entry.row.code, [entry]);
      else same.push(entry);
    }
    for (const [code, entries] of byCodeToday) {
      if (entries.length === 1) continue;
      byCodeToday.delete(code);
      anomalies.add({
        level: 'blocking',
        code: INTERVAL_INDEX_ANOMALIES.duplicateCode,
        message: `the ${level} snapshot of ${date} has ${entries.length} rows with code ${code}`,
        context: { level, date, code, rows: entries.map((e) => e.row) },
      });
    }

    for (const code of [...open.keys()]) {
      const entry = byCodeToday.get(code);
      if (entry?.[0]?.hash !== open.get(code)?.hash) close(code, date);
    }
    for (const [code, [entry]] of byCodeToday) {
      if (entry === undefined || open.has(code)) continue;
      const interval: SnapshotInterval<L> = { level, code, validFrom: date, validTo: null, row: entry.row };
      open.set(code, { hash: entry.hash, interval });
      const intervals = byCode.get(code);
      if (intervals === undefined) byCode.set(code, [interval]);
      else intervals.push(interval);
    }
  }
  return new IntervalIndex(level, byCode);
}

/**
 * Index of `level` from the snapshots stored for `dates` (the calendar, §6.4). Stored snapshots
 * of other dates (bisection probes inside a constant interval, dates after `--today`) are not
 * read. A calendar date without a stored snapshot of the current projection version is a bug:
 * the snapshot stage blocks the pipeline before (§6.5).
 */
export function loadIntervalIndex<L extends Level>(
  store: Store,
  level: L,
  dates: readonly IsoDate[],
  anomalies: AnomalyCollector,
): Promise<IntervalIndex<L>> {
  async function* snapshots(): AsyncGenerator<IndexedSnapshot<L>> {
    for (const date of [...dates].sort(compareDates)) {
      const stored = await store.getSnapshotEntries(level, date);
      if (stored === undefined) throw new Error(`no stored ${level} snapshot for calendar date ${date}`);
      yield { date, rows: stored.rows };
    }
  }
  return buildIntervalIndex({ level, snapshots: snapshots(), anomalies });
}
