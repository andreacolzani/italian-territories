import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { buildCalendar, calendarDates, extendCalendar, type Calendar } from '../../src/calendar/index.ts';
import {
  runSnapshots,
  SNAPSHOT_ANOMALIES,
  storeSnapshotProvider,
  type SnapshotInfo,
  type SnapshotProvider,
} from '../../src/completeness/index.ts';
import { compareDates, daysBetween, isBefore, type IsoDate } from '../../src/dates/index.ts';
import {
  CircuitOpenError,
  EndpointDisabledError,
  HttpStatusError,
  ResponseValidationError,
  RetriesExhaustedError,
  type HttpRequest,
} from '../../src/http/index.ts';
import type { Level } from '../../src/model/common.ts';
import type { AdapterStats } from '../../src/store/index.ts';
import { Store } from '../../src/store/index.ts';
import { withTempDir } from '../helpers/http.ts';
import { withSources } from '../helpers/sources.ts';

const TODAY = '2026-10-01';
const REQUEST: HttpRequest = { method: 'GET', url: 'https://situas-servizi.istat.it/publish/reportspooljson?pfun=61' };

function calendar(dates: IsoDate[] = []): Calendar {
  return buildCalendar({
    start: '1861-03-17',
    today: TODAY,
    contributions: [{ source: 'events:pfun-98', dates }],
  });
}

/**
 * A simulated SITUAS: the snapshot of a level on D is identified by the changes of that level
 * dated ≤ D (snapshot inclusivity, §3.2). Counts the requests per `(level, date)`.
 */
function world(
  changes: Partial<Record<Level, IsoDate[]>>,
  options: {
    fail?: (level: Level, date: IsoDate) => Error | undefined;
    stats?: (level: Level, date: IsoDate) => AdapterStats;
  } = {},
) {
  const calls = new Map<string, number>();
  const provider: SnapshotProvider = {
    snapshot: (level, date) => {
      const key = `${level}|${date}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      const error = options.fail?.(level, date);
      if (error !== undefined) return Promise.reject(error);
      const applied = (changes[level] ?? []).filter((d) => !isBefore(date, d)).length;
      const info: SnapshotInfo = {
        level,
        date,
        contentHash: `${level}-${applied}`,
        adapterStats: options.stats?.(level, date) ?? {},
        origin: 'fetched',
        outcome: 'created',
      };
      return Promise.resolve(info);
    },
  };
  const callsOf = (level: Level): IsoDate[] =>
    [...calls.keys()]
      .filter((k) => k.startsWith(`${level}|`))
      .map((k) => k.slice(level.length + 1))
      .sort(compareDates);
  return { provider, calls, callsOf };
}

function run(cal: Calendar, provider: SnapshotProvider, levels?: Level[]) {
  const anomalies = new AnomalyCollector();
  return runSnapshots({ calendar: cal, provider, anomalies, concurrency: 4, ...(levels ? { levels } : {}) }).then(
    (result) => ({ result, anomalies }),
  );
}

describe('snapshot orchestration', () => {
  it('fetches every (level, date) of the calendar once and accepts a complete calendar', async () => {
    const events = ['1900-01-01', '1960-05-17', '2024-01-22'];
    const sim = world({ municipality: events, province: ['1960-05-17'] });
    const cal = calendar(events);
    const { result, anomalies } = await run(cal, sim.provider);

    expect(result.inferred).toEqual([]);
    expect(result.blocked).toBe(false);
    expect(calendarDates(result.calendar)).toEqual(calendarDates(cal));
    for (const level of ['region', 'province', 'municipality'] as const) {
      expect(result.snapshots.get(level)?.size).toBeGreaterThanOrEqual(calendarDates(cal).length);
      for (const date of calendarDates(cal)) expect(result.snapshots.get(level)?.has(date)).toBe(true);
    }
    // Each request is made once, even when needed by two intervals.
    expect([...sim.calls.values()].every((n) => n === 1)).toBe(true);
    expect(anomalies.list()).toEqual([]);
  });

  it('finds a hidden change in O(log n) calls and adds it to the global calendar', async () => {
    const sim = world({ municipality: ['1960-05-17'] });
    const cal = calendar();
    const { result, anomalies } = await run(cal, sim.provider);

    expect(result.inferred).toEqual([{ level: 'municipality', date: '1960-05-17', from: '1948-01-01', to: TODAY }]);
    expect(result.calendar.dates.get('1960-05-17')).toEqual(['inferred']);
    // Every level gets a snapshot on the inferred date (and its intervals verified).
    for (const level of ['region', 'province'] as const) {
      expect(sim.callsOf(level)).toContain('1960-05-17');
      expect(sim.callsOf(level)).toContain('1960-05-16');
    }
    const n = daysBetween('1948-01-01', TODAY);
    const probes = sim.callsOf('municipality').filter((d) => !result.calendar.dates.has(d));
    expect(probes.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)) + 2);
    expect(anomalies.list()).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: SNAPSHOT_ANOMALIES.inferred,
        context: { level: 'municipality', date: '1960-05-17', from: '1948-01-01', to: TODAY },
      }),
    ]);
  });

  it('finds two hidden changes in the same interval, each in O(log n) calls', async () => {
    const hidden = ['1953-02-11', '2001-07-30'];
    const sim = world({ municipality: hidden });
    const { result } = await run(calendar(), sim.provider, ['municipality']);

    expect(result.inferred.map((i) => i.date)).toEqual(hidden);
    expect(result.inferred[1]).toMatchObject({ from: '1953-02-11', to: TODAY });
    const n = daysBetween('1948-01-01', TODAY);
    const probes = sim.callsOf('municipality').filter((d) => !result.calendar.dates.has(d));
    expect(probes.length).toBeLessThanOrEqual(2 * (Math.ceil(Math.log2(n)) + 2));
  });

  it('finds changes on the first and the last day of an interval', async () => {
    const sim = world({ province: ['1948-01-02', '1960-12-31'] });
    const { result } = await run(calendar(['1961-01-01']), sim.provider);
    expect(result.inferred.map((i) => [i.level, i.date])).toEqual([
      ['province', '1948-01-02'],
      ['province', '1960-12-31'],
    ]);
  });

  it('verifies the intervals an inferred date creates for the other levels', async () => {
    // Both hidden in [1948-01-01, today): the region change is found in the same round, the
    // municipality change sits between the region date and today.
    const sim = world({ region: ['1970-01-01'], municipality: ['1970-01-01', '1990-06-01'] });
    const { result } = await run(calendar(), sim.provider);
    expect(result.inferred.map((i) => [i.date, i.level])).toEqual([
      ['1970-01-01', 'region'],
      ['1970-01-01', 'municipality'],
      ['1990-06-01', 'municipality'],
    ]);
    expect(calendarDates(result.calendar)).toContain('1990-06-01');
  });

  it('removes an inferred date of an earlier run that no level confirms any more (info, no warning)', async () => {
    // 1960-05-17 was inferred by an earlier run; a refetch shows no change there now.
    const sim = world({ municipality: ['1990-06-01'] });
    const cal = extendCalendar(calendar(), [
      { source: 'inferred', dates: ['1960-05-17', '1990-06-01'] },
      { source: 'anpr:start', dates: ['1975-03-01'] },
      { source: 'inferred', dates: ['1975-03-01'] },
    ]);
    const { result, anomalies } = await run(cal, sim.provider);

    expect(result.calendar.dates.has('1960-05-17')).toBe(false);
    // A date with another source stays, without `inferred`.
    expect(result.calendar.dates.get('1975-03-01')).toEqual(['anpr:start']);
    expect(result.calendar.dates.get('1990-06-01')).toEqual(['inferred']);
    expect(result.removed).toEqual([
      { date: '1960-05-17', from: '1948-01-01' },
      { date: '1975-03-01', from: '1948-01-01' },
    ]);
    expect(result.inferred).toEqual([]);
    expect(anomalies.list('info').map((a) => [a.code, a.context])).toEqual([
      [SNAPSHOT_ANOMALIES.inferredRemoved, { date: '1960-05-17', from: '1948-01-01' }],
      [SNAPSHOT_ANOMALIES.inferredRemoved, { date: '1975-03-01', from: '1948-01-01' }],
    ]);
    // The confirmed one is reported again as a warning; the removed ones are not.
    expect(anomalies.list('warning').map((a) => a.context)).toEqual([
      { level: 'municipality', date: '1990-06-01', from: '1975-03-01', to: TODAY },
    ]);
  });

  it('keeps an inferred date when a snapshot to compare is missing', async () => {
    const exhausted = new RetriesExhaustedError('snapshot:pfun-61', REQUEST, 6, 'timeout');
    const sim = world(
      {},
      { fail: (level, date) => (level === 'region' && date === '1960-05-17' ? exhausted : undefined) },
    );
    const cal = extendCalendar(calendar(), [{ source: 'inferred', dates: ['1960-05-17'] }]);
    const { result } = await run(cal, sim.provider);
    expect(result.calendar.dates.get('1960-05-17')).toEqual(['inferred']);
    expect(result.removed).toEqual([]);
    expect(result.blocked).toBe(true);
  });

  it('never bisects across a regime boundary', async () => {
    const cal: Calendar = {
      start: '1861-03-17',
      today: TODAY,
      dates: new Map([
        ['1920-01-01', ['today']],
        ['1930-01-01', ['today']],
      ]),
    };
    await expect(run(cal, world({}).provider)).rejects.toThrow(/regime boundary/);
  });

  it('records each failure once, by cause, and marks the run blocked', async () => {
    const unavailable = new CircuitOpenError(
      'snapshot:pfun-61',
      REQUEST,
      'situas-public-snapshots',
      'too many failures',
    );
    const invalid = new ResponseValidationError('row 3: COD_UTS missing');
    const refused = new HttpStatusError('snapshot:pfun-44', REQUEST, 404);
    const sim = world(
      {},
      {
        fail: (level, date) => {
          if (level === 'municipality' && date === '1948-01-01') return unavailable;
          if (level === 'province' && date === '1927-01-12') return invalid;
          if (level === 'region' && date === '1861-03-17') return refused;
          return undefined;
        },
      },
    );
    const { result, anomalies } = await run(calendar(), sim.provider);

    expect(result.blocked).toBe(true);
    expect(result.failures.map((f) => [f.level, f.date, f.cause])).toEqual([
      ['region', '1861-03-17', 'rejected'],
      ['province', '1927-01-12', 'schema-violation'],
      ['municipality', '1948-01-01', 'unavailable'],
    ]);
    expect(sim.calls.get('municipality|1948-01-01')).toBe(1);
    const blocking = anomalies.list('blocking');
    expect(blocking.filter((a) => a.code === SNAPSHOT_ANOMALIES.unavailable)).toHaveLength(1);
    expect(blocking.filter((a) => a.code === SNAPSHOT_ANOMALIES.schemaViolation)).toHaveLength(1);
    expect(blocking.filter((a) => a.code === SNAPSHOT_ANOMALIES.rejected).map((a) => a.context)).toEqual([
      { level: 'region', date: '1861-03-17', error: refused.message },
    ]);
    // The interval starting on each missing snapshot is unverified (the previous one ends the day
    // before).
    expect(
      blocking.filter((a) => a.code === SNAPSHOT_ANOMALIES.unverified).map((a) => [a.context.level, a.context.from]),
    ).toEqual([
      ['region', '1861-03-17'],
      ['province', '1927-01-12'],
      ['municipality', '1948-01-01'],
    ]);
  });

  it('classifies exhausted retries and disabled endpoints, and reports failed bisection probes', async () => {
    const exhausted = new RetriesExhaustedError('snapshot:pfun-61', REQUEST, 6, 'HTTP 503');
    const disabled = new EndpointDisabledError('snapshot:pfun-64', REQUEST, 'schema violation');
    const sim = world(
      { municipality: ['1960-05-17'] },
      {
        fail: (level, date) => {
          if (level === 'province' && date === '2026-09-30') return disabled;
          // The first bisection probe of the municipality interval.
          if (level === 'municipality' && isBefore('1948-01-01', date) && isBefore(date, '2026-09-30'))
            return exhausted;
          return undefined;
        },
      },
    );
    const { result, anomalies } = await run(calendar(), sim.provider);
    expect(result.inferred).toEqual([]);
    expect(new Set(result.failures.map((f) => f.cause))).toEqual(new Set(['unavailable', 'schema-violation']));
    const unverified = anomalies.list('blocking').filter((a) => a.code === SNAPSHOT_ANOMALIES.unverified);
    expect(unverified.map((a) => a.context)).toEqual([
      { level: 'province', from: '1948-01-01', to: TODAY, missing: ['2026-09-30'] },
      { level: 'municipality', from: '1948-01-01', to: TODAY, missing: [expect.any(String)] },
    ]);
  });

  it('propagates errors that are not source failures', async () => {
    const sim = world({}, { fail: (level) => (level === 'region' ? new TypeError('bug') : undefined) });
    await expect(run(calendar(), sim.provider)).rejects.toThrow('bug');
  });

  it('summarises COD_PROV_STORICO fallbacks in one info anomaly per level, from adapter_stats', async () => {
    const sim = world(
      {},
      {
        stats: (level, date): AdapterStats => {
          if (level === 'region' || isBefore(date, '1948-01-01')) return {};
          if (date === TODAY) return { historical_code_fallbacks: 0, historical_code_fallback_uts_codes: [] };
          return level === 'province'
            ? { historical_code_fallbacks: 92, historical_code_fallback_uts_codes: ['001', '092'] }
            : { historical_code_fallbacks: 3, historical_code_fallback_uts_codes: ['215'] };
        },
      },
    );
    const { anomalies } = await run(calendar(['1990-01-01']), sim.provider);
    const info = anomalies.list('info');
    expect(info.map((a) => [a.code, a.context])).toEqual([
      [
        SNAPSHOT_ANOMALIES.historicalCodeFallback,
        { level: 'province', snapshots: 4, rows: 368, from: '1948-01-01', to: '2026-09-30', uts_codes: ['001', '092'] },
      ],
      [
        SNAPSHOT_ANOMALIES.historicalCodeFallback,
        { level: 'municipality', snapshots: 4, rows: 12, from: '1948-01-01', to: '2026-09-30', uts_codes: ['215'] },
      ],
    ]);
  });
});

describe('store snapshot provider', () => {
  it('uses the stored manifest unless a refresh is required, and fetches what is missing', async () => {
    await withSources(async ({ situasPublic, calls }) => {
      await withTempDir(async (dir) => {
        const store = new Store(dir);
        const refresh = new Set<IsoDate>();
        const provider = storeSnapshotProvider({
          store,
          source: situasPublic,
          mustRefresh: (_level, date) => refresh.has(date),
        });

        const first = await provider.snapshot('municipality', '2024-01-21');
        expect(first).toMatchObject({ origin: 'fetched', outcome: 'created' });
        expect(first.adapterStats).toEqual({ historical_code_fallbacks: 0, historical_code_fallback_uts_codes: [] });
        expect(calls).toHaveLength(1);

        const again = await provider.snapshot('municipality', '2024-01-21');
        expect(again).toMatchObject({ origin: 'store', outcome: null, contentHash: first.contentHash });
        expect(calls).toHaveLength(1);

        refresh.add('2024-01-21');
        const refreshed = await provider.snapshot('municipality', '2024-01-21');
        expect(refreshed).toMatchObject({ origin: 'fetched', outcome: 'unchanged', contentHash: first.contentHash });
        expect(calls).toHaveLength(2);

        const next = await provider.snapshot('municipality', '2024-01-22');
        expect(next.contentHash).not.toBe(first.contentHash);
      });
    });
  });

  it('stores the fallback counters and UTS codes in adapter_stats', async () => {
    await withSources(async ({ situasPublic }) => {
      await withTempDir(async (dir) => {
        const store = new Store(dir);
        const provider = storeSnapshotProvider({ store, source: situasPublic, mustRefresh: () => false });
        const info = await provider.snapshot('province', '1948-01-01');
        expect(info.adapterStats.historical_code_fallbacks).toBe(92);
        const codes = info.adapterStats.historical_code_fallback_uts_codes;
        expect(Array.isArray(codes) && codes.length).toBe(92);
        expect((await store.getSnapshotManifest('province', '1948-01-01'))?.adapter_stats).toEqual(info.adapterStats);
      });
    });
  });

  it('runs the orchestration on real fixtures with the real store', async () => {
    await withSources(async ({ situasPublic }) => {
      await withTempDir(async (dir) => {
        const store = new Store(dir);
        // Fixture-only world: the municipality level on two consecutive days (golden-1).
        const cal: Calendar = {
          start: '1861-03-17',
          today: '2024-01-22',
          dates: new Map([
            ['2024-01-21', ['events:pfun-98']],
            ['2024-01-22', ['today']],
          ]),
        };
        const anomalies = new AnomalyCollector();
        const result = await runSnapshots({
          calendar: cal,
          provider: storeSnapshotProvider({ store, source: situasPublic, mustRefresh: (_l, d) => d === '2024-01-22' }),
          anomalies,
          concurrency: 2,
          levels: ['municipality'],
        });
        expect(result.blocked).toBe(false);
        expect([...(result.snapshots.get('municipality')?.keys() ?? [])]).toEqual(['2024-01-21', '2024-01-22']);
        expect(await store.snapshotDates('municipality')).toEqual(['2024-01-21', '2024-01-22']);
        expect(anomalies.list()).toEqual([]);
      });
    });
  });
});
