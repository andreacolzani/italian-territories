/**
 * The data commands (§10.1–§10.2, Step 17): `bootstrap`, `update`, `rebuild [--refetch]` and
 * `audit`. Every run executes the whole pipeline: sources (§6.1–§6.3) → calendar (d) → audit
 * (update only) → snapshots and completeness (e) → build → invariants → emit. There is no shortcut
 * for "nothing changed": a new generator, an override or the registry may change the output, so the
 * emitter decides (`unchanged` → `dist/` not touched, nothing to commit).
 *
 * Effects by exit code: 0 and 2 write `dist/` and `registry/`; 1 and 3 write neither. The store and
 * `calendar.json` are always written (they cache the sources), and so is the run summary.
 */
import {
  anprContributions,
  buildCalendar,
  eventListContribution,
  extendCalendar,
  internalEventsContribution,
  loadCalendar,
  saveCalendar,
  type Calendar,
  type CalendarContribution,
} from '../calendar/index.ts';
import { runSnapshots, storeSnapshotProvider } from '../completeness/index.ts';
import { compareDates, type IsoDate } from '../dates/index.ts';
import { emitDataset, loadPublishedDataset, sourceSummaries } from '../emit/index.ts';
import type { InternalCrawlResult } from '../enrich/index.ts';
import type { Level } from '../model/common.ts';
import type { AnprRecord } from '../sources/anpr/index.ts';
import { EVENT_LISTS, type EventListPfun } from '../sources/situas-public/index.ts';
import { acquireSources, isOffline, refreshPolicy, type EventListsByLevel, type RunMode } from './acquire.ts';
import { RefreshBudget, runAudit, type AuditResult } from './audit.ts';
import { buildDataset } from './build.ts';
import { refreshStoredSnapshots } from './refresh.ts';
import { timed, type RunContext } from './context.ts';
import { EXIT_CODES, exitCodeOf, SOURCE_FAILURE_PREFIXES, type ExitCode } from './exit-codes.ts';
import { changeCounts } from './summary.ts';

/** `bootstrap`, `update`, `rebuild` and `rebuild --refetch`. */
export async function runPipeline(ctx: RunContext, mode: RunMode): Promise<ExitCode> {
  if (isOffline(mode) !== ctx.offline) {
    throw new Error(`mode ${mode} needs ${isOffline(mode) ? 'an offline' : 'an online'} run context`);
  }
  const { store, config, today, anomalies } = ctx;
  const previousCalendar = await loadCalendar(store.dir);
  if (mode === 'update') {
    const previousRelease = await loadPublishedDataset(config.paths.dist);
    if (previousCalendar === undefined || previousRelease === null) {
      return fail(
        ctx,
        `update needs the state of a previous run (${previousCalendar === undefined ? 'calendar.json in the store' : 'a release in dist/'}): ` +
          'run bootstrap, which resumes from the cache',
      );
    }
  }
  if (isOffline(mode) && previousCalendar === undefined) {
    return fail(ctx, 'rebuild without --refetch needs the store of a previous run (calendar.json): run bootstrap');
  }

  const sources = await acquireSources(ctx, mode, previousCalendar?.today ?? null);
  let calendar = await timed(ctx, 'calendar', () =>
    Promise.resolve(
      buildCalendar({
        start: config.dates.start,
        today,
        contributions: calendarContributions(sources.eventLists, sources.internal, sources.anpr, previousCalendar),
      }),
    ),
  );

  const budget = new RefreshBudget(config.update.maxRefreshSnapshots);
  let audit: AuditResult | null = null;
  if (mode === 'update') {
    audit = await timed(ctx, 'audit', (progress) =>
      runAudit(ctx, calendar, config.update.auditSamples, budget, progress),
    );
    if (audit.inferredDates.length > 0) {
      calendar = extendCalendar(calendar, [{ source: 'inferred', dates: audit.inferredDates }]);
    }
  }

  // Late events and audit discrepancies on calendar dates make stored snapshots obsolete (§10.2).
  if (mode === 'update' && previousCalendar !== undefined) {
    const [from] = [sources.earliestChange, audit?.refreshFrom ?? null]
      .filter((d): d is IsoDate => d !== null)
      .sort(compareDates);
    if (from !== undefined && compareDates(from, previousCalendar.today) <= 0) {
      const previousToday = previousCalendar.today;
      ctx.summary.refreshedSnapshots = await timed(ctx, 'refresh', (progress) =>
        refreshStoredSnapshots(ctx, from, previousToday, budget, { progress }),
      );
    }
  }

  // `rebuild --refetch` refreshes every source: the stored snapshots of earlier runs included.
  const refreshed = new Set<string>();
  if (mode === 'rebuild-refetch') {
    const unbounded = new RefreshBudget(Number.POSITIVE_INFINITY);
    ctx.summary.refreshedSnapshots = await timed(ctx, 'refresh', (progress) =>
      refreshStoredSnapshots(ctx, config.dates.start, today, unbounded, {
        refreshed,
        progress,
        policy: refreshPolicy(mode, today),
      }),
    );
  }

  const refreshAll = mode === 'rebuild-refetch';
  const snapshots = await timed(ctx, 'snapshots', (progress) =>
    runSnapshots({
      progress,
      calendar,
      provider: storeSnapshotProvider({
        store,
        source: ctx.sources.situasPublic,
        mustRefresh: (level, date) =>
          (refreshAll && !refreshed.has(`${level}|${date}`)) || (!isOffline(mode) && date === today),
        offline: isOffline(mode),
        refreshPolicy: refreshPolicy(mode, today),
      }),
      anomalies,
      concurrency: config.http.maxConcurrency,
      logger: ctx.logger,
    }),
  );
  await saveCalendar(store.dir, snapshots.calendar);
  const infos = [...snapshots.snapshots.values()].flatMap((m) => [...m.values()]);
  ctx.summary.snapshots = {
    fetched: infos.filter((i) => i.origin === 'fetched').length,
    from_store: infos.filter((i) => i.origin === 'store').length,
    inferred: snapshots.inferred.length,
    removed: snapshots.removed.length,
    failures: snapshots.failures.length,
  };

  // Without every snapshot, event list or internal list the build would rest on partial sources.
  const missingSources = anomalies
    .list('blocking')
    .some((a) =>
      [SOURCE_FAILURE_PREFIXES.eventList, SOURCE_FAILURE_PREFIXES.internalList].some((p) => a.code.startsWith(`${p}-`)),
    );
  if (snapshots.blocked || missingSources) {
    ctx.summary.message = 'sources incomplete: the pipeline stopped before identity resolution';
    return exitCodeOf(anomalies.list(), false);
  }

  const buildStart = ctx.runtime.now();
  const built = await timed(ctx, 'build', (progress) =>
    buildDataset(
      ctx,
      {
        calendar: snapshots.calendar,
        eventLists: sources.eventLists,
        internal: sources.internal,
        anpr: sources.anpr,
        counts: sources.counts,
      },
      progress,
    ),
  );
  ctx.summary.build = ctx.runtime.now() - buildStart;

  if (anomalies.has('blocking')) {
    ctx.summary.message = 'blocking anomalies: nothing published';
    return exitCodeOf(anomalies.list(), false);
  }

  const result = await timed(ctx, 'emit', async () => {
    const previous = await loadPublishedDataset(config.paths.dist);
    const summariesStart = ctx.runtime.now();
    const summaries = await sourceSummaries(store);
    ctx.summary.sourceSummaries = ctx.runtime.now() - summariesStart;
    return emitDataset({
      dir: config.paths.dist,
      world: { entities: built.entities, variations: built.variations },
      anomalies: anomalies.list(),
      previous,
      generatedAt: generatedAt(ctx),
      today,
      sources: summaries,
    });
  });
  await built.registry.save();

  const reasons = ctx.summary.retroactiveReasons;
  if (result.kind !== 'unchanged' && result.changes.retroactive) reasons.push('changes');
  if (built.retroactiveRemaps) reasons.push('registry-remaps');
  if (audit !== null && audit.discrepancies.length > 0) reasons.push('audit');
  ctx.summary.release = {
    kind: result.kind,
    data_version: result.kind === 'unchanged' ? null : result.meta.data_version,
    changes: result.kind === 'unchanged' ? null : changeCounts(result.changes),
  };
  ctx.summary.message =
    result.kind === 'unchanged' ? 'published data unchanged: nothing to commit' : `release written (${result.kind})`;
  return exitCodeOf(anomalies.list(), reasons.length > 0);
}

/** `audit`: fresh samples against the store; never publishes, exit 2 on discrepancies. */
export async function runAuditCommand(ctx: RunContext, samples: number): Promise<ExitCode> {
  const calendar = await loadCalendar(ctx.store.dir);
  if (calendar === undefined)
    return fail(ctx, 'audit needs the store of a previous run (calendar.json): run bootstrap');
  const audited = { ...calendar, today: ctx.today };
  const budget = new RefreshBudget(ctx.config.update.maxRefreshSnapshots);
  const result = await timed(ctx, 'audit', (progress) => runAudit(ctx, audited, samples, budget, progress));
  if (result.inferredDates.length > 0) {
    await saveCalendar(ctx.store.dir, extendCalendar(calendar, [{ source: 'inferred', dates: result.inferredDates }]));
  }
  // The corrections made the stored snapshots up to the last run's today obsolete (§10.2).
  const from = result.refreshFrom;
  if (from !== null && compareDates(from, calendar.today) <= 0) {
    ctx.summary.refreshedSnapshots = await timed(ctx, 'refresh', (progress) =>
      refreshStoredSnapshots(ctx, from, calendar.today, budget, { progress }),
    );
  }
  if (result.discrepancies.length > 0) ctx.summary.retroactiveReasons.push('audit');
  ctx.summary.message = `${result.discrepancies.length} discrepancies in ${result.samples.length} sampled dates`;
  return exitCodeOf(ctx.anomalies.list(), result.discrepancies.length > 0);
}

function calendarContributions(
  eventLists: EventListsByLevel,
  internal: InternalCrawlResult,
  anpr: readonly AnprRecord[] | null,
  previous: Calendar | undefined,
): CalendarContribution[] {
  const contributions: CalendarContribution[] = [];
  for (const pfun of Object.keys(EVENT_LISTS).map(Number) as EventListPfun[]) {
    const level: Level = EVENT_LISTS[pfun].level;
    const rows = (eventLists[level] as Record<number, readonly { date: string }[] | undefined>)[pfun];
    if (rows !== undefined) contributions.push(eventListContribution(pfun, rows));
  }
  const reports = [
    [4, internal.region],
    [5, internal.province],
    [6, internal.municipality],
  ] as const;
  for (const [report, crawl] of reports) {
    if (crawl === null) continue;
    const rows = crawl.graph.components.flatMap((c) => c.events.map((e) => ({ date: e.event.date })));
    contributions.push(internalEventsContribution(report, rows));
  }
  if (anpr !== null) contributions.push(...anprContributions(anpr));
  // Inferred breakpoints are kept across runs (Step 17); Step 6 drops those no longer confirmed.
  if (previous !== undefined) {
    const inferred = [...previous.dates].filter(([, s]) => s.includes('inferred')).map(([d]) => d);
    contributions.push({ source: 'inferred', dates: inferred });
  }
  return contributions;
}

function fail(ctx: RunContext, message: string): ExitCode {
  ctx.summary.message = message;
  ctx.logger.error(message);
  return EXIT_CODES.blocking;
}

/** `generated_at`: the wall clock, to the second. */
function generatedAt(ctx: RunContext): string {
  return ctx.runtime.wallClock().replace(/\.\d+Z$/, 'Z');
}
