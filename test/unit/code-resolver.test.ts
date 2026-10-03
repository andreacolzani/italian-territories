import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { canonicalJson } from '../../src/http/index.ts';
import { buildIdentityGraph } from '../../src/identity/index.ts';
import type { IstatEventCode } from '../../src/model/common.ts';
import type { MunicipalitySnapshotRow, UtsSnapshotRow } from '../../src/model/internal.ts';
import {
  buildIntervalIndex,
  CodeResolver,
  internalAliases,
  INTERVAL_INDEX_ANOMALIES,
  loadIntervalIndex,
  municipalityAliases,
  ResolutionError,
  RESOLVER_ANOMALIES,
  type CodeAlias,
  type IntervalIndex,
} from '../../src/resolve/index.ts';
import type { MunicipalityEventRow } from '../../src/sources/situas-public/index.ts';
import { rowHash, Store } from '../../src/store/index.ts';
import { withTempDir } from '../helpers/http.ts';

function municipality(code: string, name: string, cadastralCode: string | null = null): MunicipalitySnapshotRow {
  return {
    code,
    officialName: name,
    italianName: name,
    foreignName: null,
    cadastralCode,
    utsCode: code.slice(0, 3),
    regionCode: '01',
    utsAbbreviation: 'XX',
    historicalUtsCode: code.slice(0, 3),
  };
}

function uts(code: string, name: string): UtsSnapshotRow {
  return { code, name, regionCode: '01', type: 'province', abbreviation: 'XX', historicalCode: code };
}

const hashed = <R>(rows: R[]) => rows.map((row) => ({ hash: rowHash(row), row }));

function municipalityIndex(
  snapshots: [IsoDate, MunicipalitySnapshotRow[]][],
  anomalies = new AnomalyCollector(),
): Promise<IntervalIndex<'municipality'>> {
  return buildIntervalIndex({
    level: 'municipality',
    snapshots: snapshots.map(([date, rows]) => ({ date, rows: hashed(rows) })),
    anomalies,
  });
}

const alias = (date: IsoDate, from: string, to: string): CodeAlias => ({
  level: 'municipality',
  date,
  from,
  to,
  source: 'events:pfun-105',
});

describe('interval index', () => {
  it('merges consecutive equal rows of a code and splits on changes and gaps', async () => {
    const a = municipality('001001', 'Alfa');
    const index = await municipalityIndex([
      ['2000-01-01', [a, municipality('001002', 'Beta')]],
      ['2000-02-01', [a, municipality('001002', 'Beta Nuova')]],
      ['2000-03-01', [a]],
      ['2000-04-01', [a, municipality('001002', 'Gamma')]],
    ]);
    expect(index.intervals('001001').map((i) => [i.validFrom, i.validTo])).toEqual([['2000-01-01', null]]);
    expect(index.intervals('001002').map((i) => [i.validFrom, i.validTo, i.row.officialName])).toEqual([
      ['2000-01-01', '2000-02-01', 'Beta'],
      ['2000-02-01', '2000-03-01', 'Beta Nuova'],
      ['2000-04-01', null, 'Gamma'],
    ]);
    expect(index.at('001002', '2000-02-29')?.row.officialName).toBe('Beta Nuova');
    expect(index.at('001002', '2000-03-15')).toBeUndefined();
    expect(index.at('001001', '1999-12-31')).toBeUndefined();
  });

  it('leaves a code duplicated in one snapshot out of that date, with a blocking anomaly', async () => {
    const anomalies = new AnomalyCollector();
    const index = await municipalityIndex(
      [
        ['2000-01-01', [municipality('001001', 'Alfa')]],
        ['2000-02-01', [municipality('001001', 'Alfa'), municipality('001001', 'Altra')]],
        ['2000-03-01', [municipality('001001', 'Alfa')]],
      ],
      anomalies,
    );
    expect(index.intervals('001001').map((i) => [i.validFrom, i.validTo])).toEqual([
      ['2000-01-01', '2000-02-01'],
      ['2000-03-01', null],
    ]);
    expect(anomalies.list()).toMatchObject([
      {
        level: 'blocking',
        code: INTERVAL_INDEX_ANOMALIES.duplicateCode,
        context: { date: '2000-02-01', code: '001001' },
      },
    ]);
  });

  it('rejects snapshot dates out of order', async () => {
    await expect(
      municipalityIndex([
        ['2000-02-01', []],
        ['2000-01-01', []],
      ]),
    ).rejects.toThrow(RangeError);
  });

  it('is loaded from the store for the calendar dates only', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(dir);
      const put = (date: IsoDate, rows: MunicipalitySnapshotRow[]) =>
        store.putSnapshot('municipality', date, 61, { fetchedAt: '2026-01-01', rows });
      await put('2000-01-01', [municipality('001001', 'Alfa')]);
      await put('2000-02-01', [municipality('001001', 'Alfa Nuova')]);
      await put('2000-03-01', [municipality('001001', 'Alfa')]);

      const anomalies = new AnomalyCollector();
      const index = await loadIntervalIndex(store, 'municipality', ['2000-02-01', '2000-01-01'], anomalies);
      expect(index.intervals('001001').map((i) => [i.validFrom, i.validTo, i.row.officialName])).toEqual([
        ['2000-01-01', '2000-02-01', 'Alfa'],
        ['2000-02-01', null, 'Alfa Nuova'],
      ]);
      await expect(loadIntervalIndex(store, 'municipality', ['2000-04-01'], anomalies)).rejects.toThrow(
        /no stored municipality snapshot/,
      );
    });
  });
});

describe('code resolver', () => {
  // 2000-01-01: A 001001 (A001), B 001002 (B002). On 2000-02-01 A is renumbered 001001 → 002001
  // and B moves 001002 → 003002 → 004002 (two same-day steps) and is suppressed the same day.
  const world = municipalityIndex([
    ['2000-01-01', [municipality('001001', 'A', 'A001'), municipality('001002', 'B', 'B002')]],
    ['2000-02-01', [municipality('002001', 'A', 'A001')]],
  ]);
  const aliases = [alias('2000-02-01', '001001', '002001'), alias('2000-02-01', '001002', '003002')];
  aliases.push(alias('2000-02-01', '003002', '004002'));
  const resolverOf = async (extra: CodeAlias[] = []) =>
    new CodeResolver({ municipality: await world }, [...aliases, ...extra]);

  it('looks a successor up on the event date and a predecessor on the day before', async () => {
    const resolver = await resolverOf();
    expect(
      resolver.resolve({ level: 'municipality', code: '002001', date: '2000-02-01', side: 'successor' }),
    ).toMatchObject({ intervalKey: '002001@2000-02-01', path: 'direct' });
    expect(
      resolver.resolve({ level: 'municipality', code: '001001', date: '2000-02-01', side: 'predecessor' }),
    ).toMatchObject({ intervalKey: '001001@2000-01-01', path: 'direct' });
  });

  it('follows same-day alias chains towards the side', async () => {
    const resolver = await resolverOf();
    // The suppression of B reports its last same-day code: two steps back to the day before.
    expect(
      resolver.resolve({ level: 'municipality', code: '004002', date: '2000-02-01', side: 'predecessor' }),
    ).toMatchObject({ intervalKey: '001002@2000-01-01', path: 'alias' });
    // A by its old code on the event date.
    expect(
      resolver.resolve({ level: 'municipality', code: '001001', date: '2000-02-01', side: 'successor' }),
    ).toMatchObject({ intervalKey: '002001@2000-02-01', path: 'alias' });
    // Aliases of other dates are not used.
    expect(() =>
      resolver.resolve({ level: 'municipality', code: '004002', date: '2000-01-01', side: 'predecessor' }),
    ).toThrow(ResolutionError);
  });

  it('falls back to the cadastral code of the event row for municipalities', async () => {
    const resolver = await resolverOf();
    const query = { level: 'municipality', code: '009999', date: '2000-02-01', side: 'successor' } as const;
    expect(resolver.resolve({ ...query, cadastralCode: 'A001' })).toMatchObject({
      intervalKey: '002001@2000-02-01',
      path: 'cadastral',
    });
    expect(() => resolver.resolve({ ...query, cadastralCode: null })).toThrow(ResolutionError);
    expect(() => resolver.resolve({ ...query, cadastralCode: 'Z999' })).toThrow(ResolutionError);
  });

  it('never uses the cadastral code for UTS', async () => {
    const provinces = await buildIntervalIndex({
      level: 'province',
      snapshots: [{ date: '2000-01-01', rows: hashed([uts('001', 'Uno')]) }],
      anomalies: new AnomalyCollector(),
    });
    const resolver = new CodeResolver({ province: provinces });
    expect(() =>
      resolver.resolve({
        level: 'province',
        code: '002',
        date: '2000-01-01',
        side: 'successor',
        cadastralCode: 'A001',
      }),
    ).toThrow(ResolutionError);
    expect(() => resolver.resolve({ level: 'region', code: '01', date: '2000-01-01', side: 'successor' })).toThrow(
      RangeError,
    );
  });

  it('rejects an alias step that reaches more than one interval', async () => {
    // 005005 was assigned on 2000-02-01 to both A and B: ambiguous on the day before.
    const resolver = await resolverOf([
      alias('2000-02-01', '001001', '005005'),
      alias('2000-02-01', '001002', '005005'),
    ]);
    let error: unknown;
    try {
      resolver.resolve({ level: 'municipality', code: '005005', date: '2000-02-01', side: 'predecessor' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ResolutionError);
    expect(error).toMatchObject({ reason: 'ambiguous', candidates: ['001001@2000-01-01', '001002@2000-01-01'] });
  });

  it('reports an unresolved code as a blocking anomaly with its context', async () => {
    const resolver = await resolverOf();
    const anomalies = new AnomalyCollector();
    const result = resolver.resolveOrReport(
      { level: 'municipality', code: '003002', date: '2000-02-01', side: 'successor', cadastralCode: null },
      anomalies,
      { source: 'events:pfun-98', row: { code: '003002' } },
    );
    expect(result).toBeNull();
    expect(anomalies.list()).toEqual([
      {
        level: 'blocking',
        code: RESOLVER_ANOMALIES.unresolved,
        message: 'municipality code 003002 (successor of 2000-02-01) not found on 2000-02-01',
        context: {
          source: 'events:pfun-98',
          row: { code: '003002' },
          level: 'municipality',
          code: '003002',
          date: '2000-02-01',
          side: 'successor',
          cadastral_code: null,
          lookup_date: '2000-02-01',
          reason: 'not-found',
          alias_codes: ['004002'],
          candidates: [],
        },
      },
    ]);
  });
});

describe('same-day aliases', () => {
  it('maps every pfun 105 row from its code of the day before to its code of the day', () => {
    const row = (code: string, related: string | null): MunicipalityEventRow => ({
      event: 'AP',
      date: '1927-01-12',
      multipleSuccessors: false,
      code,
      name: 'X',
      foreignName: null,
      cadastralCode: null,
      utsCode: code.slice(0, 3),
      utsAbbreviation: null,
      abroad: false,
      related:
        related === null
          ? null
          : { code: related, name: 'X', foreignName: null, cadastralCode: null, utsCode: null, utsAbbreviation: null },
      regionChanged: false,
    });
    expect(
      municipalityAliases([
        row('010877', '009813'),
        row('010877', '009813'),
        row('001001', '001001'),
        row('002002', null),
      ]),
    ).toEqual([{ level: 'municipality', date: '1927-01-12', from: '010877', to: '009813', source: 'events:pfun-105' }]);
  });

  interface Event {
    event: IstatEventCode;
    date: IsoDate;
    code: string;
    id: number;
    originId: number;
  }

  it('derives the old code of an RN from the last earlier event of the same record, and pairs type changes', () => {
    const events: Event[] = [
      { event: 'PV', date: '1861-03-17', code: '092', id: 59, originId: 59 },
      { event: 'CECS', date: '1974-08-20', code: '092', id: 59, originId: 59 },
      { event: 'ESCT', date: '2016-04-28', code: '092', id: 59, originId: 59 },
      { event: 'CSCT', date: '2016-04-28', code: '292', id: 127, originId: 59 },
      { event: 'RN', date: '2026-01-01', code: '318', id: 127, originId: 59 },
      { event: 'AQES', date: '2026-01-01', code: '318', id: 127, originId: 59 },
      // A record whose first event is an RN has no earlier code.
      { event: 'RN', date: '2026-01-01', code: '777', id: 300, originId: 300 },
    ];
    const graph = buildIdentityGraph<Event>({
      level: 'province',
      sources: [{ listed: { code: '318', name: 'Cagliari', type: 'metropolitan_city', originId: 59 }, events }],
      pointer: (e) => ({ id: e.id, originId: e.originId }),
      record: (e) => ({ id: e.id, code: e.code, name: 'Cagliari', type: null }),
      date: (e) => e.date,
      eventKey: canonicalJson,
      anomalies: new AnomalyCollector(),
    });
    expect(internalAliases(graph, (e) => ({ ...e, recordId: e.id }), 'r5:uts-events')).toEqual([
      { level: 'province', date: '2016-04-28', from: '092', to: '292', source: 'r5:uts-events' },
      { level: 'province', date: '2026-01-01', from: '292', to: '318', source: 'r5:uts-events' },
    ]);
  });
});
