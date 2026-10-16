/**
 * §10.2. Late events and audit discrepancies make stored snapshots obsolete, and the store-first
 * provider would never read them again, so I12 would compare the build with stale data. Beyond the
 * budget nothing is refreshed and the run blocks: a `rebuild --refetch` is needed.
 */
import {
  failureCause,
  SNAPSHOT_ANOMALIES,
  storeSnapshotProvider,
  type SnapshotFailureCause,
} from '../completeness/index.ts';
import { isBetweenInclusive, type IsoDate } from '../dates/index.ts';
import type { CachePolicy } from '../http/index.ts';
import { LEVELS, type Level } from '../model/common.ts';
import { silentProgress, type StageProgress } from '../progress.ts';
import type { RefreshBudget } from './audit.ts';
import type { RunContext } from './context.ts';

/** All of them, or none when the budget cannot cover them. */
export async function refreshStoredSnapshots(
  ctx: RunContext,
  from: IsoDate,
  to: IsoDate,
  budget: RefreshBudget,
  options: {
    policy?: CachePolicy;
    refreshed?: Set<string>;
    progress?: StageProgress;
  } = {},
): Promise<number> {
  const { refreshed, progress = silentProgress, policy = 'refresh' } = options;
  const { store, anomalies } = ctx;
  const targets: { level: Level; date: IsoDate }[] = [];
  for (const level of LEVELS) {
    for (const date of await store.snapshotDates(level)) {
      if (isBetweenInclusive(date, from, to)) targets.push({ level, date });
    }
  }
  if (!budget.consume(ctx, targets.length)) return 0;
  progress.add(targets.length);
  const provider = storeSnapshotProvider({
    store,
    source: ctx.sources.situasPublic,
    mustRefresh: () => true,
    refreshPolicy: policy,
  });

  // Bounded concurrency, as the snapshot stage: the workers share one queue; outcomes are reported
  // afterwards in target order, so counts and anomalies do not depend on completion order.
  const failures = new Map<number, { cause: SnapshotFailureCause; error: Error }>();
  let fatal: { error: unknown } | undefined;
  const queue = targets.entries();
  const worker = async () => {
    for (const [i, { level, date }] of queue) {
      if (fatal !== undefined) return;
      try {
        await provider.snapshot(level, date);
        progress.done();
      } catch (error) {
        const cause = failureCause(error);
        if (cause === undefined) {
          fatal ??= { error };
          return;
        }
        failures.set(i, { cause, error: error as Error });
        progress.done(true);
      }
    }
  };
  const workers = Math.min(ctx.config.http.maxConcurrency, targets.length);
  await Promise.all(Array.from({ length: workers }, worker));
  if (fatal !== undefined) throw fatal.error;

  let count = 0;
  for (const [i, { level, date }] of targets.entries()) {
    const failure = failures.get(i);
    if (failure === undefined) {
      count++;
      refreshed?.add(`${level}|${date}`);
    } else {
      const { cause, error } = failure;
      const code = {
        unavailable: SNAPSHOT_ANOMALIES.unavailable,
        rejected: SNAPSHOT_ANOMALIES.rejected,
        'schema-violation': SNAPSHOT_ANOMALIES.schemaViolation,
      }[cause];
      anomalies.add({
        level: 'blocking',
        code,
        message: `refresh of the stored ${level} snapshot of ${date}: ${error.message}`,
        context: { level, date, refresh: true, error: error.message },
      });
    }
  }
  ctx.logger.info('stored snapshots refreshed', { from, to, refreshed: count });
  return count;
}
