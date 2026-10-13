/**
 * Source acquisition of the data commands (§10.1–§10.2): public event lists, internal
 * crawl, ANPR and counts, each stored (§6.3) and read back from the store, so an offline `rebuild`
 * sees exactly what an online run saw.
 *
 * Modes: `bootstrap` and `rebuild-refetch` fetch the full event-list range, `update` the range from
 * the previous run date minus `update.lookbackDays`; `rebuild` (offline) fetches nothing. Fetch
 * failures become blocking anomalies by cause (`event-list-*`, `count-*`, `internal-list-*`);
 * errors that are not source failures propagate.
 */
import { failureCause } from '../completeness/index.ts';
import { ANPR_ANOMALIES, loadAnpr, reportDroppedRows } from '../crosscheck/index.ts';
import { compareDates, maxDate, subtractDays, type IsoDate } from '../dates/index.ts';
import { checkEventRules } from '../build/index.ts';
import { crawlInternal, saveEventCodeSummary, type CrawlItem, type InternalCrawlResult } from '../enrich/index.ts';
import { canonicalJson, type CachePolicy } from '../http/index.ts';
import type { LevelEventLists } from '../identity/index.ts';
import { LEVELS, type Level } from '../model/common.ts';
import { anprRecord, type AnprIssue, type AnprRecord } from '../sources/anpr/index.ts';
import { reportUrls, type InternalReportNumber } from '../sources/situas-internal/index.ts';
import { EVENT_LISTS, snapshotPfun, type EventListPfun } from '../sources/situas-public/index.ts';
import { silentProgress, type StageProgress } from '../progress.ts';
import { timed, type RunContext } from './context.ts';
import { sourceFailureCode, type SourceFailurePrefix } from './exit-codes.ts';

export type RunMode = 'bootstrap' | 'update' | 'rebuild' | 'rebuild-refetch';

export function isOffline(mode: RunMode): boolean {
  return mode === 'rebuild';
}

/**
 * HTTP cache policy of the mandatory refreshes (§6.1): `rebuild --refetch` accepts what was
 * downloaded from `today` on, so an interrupted refetch run again the same day resumes where it
 * stopped; every other mode always goes to the network.
 */
export function refreshPolicy(mode: RunMode, today: IsoDate): CachePolicy {
  return mode === 'rebuild-refetch' ? { fetchedSince: today } : 'refresh';
}

/** `adapter_stats` key of the stored ANPR manifest: the issues of the dropped rows (canonical JSON). */
export const ANPR_ROW_ISSUES = 'row_issues';

const EVENT_LIST_PFUNS = (Object.keys(EVENT_LISTS).map(Number) as EventListPfun[]).sort((a, b) => a - b);

export type EventListsByLevel = { [L in Level]: LevelEventLists<L> };

export interface EventListsResult {
  lists: EventListsByLevel;
  /** Codes (subject and related) of the rows a fetch added or removed, per level (update). */
  touchedCodes: Record<Level, Set<string>>;
  /** Earliest date of the rows a fetch added or removed (update), `null` when none changed. */
  earliestChange: IsoDate | null;
}

/** Stage 1: fetch and store the public event lists, then read back what the store knows. */
export async function acquireEventLists(
  ctx: RunContext,
  mode: RunMode,
  previousToday: IsoDate | null,
  progress: StageProgress = silentProgress,
): Promise<EventListsResult> {
  const { config, today, store } = ctx;
  const start = config.dates.start;
  const touchedCodes = { region: new Set<string>(), province: new Set<string>(), municipality: new Set<string>() };
  let earliestChange: IsoDate | null = null;
  if (!isOffline(mode)) {
    const from =
      mode === 'update' && previousToday !== null
        ? maxDate(start, subtractDays(previousToday, config.update.lookbackDays))
        : start;
    progress.add(EVENT_LIST_PFUNS.length);
    for (const pfun of EVENT_LIST_PFUNS) {
      const level = EVENT_LISTS[pfun].level;
      try {
        const { data, fetchedAt } = await ctx.sources.situasPublic.fetchEventList(level, pfun, from, today, {
          cache: refreshPolicy(mode, today),
        });
        const put = await store.putEventList(pfun, from, today, { fetchedAt, rows: data });
        progress.done();
        ctx.summary.eventLists.push({
          pfun,
          from,
          to: today,
          outcome: put.outcome,
          added: put.added.length,
          removed: put.removed.length,
        });
        for (const row of [...put.added, ...put.removed]) {
          if (earliestChange === null || compareDates(row.date, earliestChange) < 0) earliestChange = row.date;
        }
        if (mode === 'update') {
          for (const row of [...put.added, ...put.removed]) {
            touchedCodes[level].add(row.code);
            if (row.related?.code !== undefined && row.related.code !== null) touchedCodes[level].add(row.related.code);
          }
        }
      } catch (error) {
        progress.done(true);
        reportSourceFailure(ctx, 'event-list', error, `event list pfun ${pfun} (${from}…${today})`, { pfun, from });
      }
    }
  }

  const lists = { region: {}, province: {}, municipality: {} } as Record<Level, Record<number, unknown[]>>;
  for (const pfun of EVENT_LIST_PFUNS) {
    if ((await store.eventLists(pfun)).length === 0) {
      if (isOffline(mode)) {
        ctx.anomalies.add({
          level: 'blocking',
          code: sourceFailureCode('event-list', 'unavailable'),
          message: `event list pfun ${pfun} is not in the store: run update or rebuild --refetch`,
          context: { pfun },
        });
      }
      continue;
    }
    lists[EVENT_LISTS[pfun].level][pfun] = await store.eventRows(pfun, start, today);
  }
  return { lists: lists as unknown as EventListsByLevel, touchedCodes, earliestChange };
}

/** Stage 2: the internal crawl, with the mandatory refreshes of the mode (§6.1, §6.8). */
export async function acquireInternal(
  ctx: RunContext,
  mode: RunMode,
  touchedCodes: EventListsResult['touchedCodes'],
  progress: StageProgress = silentProgress,
): Promise<InternalCrawlResult> {
  const { store } = ctx;
  let mustRefresh: (item: CrawlItem) => boolean = () => false;
  if (mode === 'rebuild-refetch') mustRefresh = () => true;
  if (mode === 'update') {
    // Records listed before this run: a record missing here is newly listed.
    const known = async (report: 1 | 2, url: string) =>
      new Set(
        ((await store.getInternalReport(report, url))?.rows ?? []).map((r) =>
          canonicalJson({ code: r.code, name: r.name, type: r.type }),
        ),
      );
    const regions = await known(1, reportUrls.regionList());
    const uts = await known(2, reportUrls.utsList());
    mustRefresh = (item) => {
      if (item.report <= 3) return true;
      if (item.report === 4) {
        return !regions.has(canonicalJson(item.record)) || touchedCodes.region.has(item.record.code);
      }
      if (item.report === 5) return !uts.has(canonicalJson(item.record)) || touchedCodes.province.has(item.record.code);
      // New pairs are fetched by the crawl anyway; pairs touched by new public rows are refreshed.
      if (item.report === 6) return touchedCodes.municipality.has(item.record.code);
      return false;
    };
  }
  const crawl = await crawlInternal({
    offline: isOffline(mode),
    source: ctx.sources.situasInternal,
    store,
    anomalies: ctx.anomalies,
    concurrency: ctx.config.http.maxConcurrency,
    mustRefresh,
    refreshPolicy: refreshPolicy(mode, ctx.today),
    logger: ctx.logger,
    progress,
  });
  // A list r1–r3 that could not be obtained at all (no copy) leaves its level without internal data.
  const lists: [InternalReportNumber, Level][] = [
    [1, 'region'],
    [2, 'province'],
    [3, 'municipality'],
  ];
  for (const [report, level] of lists) {
    const failure = crawl.failures.find((f) => f.item.report === report);
    if (failure?.cause !== 'unavailable' || crawl[level] !== null) continue;
    ctx.anomalies.add({
      level: 'blocking',
      code: sourceFailureCode('internal-list', 'unavailable'),
      message: `internal list r${report} unavailable and not in the store: ${failure.error.message}`,
      context: { report, level, error: failure.error.message },
    });
  }
  await saveEventCodeSummary(ctx.config.paths.reports, crawl.eventCodes);
  checkEventRules(crawl.eventCodes, ctx.anomalies);
  return crawl;
}

/**
 * Stage 3: the ANPR archive, fetched (except offline) and stored; the rows come from the store.
 * `null`: the cross-check is skipped (already reported with `anpr-unavailable`).
 */
export async function acquireAnpr(ctx: RunContext, mode: RunMode): Promise<AnprRecord[] | null> {
  const { store, anomalies } = ctx;
  if (!isOffline(mode)) {
    const data = await loadAnpr({
      source: ctx.sources.anpr,
      anomalies,
      request: { cache: refreshPolicy(mode, ctx.today) },
    });
    if (data === null) return null;
    await store.putAnpr({
      fetchedAt: data.fetchedAt,
      rows: data.rows.map(anprRecord),
      adapterStats: { [ANPR_ROW_ISSUES]: [...new Set(data.issues.map((i) => canonicalJson(i)))].sort() },
    });
    return storedAnprRows(ctx);
  }
  const stored = await store.getAnpr();
  if (stored === undefined) {
    anomalies.add({
      level: 'warning',
      code: ANPR_ANOMALIES.unavailable,
      message: 'ANPR cross-check skipped: the archive is not in the store (run update or rebuild --refetch)',
      context: { error: 'missing-from-store' },
    });
    return null;
  }
  const issues = stored.manifest.adapter_stats[ANPR_ROW_ISSUES];
  reportDroppedRows(Array.isArray(issues) ? issues.map((i) => JSON.parse(i) as AnprIssue) : [], anomalies);
  return storedAnprRows(ctx);
}

async function storedAnprRows(ctx: RunContext): Promise<AnprRecord[]> {
  return (await ctx.store.getAnpr())?.rows ?? [];
}

/**
 * Stage 7 inputs: the SITUAS counts of today's snapshot requests (I13), fetched (except offline)
 * and stored. `undefined` when a level has no count (already reported, blocking).
 */
export async function acquireCounts(ctx: RunContext, mode: RunMode): Promise<Record<Level, number> | undefined> {
  const { store, today } = ctx;
  const counts: Partial<Record<Level, number>> = {};
  for (const level of LEVELS) {
    const pfun = snapshotPfun(level, today);
    if (!isOffline(mode)) {
      try {
        const { data, fetchedAt } = await ctx.sources.situasPublic.fetchCount(
          pfun,
          { date: today },
          { cache: refreshPolicy(mode, today) },
        );
        await store.putCount(pfun, today, { fetchedAt, rows: [{ count: data }] });
      } catch (error) {
        reportSourceFailure(ctx, 'count', error, `count of pfun ${pfun} on ${today}`, { level, pfun, date: today });
        continue;
      }
    }
    const stored = await store.getCount(pfun, today);
    const [row] = stored?.rows ?? [];
    if (row === undefined) {
      ctx.anomalies.add({
        level: 'blocking',
        code: sourceFailureCode('count', 'unavailable'),
        message: `count of pfun ${pfun} on ${today} is not in the store: run update or rebuild --refetch`,
        context: { level, pfun, date: today },
      });
      continue;
    }
    counts[level] = row.count;
  }
  return LEVELS.every((l) => counts[l] !== undefined) ? (counts as Record<Level, number>) : undefined;
}

/** A source failure as a blocking anomaly by cause; anything else is a bug and is rethrown. */
export function reportSourceFailure(
  ctx: RunContext,
  prefix: SourceFailurePrefix,
  error: unknown,
  what: string,
  context: Record<string, unknown>,
): void {
  const cause = failureCause(error);
  if (cause === undefined) throw error;
  const message = (error as Error).message;
  ctx.anomalies.add({
    level: 'blocking',
    code: sourceFailureCode(prefix, cause),
    message: `${what}: ${message}`,
    context: { ...context, error: message },
  });
  ctx.logger.warn('source failure', { what, cause, error: message });
}

/** Runs the four acquisitions in their order, timed. */
export async function acquireSources(ctx: RunContext, mode: RunMode, previousToday: IsoDate | null) {
  const eventLists = await timed(ctx, 'event-lists', (progress) =>
    acquireEventLists(ctx, mode, previousToday, progress),
  );
  const internal = await timed(ctx, 'internal-crawl', (progress) =>
    acquireInternal(ctx, mode, eventLists.touchedCodes, progress),
  );
  const anpr = await timed(ctx, 'anpr', () => acquireAnpr(ctx, mode));
  const counts = await timed(ctx, 'counts', () => acquireCounts(ctx, mode));
  return { eventLists: eventLists.lists, earliestChange: eventLists.earliestChange, internal, anpr, counts };
}

export function sortedDates(dates: Iterable<IsoDate>): IsoDate[] {
  return [...new Set(dates)].sort(compareDates);
}
