import { compareDates, type IsoDate } from '../dates/index.ts';
import { LEVELS, type Level } from '../model/common.ts';
import type { Store } from '../store/index.ts';
import type { SnapshotSet } from './i12-reconstruction.ts';

/** Bisection probes included (§6.3). */
export async function* storeSnapshotSets(
  store: Store,
  options: { until?: IsoDate; levels?: readonly Level[] } = {},
): AsyncGenerator<SnapshotSet> {
  const levels = options.levels ?? LEVELS;
  const dates = new Set<IsoDate>();
  for (const level of levels) for (const date of await store.snapshotDates(level)) dates.add(date);
  for (const date of [...dates].sort(compareDates)) {
    if (options.until !== undefined && compareDates(date, options.until) > 0) continue;
    const rows: SnapshotSet['rows'] = {};
    for (const level of levels) {
      const stored = await store.getSnapshot(level, date);
      if (stored !== undefined) (rows as Record<Level, readonly unknown[]>)[level] = stored.rows;
    }
    if (Object.keys(rows).length > 0) yield { date, rows };
  }
}
