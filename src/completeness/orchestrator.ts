/**
 * Snapshot orchestration and completeness verification (§6.5).
 *
 * Every `(level, date)` of the calendar is fetched in parallel. Then, for each level and each
 * pair of consecutive calendar dates `d_i < d_{i+1}`, the completeness invariant
 * `S(d_i) == S(d_{i+1} − 1)` is checked (projection equality, i.e. equal `content_hash`). When it
 * fails, `[d_i + 1, d_{i+1} − 1]` is binary-searched for the first date whose snapshot differs
 * from `S(d_i)`. That date is an `inferred` breakpoint: it is added to the **global** calendar,
 * so every level gets a snapshot on it, and the sub-intervals it creates are verified in the
 * next round, which finds further changes hidden in the same interval. Rounds repeat until no
 * interval of the calendar hides a change. Intervals never cross regimes, because the regime
 * boundaries are calendar dates (asserted).
 *
 * Inferred breakpoints carried over from earlier runs are checked first: one whose snapshots now
 * equal, at every level, those of the previous calendar date is no longer confirmed and leaves
 * the calendar (`info`). Every inferred breakpoint left in the final calendar is reported as a
 * `warning`, once per level that changes on it.
 *
 * Failures: a snapshot that cannot be obtained becomes a `blocking` anomaly whose code tells the
 * cause (`snapshot-unavailable`, `snapshot-request-rejected`, `snapshot-schema-violation`); the
 * intervals that need it become `completeness-unverified`. The run goes on, so one run collects
 * every problem, but its result is `blocked`: the pipeline must stop before identity resolution.
 * Any other error is a bug and propagates.
 */
import { AnomalyCollector } from '../anomalies.ts';
import { calendarDates, extendCalendar, removeCalendarSource, type Calendar } from '../calendar/index.ts';
import { compareDates, fromDayNumber, previousDay, toDayNumber, type IsoDate } from '../dates/index.ts';
import {
  CircuitOpenError,
  EndpointDisabledError,
  HttpStatusError,
  ResponseValidationError,
  RetriesExhaustedError,
} from '../http/index.ts';
import { silentLogger, type Logger } from '../logger.ts';
import { LEVELS, type Level } from '../model/common.ts';
import { regimeOf } from '../sources/situas-public/index.ts';
import {
  HISTORICAL_CODE_FALLBACK_UTS_CODES,
  HISTORICAL_CODE_FALLBACKS,
  type SnapshotInfo,
  type SnapshotProvider,
} from './snapshot-provider.ts';

/** Stable anomaly codes of this stage (§8.2). */
export const SNAPSHOT_ANOMALIES = {
  /**
   * Source unavailable (exit code 3): open circuit, or retries exhausted on timeouts, connection
   * errors, 5xx or 429.
   */
  unavailable: 'snapshot-unavailable',
  /** Non-retryable HTTP status (4xx other than 429): the request itself is refused (exit code 1). */
  rejected: 'snapshot-request-rejected',
  /** Permanent validation error, or the endpoint already disabled by one (exit code 1). */
  schemaViolation: 'snapshot-schema-violation',
  /** An interval whose completeness could not be checked because a snapshot is missing. */
  unverified: 'completeness-unverified',
  /** A calendar date known only by bisection, one per level that changes on it. */
  inferred: 'inferred-breakpoint',
  /** An inferred date of an earlier run whose snapshots no longer differ from the previous date. */
  inferredRemoved: 'inferred-breakpoint-removed',
  /** `COD_PROV_STORICO` fallbacks (§3.5 item 16), one per level. */
  historicalCodeFallback: 'historical-code-fallback',
} as const;

export type SnapshotFailureCause = 'unavailable' | 'rejected' | 'schema-violation';

const FAILURE_ANOMALIES: Record<SnapshotFailureCause, { code: string; text: string }> = {
  unavailable: { code: SNAPSHOT_ANOMALIES.unavailable, text: 'unavailable' },
  rejected: { code: SNAPSHOT_ANOMALIES.rejected, text: 'rejected' },
  'schema-violation': { code: SNAPSHOT_ANOMALIES.schemaViolation, text: 'violates the schema' },
};

export interface SnapshotFailure {
  level: Level;
  date: IsoDate;
  cause: SnapshotFailureCause;
  error: Error;
}

export interface InferredBreakpoint {
  /** Level whose snapshots revealed the change. */
  level: Level;
  date: IsoDate;
  /** Consecutive calendar dates `[from, to)` that hid it. */
  from: IsoDate;
  to: IsoDate;
}

export interface RemovedBreakpoint {
  date: IsoDate;
  /** The previous calendar date, whose snapshots equal those of `date` at every level. */
  from: IsoDate;
}

export interface SnapshotRunOptions {
  calendar: Calendar;
  provider: SnapshotProvider;
  anomalies: AnomalyCollector;
  /**
   * Snapshot requests in progress at once. The HTTP client paces the network; this bound keeps
   * decoded responses (municipality snapshots are large) out of memory.
   */
  concurrency: number;
  levels?: readonly Level[];
  logger?: Logger;
}

export interface SnapshotRunResult {
  /** The input calendar without unconfirmed inferred dates, plus the new ones (source `inferred`). */
  calendar: Calendar;
  /** Every snapshot obtained (calendar dates and bisection probes), by level and ascending date. */
  snapshots: Map<Level, Map<IsoDate, SnapshotInfo>>;
  /** Breakpoints found by this run's bisection, sorted by date, then level. */
  inferred: InferredBreakpoint[];
  /** Inferred dates of earlier runs no longer confirmed, ascending. */
  removed: RemovedBreakpoint[];
  /** Sorted by level, then date. */
  failures: SnapshotFailure[];
  /** Some snapshot could not be obtained: the pipeline stops before identity resolution. */
  blocked: boolean;
}

type Verification =
  { kind: 'complete' } | { kind: 'inferred'; date: IsoDate } | { kind: 'unverified'; missing: IsoDate[] };

export async function runSnapshots(options: SnapshotRunOptions): Promise<SnapshotRunResult> {
  const levels = options.levels ?? LEVELS;
  const logger = options.logger ?? silentLogger;
  const run = new SnapshotRun(options.provider, options.concurrency);

  const pruned = await pruneInferred(options.calendar, levels, run);
  for (const { date, from } of pruned.removed) {
    options.anomalies.add({
      level: 'info',
      code: SNAPSHOT_ANOMALIES.inferredRemoved,
      message: `inferred breakpoint ${date} removed: its snapshots equal those of ${from} at every level`,
      context: { date, from },
    });
    logger.info('inferred breakpoint removed', { date, from });
  }

  let calendar = pruned.calendar;
  const done = new Set<string>();
  const inferred: InferredBreakpoint[] = [];
  for (let round = 1; ; round++) {
    const dates = calendarDates(calendar);
    const intervals = levels.flatMap((level) =>
      consecutivePairs(dates).flatMap(([from, to]) =>
        done.has(intervalKey(level, from, to)) ? [] : [{ level, from, to }],
      ),
    );
    logger.info('snapshot round', { round, dates: dates.length, intervals: intervals.length });

    const [, verifications] = await Promise.all([
      Promise.all(levels.flatMap((level) => dates.map((date) => run.get(level, date)))),
      Promise.all(intervals.map(async (i) => ({ ...i, result: await run.verify(i.level, i.from, i.to) }))),
    ]);

    const found: InferredBreakpoint[] = [];
    for (const { level, from, to, result } of verifications) {
      done.add(intervalKey(level, from, to));
      if (result.kind === 'inferred') {
        // The bisection proved S(date − 1) == S(from): [from, date) is complete for this level.
        done.add(intervalKey(level, from, result.date));
        found.push({ level, date: result.date, from, to });
        logger.warn('inferred breakpoint found', { level, date: result.date, from, to });
      } else if (result.kind === 'unverified') {
        options.anomalies.add({
          level: 'blocking',
          code: SNAPSHOT_ANOMALIES.unverified,
          message: `completeness of ${level} snapshots on [${from}, ${to}) not verified: snapshots missing`,
          context: { level, from, to, missing: result.missing },
        });
      }
    }
    if (found.length === 0) break;
    inferred.push(...found);
    calendar = extendCalendar(calendar, [{ source: 'inferred', dates: found.map((f) => f.date) }]);
  }

  await reportInferred(calendar, levels, run, options.anomalies);
  const failures = run.failures();
  for (const failure of failures) {
    const { code, text } = FAILURE_ANOMALIES[failure.cause];
    options.anomalies.add({
      level: 'blocking',
      code,
      message: `${failure.level} snapshot of ${failure.date} ${text}: ${failure.error.message}`,
      context: { level: failure.level, date: failure.date, error: failure.error.message },
    });
  }
  const snapshots = run.snapshots(levels);
  reportHistoricalCodeFallbacks(snapshots, options.anomalies);

  inferred.sort((a, b) => compareDates(a.date, b.date) || levelOrder(a.level) - levelOrder(b.level));
  const result = {
    calendar,
    snapshots,
    inferred,
    removed: pruned.removed,
    failures,
    blocked: failures.length > 0,
  };
  logger.info('snapshots done', {
    snapshots: [...snapshots.values()].reduce((n, m) => n + m.size, 0),
    inferred: inferred.length,
    removed: pruned.removed.length,
    failures: failures.length,
    blocked: result.blocked,
  });
  return result;
}

/**
 * Drops the `inferred` source from the dates whose snapshots equal, at every level, those of the
 * previous date left in the calendar. A date with a missing snapshot is kept (the failure is
 * reported anyway); a date with other sources (e.g. an ANPR hint) stays without `inferred`.
 */
async function pruneInferred(
  calendar: Calendar,
  levels: readonly Level[],
  run: SnapshotRun,
): Promise<{ calendar: Calendar; removed: RemovedBreakpoint[] }> {
  const removed: RemovedBreakpoint[] = [];
  let previous: IsoDate | undefined;
  for (const [date, sources] of calendar.dates) {
    if (previous !== undefined && sources.includes('inferred')) {
      const from = previous;
      const same = await Promise.all(levels.map((level) => run.same(level, from, date)));
      if (same.every((s) => s === true)) {
        removed.push({ date, from });
        if (sources.length === 1) continue;
      }
    }
    previous = date;
  }
  const dates = removed.map((r) => r.date);
  return { calendar: removeCalendarSource(calendar, 'inferred', dates), removed };
}

/** One `warning` per inferred date of the final calendar and per level that changes on it. */
async function reportInferred(
  calendar: Calendar,
  levels: readonly Level[],
  run: SnapshotRun,
  anomalies: AnomalyCollector,
): Promise<void> {
  const dates = calendarDates(calendar);
  for (const [i, date] of dates.entries()) {
    const from = dates[i - 1];
    if (from === undefined || calendar.dates.get(date)?.includes('inferred') !== true) continue;
    const to = dates[i + 1] ?? null;
    for (const level of levels) {
      if ((await run.same(level, from, date)) !== false) continue;
      anomalies.add({
        level: 'warning',
        code: SNAPSHOT_ANOMALIES.inferred,
        message: `${level} snapshots change on ${date} without a published event (previous calendar date ${from})`,
        context: { level, date, from, to },
      });
    }
  }
}

/** Memoised snapshot requests of one run, with bounded concurrency. */
class SnapshotRun {
  readonly #provider: SnapshotProvider;
  readonly #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #requests = new Map<string, Promise<SnapshotInfo | undefined>>();
  readonly #obtained = new Map<string, SnapshotInfo>();
  readonly #failures = new Map<string, SnapshotFailure>();

  constructor(provider: SnapshotProvider, limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`invalid concurrency ${limit}`);
    this.#provider = provider;
    this.#limit = limit;
  }

  /** The snapshot, or `undefined` if it could not be obtained (the failure is recorded once). */
  get(level: Level, date: IsoDate): Promise<SnapshotInfo | undefined> {
    const key = `${level}|${date}`;
    let request = this.#requests.get(key);
    if (request === undefined) {
      request = this.#slot(async () => {
        try {
          const info = await this.#provider.snapshot(level, date);
          this.#obtained.set(key, info);
          return info;
        } catch (error) {
          const cause = failureCause(error);
          if (cause === undefined) throw error;
          this.#failures.set(key, { level, date, cause, error: error as Error });
          return undefined;
        }
      });
      this.#requests.set(key, request);
    }
    return request;
  }

  /** Checks `S(from) == S(to − 1)`; on failure, binary-searches the first differing date. */
  async verify(level: Level, from: IsoDate, to: IsoDate): Promise<Verification> {
    const last = previousDay(to);
    if (last === from) return { kind: 'complete' };
    if (regimeOf(from) !== regimeOf(last)) {
      throw new RangeError(`interval [${from}, ${to}) crosses a regime boundary missing from the calendar`);
    }
    const [first, end] = await Promise.all([this.get(level, from), this.get(level, last)]);
    const missing = [...(first === undefined ? [from] : []), ...(end === undefined ? [last] : [])];
    if (first === undefined || end === undefined) return { kind: 'unverified', missing };
    if (first.contentHash === end.contentHash) return { kind: 'complete' };

    // Invariant: S(lo − 1) == S(from) and S(hi) != S(from).
    let lo = toDayNumber(from) + 1;
    let hi = toDayNumber(last);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const date = fromDayNumber(mid);
      const probe = await this.get(level, date);
      if (probe === undefined) return { kind: 'unverified', missing: [date] };
      if (probe.contentHash === first.contentHash) lo = mid + 1;
      else hi = mid;
    }
    return { kind: 'inferred', date: fromDayNumber(hi) };
  }

  /** Whether `S(a) == S(b)`; `undefined` when either snapshot could not be obtained. */
  async same(level: Level, a: IsoDate, b: IsoDate): Promise<boolean | undefined> {
    const [x, y] = await Promise.all([this.get(level, a), this.get(level, b)]);
    return x === undefined || y === undefined ? undefined : x.contentHash === y.contentHash;
  }

  failures(): SnapshotFailure[] {
    return [...this.#failures.values()].sort(byLevelAndDate);
  }

  snapshots(levels: readonly Level[]): Map<Level, Map<IsoDate, SnapshotInfo>> {
    const sorted = [...this.#obtained.values()].sort(byLevelAndDate);
    return new Map(
      levels.map((level) => [level, new Map(sorted.filter((s) => s.level === level).map((s) => [s.date, s]))]),
    );
  }

  async #slot<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#active++;
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#active--;
      else next();
    }
  }
}

/**
 * Cause of a failed snapshot request, or `undefined` for errors that are not source failures
 * (bugs, store corruption), which must propagate.
 */
export function failureCause(error: unknown): SnapshotFailureCause | undefined {
  if (error instanceof ResponseValidationError || error instanceof EndpointDisabledError) return 'schema-violation';
  // A 4xx other than 429 is not retried: the server refuses the request, it is not unavailable.
  if (error instanceof HttpStatusError) return 'rejected';
  if (error instanceof RetriesExhaustedError || error instanceof CircuitOpenError) return 'unavailable';
  return undefined;
}

/**
 * One `info` anomaly per level summarising the `COD_PROV_STORICO` fallbacks (§3.5 item 16), from
 * the manifests' `adapter_stats`, so an offline rebuild reports the same.
 */
function reportHistoricalCodeFallbacks(
  snapshots: Map<Level, Map<IsoDate, SnapshotInfo>>,
  anomalies: AnomalyCollector,
): void {
  for (const [level, byDate] of snapshots) {
    const dates: IsoDate[] = [];
    let rows = 0;
    const utsCodes = new Set<string>();
    for (const [date, info] of byDate) {
      const count = info.adapterStats[HISTORICAL_CODE_FALLBACKS];
      if (typeof count !== 'number' || count === 0) continue;
      dates.push(date);
      rows += count;
      const codes = info.adapterStats[HISTORICAL_CODE_FALLBACK_UTS_CODES];
      if (Array.isArray(codes)) for (const code of codes) utsCodes.add(code);
    }
    if (dates.length === 0) continue;
    anomalies.add({
      level: 'info',
      code: SNAPSHOT_ANOMALIES.historicalCodeFallback,
      message: `${level} snapshots without COD_PROV_STORICO: the UTS code is used as historical code (${rows} rows in ${dates.length} snapshots)`,
      context: {
        level,
        snapshots: dates.length,
        rows,
        from: dates[0],
        to: dates[dates.length - 1],
        uts_codes: [...utsCodes].sort(),
      },
    });
  }
}

function consecutivePairs(dates: readonly IsoDate[]): [IsoDate, IsoDate][] {
  const pairs: [IsoDate, IsoDate][] = [];
  let previous: IsoDate | undefined;
  for (const date of dates) {
    if (previous !== undefined) pairs.push([previous, date]);
    previous = date;
  }
  return pairs;
}

function intervalKey(level: Level, from: IsoDate, to: IsoDate): string {
  return `${level}|${from}|${to}`;
}

function levelOrder(level: Level): number {
  return LEVELS.indexOf(level);
}

function byLevelAndDate(a: { level: Level; date: IsoDate }, b: { level: Level; date: IsoDate }): number {
  return levelOrder(a.level) - levelOrder(b.level) || compareDates(a.date, b.date);
}
