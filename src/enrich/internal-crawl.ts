/**
 * §6.8. Internal data comes before identity resolution because UTS and region identity depend on it
 * (D23). Each typed record returns only its own events; records of one `id_uts` under older codes
 * return the same rows. Details are queried with the event row's own origin id and type: r8 answers
 * `CSCT` of the Milano metropolitan city for `id_uts_origine=9`, not for its `id_uts` 119. An r6
 * response is the entity's full history, so the pairs it lists need no request of their own.
 * Missing data is only a `warning` here: whether a decision needs it is up to identity (§6.7).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { failureCause, type SnapshotFailureCause } from '../completeness/index.ts';
import { canonicalJson, type CachePolicy, type ClientResult, type RequestOptions } from '../http/index.ts';
import { buildIdentityGraph, type IdentityGraph, type IdentitySource } from '../identity/identity-graph.ts';
import { silentLogger, type Logger } from '../logger.ts';
import { silentProgress, type StageProgress } from '../progress.ts';
import type { IsoDate } from '../dates/index.ts';
import { LEVELS, type IstatEventCode, type Level, type RegionType, type UtsType } from '../model/common.ts';
import {
  INTERNAL_REPORTS,
  reportUrls,
  type InternalMunicipalityEvent,
  type InternalRegionEvent,
  type InternalReportNumber,
  type InternalUtsEvent,
  type MunicipalityEventDetail,
  type MunicipalityEventQuery,
  type MunicipalityRecordQuery,
  type RegionEventDetail,
  type RegionEventQuery,
  type RegionRecordQuery,
  type SituasInternalSource,
  type UtsEventDetail,
  type UtsEventQuery,
  type UtsRecordQuery,
} from '../sources/situas-internal/index.ts';
import type { InternalRowByReport, Store } from '../store/index.ts';
import { summariseEventCodes, type EventCodeSummary } from './event-codes.ts';
import { obtainInternalReport, type ObtainedReport } from './internal-reports.ts';

export const INTERNAL_CRAWL_ANOMALIES = {
  /** D28. */
  emptyEvents: 'listed-record-without-events',
  stale: 'internal-data-stale',
  unavailable: 'internal-data-unavailable',
  rejected: 'internal-request-rejected',
  schemaViolation: 'internal-schema-violation',
} as const;

/** No associated territories. */
const EVENTS_WITHOUT_DETAILS: readonly IstatEventCode[] = ['PV', 'CD', 'RN'];

export type CrawlItem =
  | { report: 1 | 2 | 3 }
  | { report: 4; record: RegionRecordQuery }
  | { report: 5; record: UtsRecordQuery }
  | { report: 6; record: MunicipalityRecordQuery }
  | { report: 7; query: RegionEventQuery }
  | { report: 8; query: UtsEventQuery }
  | { report: 9; query: MunicipalityEventQuery };

export interface CrawlFailure {
  item: CrawlItem;
  cause: SnapshotFailureCause;
  error: Error;
}

export interface CrawledEvent<E, D> {
  event: E;
  /** `null` also when not needed (`PV`, `CD`, `RN`, municipality events that are not ambiguous). */
  details: D[] | null;
}

export interface LevelCrawl<E, D> {
  level: Level;
  complete: boolean;
  graph: IdentityGraph<CrawledEvent<E, D>>;
}

export interface InternalCrawlResult {
  /** `null` when the level was not crawled or its list could not be obtained. */
  region: LevelCrawl<InternalRegionEvent, RegionEventDetail> | null;
  province: LevelCrawl<InternalUtsEvent, UtsEventDetail> | null;
  municipality: LevelCrawl<InternalMunicipalityEvent, MunicipalityEventDetail> | null;
  eventCodes: EventCodeSummary;
  stale: CrawlItem[];
  failures: CrawlFailure[];
  requests: Record<InternalReportNumber, number>;
}

export interface InternalCrawlOptions {
  source: SituasInternalSource;
  store: Store;
  anomalies: AnomalyCollector;
  concurrency: number;
  mustRefresh?: (item: CrawlItem) => boolean;
  refreshPolicy?: CachePolicy;
  offline?: boolean;
  levels?: readonly Level[];
  logger?: Logger;
  progress?: StageProgress;
}

export async function crawlInternal(options: InternalCrawlOptions): Promise<InternalCrawlResult> {
  const levels = options.levels ?? LEVELS;
  const crawl = new Crawl(options);
  // Sequential levels: the municipality crawl is long and must not starve the others' details.
  const region = levels.includes('region') ? await crawl.regions() : null;
  const province = levels.includes('province') ? await crawl.provinces() : null;
  const municipality = levels.includes('municipality') ? await crawl.municipalities() : null;
  const eventCodes = summariseEventCodes({ region, province, municipality });
  const result = { region, province, municipality, eventCodes, ...crawl.outcome() };
  crawl.report(result);
  return result;
}

class Crawl {
  readonly #source: SituasInternalSource;
  readonly #store: Store;
  readonly #anomalies: AnomalyCollector;
  readonly #mustRefresh: (item: CrawlItem) => boolean;
  readonly #refreshPolicy: CachePolicy;
  readonly #offline: boolean;
  readonly #logger: Logger;
  readonly #progress: StageProgress;
  readonly #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #stale: CrawlItem[] = [];
  readonly #failures: CrawlFailure[] = [];
  readonly #requests = Object.fromEntries(Object.keys(INTERNAL_REPORTS).map((n) => [n, 0])) as unknown as Record<
    InternalReportNumber,
    number
  >;

  constructor(options: InternalCrawlOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError(`invalid concurrency ${options.concurrency}`);
    }
    this.#source = options.source;
    this.#store = options.store;
    this.#anomalies = options.anomalies;
    this.#mustRefresh = options.mustRefresh ?? (() => false);
    this.#refreshPolicy = options.refreshPolicy ?? 'refresh';
    this.#offline = options.offline ?? false;
    this.#logger = options.logger ?? silentLogger;
    this.#progress = options.progress ?? silentProgress;
    this.#limit = options.concurrency;
  }

  regions(): Promise<LevelCrawl<InternalRegionEvent, RegionEventDetail> | null> {
    const source = this.#source;
    return this.#typedLevel<InternalRegionEvent, RegionEventDetail, RegionRecordQuery>({
      level: 'region',
      list: async () => (await this.#obtain({ report: 1 }, reportUrls.regionList(), (o) => source.regionList(o)))?.rows,
      events: (record) =>
        this.#obtain({ report: 4, record }, reportUrls.regionEvents(record), (o) => source.regionEvents(record, o)),
      details: (event) => {
        const query: RegionEventQuery = {
          originId: event.originId,
          regionType: event.type,
          actId: event.actId,
          event: event.event,
        };
        return this.#rows({ report: 7, query }, reportUrls.regionEventDetails(query), (o) =>
          source.regionEventDetails(query, o),
        );
      },
      pointer: (event) => ({ id: event.originId, originId: event.originId }),
    });
  }

  provinces(): Promise<LevelCrawl<InternalUtsEvent, UtsEventDetail> | null> {
    const source = this.#source;
    return this.#typedLevel<InternalUtsEvent, UtsEventDetail, UtsRecordQuery>({
      level: 'province',
      list: async () => (await this.#obtain({ report: 2 }, reportUrls.utsList(), (o) => source.utsList(o)))?.rows,
      events: (record) =>
        this.#obtain({ report: 5, record }, reportUrls.utsEvents(record), (o) => source.utsEvents(record, o)),
      details: (event) => {
        const query: UtsEventQuery = {
          originId: event.originId,
          utsType: event.type,
          actId: event.actId,
          event: event.event,
        };
        return this.#rows({ report: 8, query }, reportUrls.utsEventDetails(query), (o) =>
          source.utsEventDetails(query, o),
        );
      },
      pointer: (event) => ({ id: event.utsId, originId: event.originId }),
    });
  }

  async municipalities(): Promise<LevelCrawl<InternalMunicipalityEvent, MunicipalityEventDetail> | null> {
    const source = this.#source;
    const list = await this.#rows({ report: 3 }, reportUrls.municipalityList(), (o) => source.municipalityList(o));
    if (list === undefined) return null;

    const pairs = uniquePairs(list);
    const covered = new Map<string, 'store' | 'fresh'>();
    const histories: Response<InternalMunicipalityEvent>[] = [];
    let complete = true;
    const accept = (record: MunicipalityRecordQuery, events: InternalMunicipalityEvent[], from: 'store' | 'fresh') => {
      const cover = (code: string, name: string): void => {
        if (covered.get(pairKey({ code, name })) !== 'fresh') covered.set(pairKey({ code, name }), from);
      };
      cover(record.code, record.name);
      for (const e of events) {
        cover(e.code, e.name);
        cover(e.currentCode, e.currentName);
      }
      if (events.length === 0) this.#emptyEvents('municipality', record);
      histories.push({ listed: { ...record, type: null, originId: null }, events, fresh: from === 'fresh' });
    };

    // Stored histories first, without network: they decide which pairs are already covered.
    await Promise.all(
      pairs.map((record) =>
        this.#slot(async () => {
          if (this.#mustRefresh({ report: 6, record })) return;
          const stored = await this.#store.getInternalReport(6, reportUrls.municipalityEvents(record));
          if (stored !== undefined) accept(record, stored.rows, 'store');
        }),
      ),
    );
    await Promise.all(
      pairs.map((record) =>
        this.#slot(async () => {
          const coverage = covered.get(pairKey(record));
          if (coverage === 'fresh' || (coverage === 'store' && !this.#mustRefresh({ report: 6, record }))) return;
          const obtained = await this.#obtain({ report: 6, record }, reportUrls.municipalityEvents(record), (o) =>
            source.municipalityEvents(record, o),
          );
          if (obtained === undefined) complete = false;
          else accept(record, obtained.rows, obtained.origin === 'fetched' ? 'fresh' : 'store');
        }),
      ),
    );

    const sources = preferFresh(histories, (e) => e.originId).map(({ listed, events }) => ({
      listed,
      events: events.map((event): CrawledEvent<InternalMunicipalityEvent, MunicipalityEventDetail> => ({
        event,
        details: null,
      })),
    }));
    const graph = buildIdentityGraph({
      level: 'municipality',
      sources,
      pointer: ({ event }) => ({ id: event.originId, originId: event.originId }),
      record: ({ event }) => ({ id: event.originId, code: event.code, name: event.name, type: null }),
      date: ({ event }) => event.date,
      eventKey: ({ event }) => canonicalJson(event),
      anomalies: this.#anomalies,
    });
    const ambiguous = await this.#ambiguousDetails(graph);
    this.#logger.info('internal crawl level done', {
      territoryLevel: 'municipality',
      pairs: pairs.length,
      histories: sources.length,
      entities: graph.components.length,
      ambiguousEvents: ambiguous,
      complete,
    });
    return { level: 'municipality', complete, graph };
  }

  /**
   * r9 only for the events of one municipality with the same date and code under several acts (Riola
   * Sardo, two `CECS` of 1946-02-07): their territories match each public row to its act (§4.3).
   */
  async #ambiguousDetails(
    graph: IdentityGraph<CrawledEvent<InternalMunicipalityEvent, MunicipalityEventDetail>>,
  ): Promise<number> {
    const targets: CrawledEvent<InternalMunicipalityEvent, MunicipalityEventDetail>[] = [];
    for (const component of graph.components) {
      const acts = new Map<string, Set<number>>();
      for (const { event } of component.events) {
        const key = `${event.date}|${event.event}`;
        acts.set(key, (acts.get(key) ?? new Set()).add(event.actId));
      }
      for (const crawled of component.events) {
        if ((acts.get(`${crawled.event.date}|${crawled.event.event}`)?.size ?? 0) > 1) targets.push(crawled);
      }
    }
    const source = this.#source;
    await Promise.all(
      targets.map((crawled) =>
        this.#slot(async () => {
          const query: MunicipalityEventQuery = {
            originId: crawled.event.originId,
            actId: crawled.event.actId,
            event: crawled.event.event,
          };
          const rows = await this.#rows({ report: 9, query }, reportUrls.municipalityEventDetails(query), (o) =>
            source.municipalityEventDetails(query, o),
          );
          if (rows !== undefined) crawled.details = sortByKey(rows);
        }),
      ),
    );
    return targets.length;
  }

  outcome(): Pick<InternalCrawlResult, 'stale' | 'failures' | 'requests'> {
    return { stale: [...this.#stale], failures: [...this.#failures], requests: { ...this.#requests } };
  }

  report(result: InternalCrawlResult): void {
    for (const [report, items] of sortedGroups(this.#stale, (item) => item.report)) {
      this.#anomalies.add({
        level: 'warning',
        code: INTERNAL_CRAWL_ANOMALIES.stale,
        message: `${INTERNAL_REPORTS[report].endpoint}: ${items.length} mandatory refreshes failed, older data used`,
        context: { report: INTERNAL_REPORTS[report].endpoint, requests: items.map(describeItem) },
      });
    }
    for (const [, failures] of sortedGroups(this.#failures, (f) => `${f.item.report}|${f.cause}`)) {
      const [{ item, cause }] = failures as [CrawlFailure, ...CrawlFailure[]];
      const endpoint = INTERNAL_REPORTS[item.report].endpoint;
      const { level, code, text } = FAILURE_ANOMALIES[cause];
      this.#anomalies.add({
        level,
        code,
        message: `${endpoint}: ${failures.length} requests ${text}`,
        context: {
          report: endpoint,
          requests: failures.map((f) => ({ ...describeItem(f.item), error: f.error.message })),
        },
      });
    }
    this.#logger.info('internal crawl done', {
      requests: result.requests,
      stale: result.stale.length,
      failures: result.failures.length,
    });
  }

  async #typedLevel<
    E extends { event: IstatEventCode; date: IsoDate; code: string; name: string; type: RegionType | UtsType },
    D,
    Q extends { code: string; name: string; type: E['type'] },
  >(spec: {
    level: 'region' | 'province';
    list: () => Promise<(Q & { originId: number })[] | undefined>;
    events: (record: Q) => Promise<ObtainedReport<E> | undefined>;
    details: (event: E) => Promise<D[] | undefined>;
    pointer: (event: E) => { id: number; originId: number };
  }): Promise<LevelCrawl<E, D> | null> {
    const list = await spec.list();
    if (list === undefined) return null;
    let complete = true;

    const obtained = await Promise.all(
      list.map((listed) =>
        this.#slot(async (): Promise<Response<E>[]> => {
          const record = { code: listed.code, name: listed.name, type: listed.type } as Q;
          const report = await spec.events(record);
          if (report === undefined) {
            complete = false;
            return [];
          }
          if (report.rows.length === 0) this.#emptyEvents(spec.level, record);
          return [
            {
              listed: { ...record, originId: listed.originId },
              events: report.rows,
              fresh: report.origin === 'fetched',
            },
          ];
        }),
      ),
    );
    const responses = preferFresh(obtained.flat(), (e) => spec.pointer(e).id);

    const distinct = new Map<string, E>();
    for (const { events } of responses) for (const e of events) distinct.set(canonicalJson(e), e);
    const details = new Map<string, D[] | undefined>();
    await Promise.all(
      [...distinct.entries()]
        .filter(([, e]) => !EVENTS_WITHOUT_DETAILS.includes(e.event))
        .map(([key, e]) =>
          this.#slot(async () => {
            const rows = await spec.details(e);
            if (rows === undefined) complete = false;
            // Stored rows come back in hash order: sort them so the source does not matter.
            details.set(key, rows === undefined ? undefined : sortByKey(rows));
          }),
        ),
    );

    const crawled = (event: E): CrawledEvent<E, D> => ({ event, details: details.get(canonicalJson(event)) ?? null });
    const graph = buildIdentityGraph<CrawledEvent<E, D>>({
      level: spec.level,
      sources: responses.map(({ listed, events }) => ({ listed, events: events.map(crawled) })),
      pointer: ({ event }) => spec.pointer(event),
      record: ({ event }) => ({ id: spec.pointer(event).id, code: event.code, name: event.name, type: event.type }),
      date: ({ event }) => event.date,
      eventKey: ({ event }) => canonicalJson(event),
      anomalies: this.#anomalies,
    });
    this.#logger.info('internal crawl level done', {
      territoryLevel: spec.level,
      records: list.length,
      events: distinct.size,
      details: details.size,
      entities: graph.components.length,
      complete,
    });
    return { level: spec.level, complete, graph };
  }

  async #rows<N extends InternalReportNumber>(
    item: CrawlItem & { report: N },
    reportUrl: string,
    fetch: (options: RequestOptions) => Promise<ClientResult<InternalRowByReport[N][]>>,
  ): Promise<InternalRowByReport[N][] | undefined> {
    return (await this.#obtain(item, reportUrl, fetch))?.rows;
  }

  async #obtain<N extends InternalReportNumber>(
    item: CrawlItem & { report: N },
    reportUrl: string,
    fetch: (options: RequestOptions) => Promise<ClientResult<InternalRowByReport[N][]>>,
  ): Promise<ObtainedReport<InternalRowByReport[N]> | undefined> {
    this.#progress.add(1);
    try {
      const obtained = await obtainInternalReport(this.#store, {
        report: item.report,
        reportUrl,
        refresh: this.#mustRefresh(item),
        refreshPolicy: this.#refreshPolicy,
        offline: this.#offline,
        fetch: (options) => {
          this.#requests[item.report]++;
          return fetch(options);
        },
      });
      if (obtained.origin === 'stale') {
        this.#stale.push(item);
        this.#logger.warn('internal data stale', describeItem(item));
      }
      this.#progress.done();
      return obtained;
    } catch (error) {
      const cause = failureCause(error);
      if (cause === undefined) throw error;
      this.#progress.done(true);
      this.#failures.push({ item, cause, error: error as Error });
      // Schema violations are logged once, when the client disables the endpoint (the requests in
      // flight then and those refused afterwards are counted, not logged one by one).
      const log = cause === 'schema-violation' ? this.#logger.debug : this.#logger.warn;
      log('internal request failed', { ...describeItem(item), cause, error: error as Error });
      return undefined;
    }
  }

  #emptyEvents(level: Level, record: { code: string; name: string }): void {
    this.#anomalies.add({
      level: 'blocking',
      code: INTERNAL_CRAWL_ANOMALIES.emptyEvents,
      message: `listed ${level} record ${record.code} ${record.name} has no events`,
      context: { level, record },
    });
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

interface Response<E> extends IdentitySource<E> {
  events: E[];
  fresh: boolean;
}

/** So that a row ISTAT corrected never survives next to its correction. */
function preferFresh<E>(responses: readonly Response<E>[], id: (event: E) => number): Response<E>[] {
  const fresh = new Set(responses.flatMap((r) => (r.fresh ? r.events.map(id) : [])));
  if (fresh.size === 0) return [...responses];
  return responses.flatMap((r) => {
    if (r.fresh || r.events.length === 0) return [r];
    const events = r.events.filter((e) => !fresh.has(id(e)));
    return events.length === 0 ? [] : [{ ...r, events }];
  });
}

const FAILURE_ANOMALIES: Record<SnapshotFailureCause, { level: 'blocking' | 'warning'; code: string; text: string }> = {
  unavailable: { level: 'warning', code: INTERNAL_CRAWL_ANOMALIES.unavailable, text: 'unavailable, no copy to use' },
  rejected: { level: 'blocking', code: INTERNAL_CRAWL_ANOMALIES.rejected, text: 'rejected' },
  'schema-violation': {
    level: 'blocking',
    code: INTERNAL_CRAWL_ANOMALIES.schemaViolation,
    text: 'violate the schema',
  },
};

function describeItem(item: CrawlItem): Record<string, unknown> {
  return {
    endpoint: INTERNAL_REPORTS[item.report].endpoint,
    ...('record' in item ? item.record : {}),
    ...('query' in item ? item.query : {}),
  };
}

function pairKey(pair: MunicipalityRecordQuery): string {
  return `${pair.code}|${pair.name}`;
}

/** Sorted so the crawl order, and so the pairs skipped, do not depend on where the list came from. */
function uniquePairs(list: readonly MunicipalityRecordQuery[]): MunicipalityRecordQuery[] {
  const seen = new Map<string, MunicipalityRecordQuery>();
  for (const { code, name } of list)
    if (!seen.has(pairKey({ code, name }))) seen.set(pairKey({ code, name }), { code, name });
  return [...seen.values()].sort((a, b) => compareCodeUnits(a.code, b.code) || compareCodeUnits(a.name, b.name));
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedGroups<T, K extends number | string>(items: readonly T[], key: (item: T) => K): [K, T[]][] {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [item]);
    else group.push(item);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function sortByKey<R>(rows: readonly R[]): R[] {
  return rows
    .map((row) => ({ row, key: canonicalJson(row) }))
    .sort((a, b) => compareCodeUnits(a.key, b.key))
    .map((r) => r.row);
}
