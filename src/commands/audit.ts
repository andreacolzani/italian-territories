/**
 * §10.2. Samples come from a PRNG seeded with `today`, so a run is reproducible. A sample that is not
 * a calendar date must equal the stored snapshot of the previous calendar date `p` (§6.5): if it does
 * not, ISTAT changed the history after it was stored (the bisection would have found the change), so
 * `p` is fetched again first. Within `update` the audit runs before the snapshots, so its corrections
 * enter the same build.
 */
import {
  SNAPSHOT_ANOMALIES,
  failureCause,
  HISTORICAL_CODE_FALLBACK_UTS_CODES,
  HISTORICAL_CODE_FALLBACKS,
} from '../completeness/index.ts';
import { calendarDates, type Calendar } from '../calendar/index.ts';
import { compareDates, daysBetween, fromDayNumber, toDayNumber, type IsoDate } from '../dates/index.ts';
import { sha256 } from '../http/index.ts';
import { LEVELS, type Level } from '../model/common.ts';
import type { SnapshotResult } from '../sources/situas-public/index.ts';
import { contentHash, rowHash } from '../store/index.ts';
import { silentProgress, type StageProgress } from '../progress.ts';
import type { RunContext } from './context.ts';

export interface AuditDiscrepancy {
  date: IsoDate;
  level: Level;
  kind: 'changed' | 'inferred';
}

export interface AuditResult {
  samples: IsoDate[];
  discrepancies: AuditDiscrepancy[];
  inferredDates: IsoDate[];
  refreshFrom: IsoDate | null;
  failures: number;
}

export function sampleDates(start: IsoDate, today: IsoDate, n: number): IsoDate[] {
  const span = daysBetween(start, today);
  if (span <= 0 || n <= 0) return [];
  const first = toDayNumber(start);
  if (n >= span) return Array.from({ length: span }, (_, i) => fromDayNumber(first + i));
  const random = mulberry32(Number.parseInt(sha256(today).slice(0, 8), 16));
  const picked = new Set<number>();
  while (picked.size < n) picked.add(first + Math.floor(random() * span));
  return [...picked].sort((a, b) => a - b).map(fromDayNumber);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function runAudit(
  ctx: RunContext,
  calendar: Calendar,
  samples: number,
  budget: RefreshBudget,
  progress: StageProgress = silentProgress,
): Promise<AuditResult> {
  const { store, anomalies, logger } = ctx;
  const source = ctx.sources.situasPublic;
  const dates = calendarDates(calendar);
  const sampled = sampleDates(calendar.start, calendar.today, samples);
  const discrepancies: AuditDiscrepancy[] = [];
  const inferred = new Set<IsoDate>();
  let refreshFrom: IsoDate | null = null;
  let failures = 0;
  const from = (date: IsoDate) => {
    if (refreshFrom === null || compareDates(date, refreshFrom) < 0) refreshFrom = date;
  };

  const fetched = new Map<string, Fresh>();
  const fresh = async (level: Level, date: IsoDate): Promise<Fresh> => {
    const key = `${level}|${date}`;
    let result = fetched.get(key);
    if (result === undefined) {
      const { data, fetchedAt } = await source.fetchSnapshot(level, date, { cache: 'refresh' });
      result = { data, fetchedAt, hash: contentHash(data.snapshot.rows.map((r) => rowHash(r)).sort()) };
      fetched.set(key, result);
    }
    return result;
  };
  const put = (level: Level, date: IsoDate, f: Fresh) =>
    store.putSnapshot(level, date, f.data.pfun, {
      fetchedAt: f.fetchedAt,
      rows: f.data.snapshot.rows,
      adapterStats: {
        [HISTORICAL_CODE_FALLBACKS]: f.data.historicalCodeFallbacks,
        [HISTORICAL_CODE_FALLBACK_UTS_CODES]: f.data.historicalCodeFallbackUtsCodes,
      },
    });

  progress.add(sampled.length * LEVELS.length);
  sampling: for (const date of sampled) {
    for (const level of LEVELS) {
      let failed = false;
      try {
        const sample = await fresh(level, date);
        if (dates.includes(date)) {
          if ((await put(level, date, sample)).outcome === 'changed') {
            discrepancies.push({ date, level, kind: 'changed' });
            from(date);
          }
          continue;
        }
        const previous = previousCalendarDate(dates, date);
        const reference = previous === undefined ? undefined : await store.getSnapshotManifest(level, previous);
        if (previous === undefined || reference === undefined || reference.content_hash === sample.hash) continue;

        // ISTAT changed the history after it was stored: the stored previous calendar date first.
        if (!budget.consume(ctx)) break sampling;
        const base = await fresh(level, previous);
        if ((await put(level, previous, base)).outcome === 'changed') {
          discrepancies.push({ date: previous, level, kind: 'changed' });
        }
        from(previous);
        if (base.hash === sample.hash) continue;

        // A change hidden in (previous, date]: the first date differing from `previous` (§6.5).
        let lo = toDayNumber(previous) + 1;
        let hi = toDayNumber(date);
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (!budget.consume(ctx)) break sampling;
          if ((await fresh(level, fromDayNumber(mid))).hash === base.hash) lo = mid + 1;
          else hi = mid;
        }
        const change = fromDayNumber(hi);
        await put(level, change, await fresh(level, change));
        inferred.add(change);
        if (!dates.includes(change)) {
          dates.push(change);
          dates.sort(compareDates);
        }
        discrepancies.push({ date: change, level, kind: 'inferred' });
      } catch (error) {
        const cause = failureCause(error);
        if (cause === undefined) throw error;
        failed = true;
        failures++;
        const code = {
          unavailable: SNAPSHOT_ANOMALIES.unavailable,
          rejected: SNAPSHOT_ANOMALIES.rejected,
          'schema-violation': SNAPSHOT_ANOMALIES.schemaViolation,
        }[cause];
        anomalies.add({
          level: 'blocking',
          code,
          message: `audit: ${level} snapshot of ${date}: ${(error as Error).message}`,
          context: { level, date, audit: true, error: (error as Error).message },
        });
      } finally {
        progress.done(failed);
      }
    }
  }
  for (const d of discrepancies) {
    anomalies.add({
      level: 'warning',
      code: AUDIT_ANOMALIES.discrepancy,
      message:
        d.kind === 'changed'
          ? `audit: the ${d.level} snapshot of ${d.date} changed since it was stored`
          : `audit: the ${d.level} snapshots change on ${d.date}, a date the stored history does not show`,
      context: { ...d },
    });
  }
  logger.info('audit done', { samples: sampled.length, discrepancies: discrepancies.length, failures });
  ctx.summary.audit = { samples: sampled, discrepancies, failures };
  return {
    samples: sampled,
    discrepancies,
    inferredDates: [...inferred].sort(compareDates),
    refreshFrom,
    failures,
  };
}

interface Fresh {
  data: SnapshotResult;
  fetchedAt: IsoDate;
  hash: string;
}

/** Shared by the audit corrections and the refresh of the stored snapshots; once exhausted, the run blocks. */
export class RefreshBudget {
  #left: number;
  #exhausted = false;
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
    this.#left = limit;
  }

  get left(): number {
    return this.#left;
  }

  consume(ctx: RunContext, count = 1): boolean {
    if (this.#left >= count) {
      this.#left -= count;
      return true;
    }
    if (!this.#exhausted) {
      this.#exhausted = true;
      ctx.anomalies.add({
        level: 'blocking',
        code: REFRESH_TOO_LARGE,
        message: `more than ${this.limit} snapshots to fetch again to correct the store: run rebuild --refetch`,
        context: { limit: this.limit, requested: count, left: this.#left },
      });
    }
    return false;
  }
}

const REFRESH_TOO_LARGE = 'refresh-too-large';

const AUDIT_ANOMALIES = {
  discrepancy: 'audit-discrepancy',
} as const;

function previousCalendarDate(dates: readonly IsoDate[], date: IsoDate): IsoDate | undefined {
  let found: IsoDate | undefined;
  for (const d of dates) {
    if (compareDates(d, date) > 0) break;
    found = d;
  }
  return found;
}
