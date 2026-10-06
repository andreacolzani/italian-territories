/**
 * Refresh of stored snapshots in `update` (§10.2, Step 17). Events ISTAT publishes late, and audit
 * discrepancies on calendar dates, can make the snapshots stored by earlier runs obsolete (e.g. the
 * previous run's today, stored before the event was published): the store-first provider would not
 * read them again and I12 would compare the build with stale data.
 *
 * Every stored snapshot (calendar dates and probes, every level) dated from the earliest such date
 * to the previous run's today is fetched again with `refresh`: the same content writes nothing, a
 * different one replaces it with `history` (D32). Above what is left of `update.maxRefreshSnapshots`
 * (shared with the audit corrections) nothing is refreshed and the run blocks (`refresh-too-large`):
 * a `rebuild --refetch` is needed. `rebuild --refetch` refreshes every stored snapshot, unbounded.
 */
import { failureCause, SNAPSHOT_ANOMALIES, storeSnapshotProvider } from '../completeness/index.ts';
import { isBetweenInclusive, type IsoDate } from '../dates/index.ts';
import { LEVELS, type Level } from '../model/common.ts';
import { silentProgress, type StageProgress } from '../progress.ts';
import type { RefreshBudget } from './audit.ts';
import type { RunContext } from './context.ts';

/**
 * Refreshes the stored snapshots dated in `[from, to]`, all of them or none when the budget cannot
 * cover them; returns how many were refreshed.
 */
export async function refreshStoredSnapshots(
  ctx: RunContext,
  from: IsoDate,
  to: IsoDate,
  budget: RefreshBudget,
  options: {
    /** Receives `<level>|<date>` of every snapshot refreshed. */
    refreshed?: Set<string>;
    progress?: StageProgress;
  } = {},
): Promise<number> {
  const { refreshed, progress = silentProgress } = options;
  const { store, anomalies } = ctx;
  const targets: { level: Level; date: IsoDate }[] = [];
  for (const level of LEVELS) {
    for (const date of await store.snapshotDates(level)) {
      if (isBetweenInclusive(date, from, to)) targets.push({ level, date });
    }
  }
  if (!budget.consume(ctx, targets.length)) return 0;
  progress.add(targets.length);
  const provider = storeSnapshotProvider({ store, source: ctx.sources.situasPublic, mustRefresh: () => true });
  let count = 0;
  for (const { level, date } of targets) {
    try {
      await provider.snapshot(level, date);
      count++;
      refreshed?.add(`${level}|${date}`);
      progress.done();
    } catch (error) {
      const cause = failureCause(error);
      if (cause === undefined) throw error;
      progress.done(true);
      const code = {
        unavailable: SNAPSHOT_ANOMALIES.unavailable,
        rejected: SNAPSHOT_ANOMALIES.rejected,
        'schema-violation': SNAPSHOT_ANOMALIES.schemaViolation,
      }[cause];
      anomalies.add({
        level: 'blocking',
        code,
        message: `refresh of the stored ${level} snapshot of ${date}: ${(error as Error).message}`,
        context: { level, date, refresh: true, error: (error as Error).message },
      });
    }
  }
  ctx.logger.info('stored snapshots refreshed', { from, to, refreshed: count });
  return count;
}
