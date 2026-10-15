/**
 * §6.6. A snapshot holds until the next calendar date (§6.5). Consecutive intervals of a code may be
 * one entity (a rename) or different ones (code reuse, §3.5 item 4): identity is decided in §6.7.
 * A code duplicated within a snapshot is left out of that date, so lookups fail instead of guessing.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, containsDate, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import type { Level } from '../model/common.ts';
import type { SnapshotRowByLevel } from '../model/internal.ts';
import type { Hashed, Store } from '../store/index.ts';

export interface SnapshotInterval<L extends Level = Level> extends HalfOpenInterval {
  level: L;
  code: string;
  row: SnapshotRowByLevel[L];
}

export interface IndexedSnapshot<L extends Level> {
  date: IsoDate;
  rows: readonly Hashed<SnapshotRowByLevel[L]>[];
}

export const INTERVAL_INDEX_ANOMALIES = {
  duplicateCode: 'snapshot-duplicate-code',
} as const;

export class IntervalIndex<L extends Level = Level> {
  readonly level: L;
  readonly #byCode: ReadonlyMap<string, readonly SnapshotInterval<L>[]>;

  constructor(level: L, byCode: ReadonlyMap<string, readonly SnapshotInterval<L>[]>) {
    this.level = level;
    this.#byCode = byCode;
  }

  at(code: string, date: IsoDate): SnapshotInterval<L> | undefined {
    return this.#byCode.get(code)?.find((interval) => containsDate(interval, date));
  }

  intervals(code: string): readonly SnapshotInterval<L>[] {
    return this.#byCode.get(code) ?? [];
  }

  all(): SnapshotInterval<L>[] {
    return [...this.#byCode.values()]
      .flat()
      .sort((a, b) => compareDates(a.validFrom, b.validFrom) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  }

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
 * Only the calendar dates: stored bisection probes and dates after `--today` are not read. A
 * missing snapshot is a bug, since the snapshot stage blocks the pipeline first (§6.5).
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
