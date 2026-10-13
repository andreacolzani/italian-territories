/**
 * Version builder (§4.2, §6.9) on synthetic intervals: maximal versions, parents as
 * entity ids, pre-1948 abbreviations, bilingual names, undetermined fields, and the I1–I3 properties.
 */
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import {
  buildMunicipalityVersions,
  buildProvinceVersions,
  buildRegionVersions,
  cover,
  EntityTimeline,
  mergeDated,
  municipalityAbbreviations,
  splitRange,
  type IdentifiedEntity,
} from '../../src/build/index.ts';
import { addDays, type IsoDate } from '../../src/dates/index.ts';
import type { Level } from '../../src/model/common.ts';
import type { MunicipalitySnapshotRow, RegionSnapshotRow, UtsSnapshotRow } from '../../src/model/internal.ts';
import { IntervalIndex, type SnapshotInterval } from '../../src/resolve/index.ts';
import { versionPropertyViolations } from '../helpers/versions.ts';

function interval<L extends Level>(
  level: L,
  row: SnapshotInterval<L>['row'],
  validFrom: IsoDate,
  validTo: IsoDate | null,
): SnapshotInterval<L> {
  return { level, code: row.code, validFrom, validTo, row };
}

const region = (code: string, name: string, type: RegionSnapshotRow['type'] = 'region'): RegionSnapshotRow => ({
  code,
  name,
  type,
});

function uts(code: string, overrides: Partial<UtsSnapshotRow> = {}): UtsSnapshotRow {
  return {
    code,
    name: `UTS ${code}`,
    regionCode: '01',
    type: 'province',
    abbreviation: 'AA',
    historicalCode: code,
    ...overrides,
  };
}

function municipality(code: string, overrides: Partial<MunicipalitySnapshotRow> = {}): MunicipalitySnapshotRow {
  return {
    code,
    officialName: `Comune ${code}`,
    italianName: `Comune ${code}`,
    foreignName: null,
    cadastralCode: 'A001',
    utsCode: '001',
    regionCode: '01',
    utsAbbreviation: 'AA',
    historicalUtsCode: '001',
    ...overrides,
  };
}

/** Test entity id `e-<n>`. */
const E = (n: number): string => `e-${n}`;

function entity<L extends Level>(n: number, intervals: SnapshotInterval<L>[]): IdentifiedEntity<L> {
  return { id: E(n), istatOriginId: n * 10, intervals };
}

/** A municipality index of the given intervals. */
function municipalityIndex(intervals: SnapshotInterval<'municipality'>[]): IntervalIndex<'municipality'> {
  const byCode = new Map<string, SnapshotInterval<'municipality'>[]>();
  for (const i of intervals) byCode.set(i.code, [...(byCode.get(i.code) ?? []), i]);
  return new IntervalIndex('municipality', byCode);
}

const regionsTimeline = EntityTimeline.of('region', [
  entity(1, [interval('region', region('01', 'Piemonte'), '1861-03-17', null)]),
]);

describe('timeline helpers', () => {
  it('cover clips pieces to the range and fills gaps', () => {
    const pieces = [
      { validFrom: '2000-01-01', validTo: '2000-02-01', value: 1 },
      { validFrom: '2000-03-01', validTo: null, value: 2 },
    ];
    expect(cover({ validFrom: '2000-01-15', validTo: '2000-04-01' }, pieces, 0)).toEqual([
      { validFrom: '2000-01-15', validTo: '2000-02-01', value: 1 },
      { validFrom: '2000-02-01', validTo: '2000-03-01', value: 0 },
      { validFrom: '2000-03-01', validTo: '2000-04-01', value: 2 },
    ]);
    expect(cover({ validFrom: '1999-01-01', validTo: null }, pieces, 0)).toEqual([
      { validFrom: '1999-01-01', validTo: '2000-01-01', value: 0 },
      { validFrom: '2000-01-01', validTo: '2000-02-01', value: 1 },
      { validFrom: '2000-02-01', validTo: '2000-03-01', value: 0 },
      { validFrom: '2000-03-01', validTo: null, value: 2 },
    ]);
    expect(cover({ validFrom: '2001-01-01', validTo: '2001-02-01' }, [], 'gap')).toEqual([
      { validFrom: '2001-01-01', validTo: '2001-02-01', value: 'gap' },
    ]);
  });

  it('splitRange cuts where any timeline changes; mergeDated joins equal contiguous pieces', () => {
    const range = { validFrom: '2000-01-01', validTo: null };
    expect(
      splitRange(range, [
        [
          { validFrom: '2000-01-01', validTo: '2000-06-01', value: 'a' },
          { validFrom: '2000-06-01', validTo: null, value: 'b' },
        ],
        [
          { validFrom: '2000-01-01', validTo: '2000-03-01', value: 1 },
          { validFrom: '2000-03-01', validTo: null, value: 2 },
        ],
      ]),
    ).toEqual([
      { validFrom: '2000-01-01', validTo: '2000-03-01' },
      { validFrom: '2000-03-01', validTo: '2000-06-01' },
      { validFrom: '2000-06-01', validTo: null },
    ]);
    expect(
      mergeDated(
        [
          { validFrom: '2000-01-01', validTo: '2000-02-01', value: 'x' },
          { validFrom: '2000-02-01', validTo: '2000-03-01', value: 'x' },
          { validFrom: '2000-04-01', validTo: null, value: 'x' },
        ],
        (v) => v,
      ),
    ).toEqual([
      { validFrom: '2000-01-01', validTo: '2000-03-01', value: 'x' },
      { validFrom: '2000-04-01', validTo: null, value: 'x' },
    ]);
  });

  it('municipalityAbbreviations sweeps the distinct values per UTS, leaving out times without any', () => {
    const timeline = municipalityAbbreviations([
      interval('municipality', municipality('001001'), '1900-01-01', '1910-01-01'),
      interval('municipality', municipality('001002'), '1905-01-01', '1920-01-01'),
      interval('municipality', municipality('001003', { utsAbbreviation: 'BB' }), '1915-01-01', '1916-01-01'),
      interval('municipality', municipality('001004', { utsAbbreviation: null }), '1930-01-01', null),
      interval('municipality', municipality('001005'), '1940-01-01', null),
      interval('municipality', municipality('002001', { utsCode: '002', utsAbbreviation: 'CC' }), '1900-01-01', null),
    ]);
    expect(timeline.get('001')).toEqual([
      { validFrom: '1900-01-01', validTo: '1915-01-01', value: ['AA'] },
      { validFrom: '1915-01-01', validTo: '1916-01-01', value: ['AA', 'BB'] },
      { validFrom: '1916-01-01', validTo: '1920-01-01', value: ['AA'] },
      { validFrom: '1940-01-01', validTo: null, value: ['AA'] },
    ]);
    expect(timeline.get('002')).toEqual([{ validFrom: '1900-01-01', validTo: null, value: ['CC'] }]);
  });
});

describe('bilingual names of regions and UTS (§4.2, golden-23)', () => {
  it('a denomination with "/" missing from the table has no names and is blocking, with the suggestion', () => {
    const anomalies = new AnomalyCollector();
    const [entityWithUnknown] = buildRegionVersions({
      entities: [entity(1, [interval('region', region('99', 'Nuova-Alta/Neue'), '2000-01-01', null)])],
      anomalies,
    });
    expect(entityWithUnknown?.versions[0]).toMatchObject({
      officialName: 'Nuova-Alta/Neue',
      italianName: null,
      foreignName: null,
    });
    expect(anomalies.list().map((a) => [a.level, a.code, a.context.suggested])).toEqual([
      ['blocking', 'bilingual-name-unknown', { italianName: 'Nuova-Alta', foreignName: 'Nuova-Neue' }],
    ]);
    expect(anomalies.list()[0]?.message).toContain('"Nuova-Alta" / "Nuova-Neue"');
  });

  it('takes the names of a known denomination from the table, at every level', () => {
    const anomalies = new AnomalyCollector();
    const [trentino] = buildRegionVersions({
      entities: [entity(1, [interval('region', region('04', 'Trentino-Alto Adige/Südtirol'), '1948-01-01', null)])],
      anomalies,
    });
    expect(trentino?.versions[0]).toMatchObject({
      italianName: 'Trentino-Alto Adige',
      foreignName: 'Trentino-Südtirol',
    });
    const [aosta] = buildProvinceVersions({
      entities: [
        entity(2, [interval('province', uts('007', { name: "Valle d'Aosta/Vallée d'Aoste" }), '2003-07-06', null)]),
      ],
      regions: regionsTimeline,
      municipalities: municipalityIndex([]),
      anomalies,
    });
    expect(aosta?.versions[0]).toMatchObject({ italianName: "Valle d'Aosta", foreignName: "Vallée d'Aoste" });
    expect(anomalies.list()).toEqual([]);
  });
});

describe('region versions', () => {
  it('merge contiguous intervals with equal published fields; a type change splits', () => {
    const anomalies = new AnomalyCollector();
    const [piemonte] = buildRegionVersions({
      entities: [
        entity(1, [
          interval('region', region('01', 'Piemonte', 'compartment'), '1861-03-17', '1900-01-01'),
          interval('region', region('01', 'Piemonte', 'compartment'), '1900-01-01', '1948-01-01'),
          interval('region', region('01', 'Piemonte'), '1948-01-01', null),
        ]),
      ],
      anomalies,
    });
    expect(piemonte?.versions.map((v) => [v.validFrom, v.validTo, v.type])).toEqual([
      ['1861-03-17', '1948-01-01', 'compartment'],
      ['1948-01-01', null, 'region'],
    ]);
    expect(piemonte).toMatchObject({ level: 'region', id: E(1), istatOriginId: 10 });
    expect(anomalies.list()).toEqual([]);
  });
});

describe('UTS versions', () => {
  it('collapse changes of the historical code, which is kept as its own timeline', () => {
    const anomalies = new AnomalyCollector();
    const [milano] = buildProvinceVersions({
      entities: [
        entity(5, [
          interval('province', uts('015', { historicalCode: '015' }), '2000-01-01', '2010-01-01'),
          interval('province', uts('015', { historicalCode: '115' }), '2010-01-01', null),
        ]),
      ],
      regions: regionsTimeline,
      municipalities: municipalityIndex([]),
      anomalies,
    });
    expect(milano?.versions).toEqual([
      {
        validFrom: '2000-01-01',
        validTo: null,
        istatCode: '015',
        officialName: 'UTS 015',
        italianName: 'UTS 015',
        foreignName: null,
        type: 'province',
        abbreviation: 'AA',
        regionId: E(1),
      },
    ]);
    expect(milano?.historicalCodes).toEqual([
      { validFrom: '2000-01-01', validTo: '2010-01-01', value: '015' },
      { validFrom: '2010-01-01', validTo: null, value: '115' },
    ]);
    expect(anomalies.list()).toEqual([]);
  });

  it('a change of the region entity behind the same region code splits; a region rename does not', () => {
    const regions = EntityTimeline.of('region', [
      entity(1, [
        interval('region', region('08', 'Emilia'), '1900-01-01', '1950-01-01'),
        interval('region', region('08', 'Emilia-Romagna'), '1950-01-01', '1960-01-01'),
      ]),
      entity(2, [interval('region', region('08', 'Nuova'), '1960-01-01', null)]),
    ]);
    const [bologna] = buildProvinceVersions({
      entities: [entity(7, [interval('province', uts('037', { regionCode: '08' }), '1948-01-01', null)])],
      regions,
      municipalities: municipalityIndex([]),
      anomalies: new AnomalyCollector(),
    });
    expect(bologna?.versions.map((v) => [v.validFrom, v.validTo, v.regionId])).toEqual([
      ['1948-01-01', '1960-01-01', E(1)],
      ['1960-01-01', null, E(2)],
    ]);
  });

  it('derive pre-1948 abbreviations from their municipalities; a new value splits the version', () => {
    const anomalies = new AnomalyCollector();
    const [torino] = buildProvinceVersions({
      entities: [
        entity(1, [
          interval('province', uts('001', { abbreviation: null }), '1861-03-17', '1948-01-01'),
          interval('province', uts('001', { abbreviation: 'TO' }), '1948-01-01', null),
        ]),
      ],
      regions: regionsTimeline,
      municipalities: municipalityIndex([
        interval('municipality', municipality('001001', { utsAbbreviation: 'TO' }), '1861-03-17', '1920-01-01'),
        interval('municipality', municipality('001001', { utsAbbreviation: 'TX' }), '1920-01-01', null),
        interval('municipality', municipality('001002', { utsAbbreviation: 'TO' }), '1861-03-17', '1920-01-01'),
        interval('municipality', municipality('001002', { utsAbbreviation: 'TX' }), '1920-01-01', null),
      ]),
      anomalies,
    });
    expect(torino?.versions.map((v) => [v.validFrom, v.validTo, v.abbreviation])).toEqual([
      ['1861-03-17', '1920-01-01', 'TO'],
      ['1920-01-01', '1948-01-01', 'TX'],
      ['1948-01-01', null, 'TO'],
    ]);
    expect(anomalies.list()).toEqual([]);
  });

  it('keep non-conforming and missing post-1948 abbreviations for the overrides and I8, without anomalies', () => {
    const anomalies = new AnomalyCollector();
    const built = buildProvinceVersions({
      entities: [
        entity(1, [interval('province', uts('801', { abbreviation: null }), '1920-01-01', '1924-01-01')]),
        entity(2, [interval('province', uts('090', { abbreviation: null }), '1948-01-01', null)]),
      ],
      regions: regionsTimeline,
      municipalities: municipalityIndex([
        interval(
          'municipality',
          municipality('801001', { utsCode: '801', utsAbbreviation: 'Venezia Giulia' }),
          '1920-01-01',
          '1924-01-01',
        ),
      ]),
      anomalies,
    });
    expect(built.map((e) => e.versions.map((v) => v.abbreviation))).toEqual([['Venezia Giulia'], [null]]);
    expect(anomalies.list()).toEqual([]);
  });

  it('a pre-1948 abbreviation not unanimous or missing is null and blocking, one anomaly per version and cause', () => {
    const anomalies = new AnomalyCollector();
    const [genova] = buildProvinceVersions({
      entities: [
        entity(3, [
          interval('province', uts('010', { abbreviation: null }), '1900-01-01', '1910-01-01'),
          interval('province', uts('010', { abbreviation: null, name: 'Genova' }), '1910-01-01', '1930-01-01'),
        ]),
      ],
      regions: regionsTimeline,
      municipalities: municipalityIndex([
        interval(
          'municipality',
          municipality('010001', { utsCode: '010', utsAbbreviation: 'GE' }),
          '1900-01-01',
          '1920-01-01',
        ),
        interval(
          'municipality',
          municipality('010002', { utsCode: '010', utsAbbreviation: 'SV' }),
          '1900-01-01',
          '1920-01-01',
        ),
      ]),
      anomalies,
    });
    expect(genova?.versions.map((v) => [v.validFrom, v.validTo, v.officialName, v.abbreviation])).toEqual([
      ['1900-01-01', '1910-01-01', 'UTS 010', null],
      ['1910-01-01', '1930-01-01', 'Genova', null],
    ]);
    expect(anomalies.list().map((a) => [a.level, a.code, a.context.validFrom, a.context.values])).toEqual([
      ['blocking', 'abbreviation-underived', '1900-01-01', ['GE', 'SV']],
      ['blocking', 'abbreviation-underived', '1910-01-01', ['GE', 'SV']],
      ['blocking', 'abbreviation-underived', '1910-01-01', []],
    ]);
  });
});

describe('municipality versions', () => {
  const provinces = EntityTimeline.of('province', [
    entity(10, [
      interval('province', uts('092', { name: 'Cagliari' }), '1947-01-01', '1974-08-20'),
      interval('province', uts('092', { name: 'Cagliari', abbreviation: 'CA' }), '1974-08-20', '2016-04-28'),
    ]),
    entity(11, [
      interval('province', uts('095'), '1974-08-20', '2026-01-01'),
      interval('province', uts('115'), '2026-01-01', null),
    ]),
  ]);
  const regions = EntityTimeline.of('region', [
    entity(20, [
      interval('region', region('20', 'Sardegna', 'compartment'), '1947-01-01', '1948-01-01'),
      interval('region', region('20', 'Sardegna'), '1948-01-01', null),
    ]),
  ]);
  const row = (code: string, utsCode: string, name: string, cadastralCode: string) =>
    municipality(code, { utsCode, officialName: name, italianName: name, cadastralCode, regionCode: '20' });

  it('Siamanna (§4.4): only published changes split; parents are entity ids', () => {
    const anomalies = new AnomalyCollector();
    const [siamanna] = buildMunicipalityVersions({
      entities: [
        entity(1, [
          interval('municipality', row('092128', '092', 'Siamanna-Siapiccia', 'I719'), '1947-11-28', '1948-01-01'),
          interval(
            'municipality',
            { ...row('092128', '092', 'Siamanna-Siapiccia', 'I719'), historicalUtsCode: '992' },
            '1948-01-01',
            '1974-08-20',
          ),
          interval('municipality', row('095057', '095', 'Siamanna-Siapiccia', 'I719'), '1974-08-20', '1974-09-13'),
          interval('municipality', row('095057', '095', 'Siamanna', 'I718'), '1974-09-13', '2026-01-01'),
          interval('municipality', row('115064', '115', 'Siamanna', 'I718'), '2026-01-01', null),
        ]),
      ],
      provinces,
      regions,
      anomalies,
    });
    expect(
      siamanna?.versions.map((v) => [v.validFrom, v.validTo, v.istatCode, v.cadastralCode, v.provinceId, v.regionId]),
    ).toEqual([
      ['1947-11-28', '1974-08-20', '092128', 'I719', E(10), E(20)],
      ['1974-08-20', '1974-09-13', '095057', 'I719', E(11), E(20)],
      ['1974-09-13', '2026-01-01', '095057', 'I718', E(11), E(20)],
      ['2026-01-01', null, '115064', 'I718', E(11), E(20)],
    ]);
    expect(anomalies.list()).toEqual([]);
  });

  it('keeps a gap between two lives of the same entity (reconstitution)', () => {
    const [sassofeltrio] = buildMunicipalityVersions({
      entities: [
        entity(4450, [
          interval('municipality', row('041060', '092', 'Sassofeltrio', 'I460'), '1950-01-01', '1960-01-01'),
          interval('municipality', row('041060', '092', 'Sassofeltrio', 'I460'), '1970-01-01', null),
        ]),
      ],
      provinces,
      regions,
      anomalies: new AnomalyCollector(),
    });
    expect(sassofeltrio?.versions.map((v) => [v.validFrom, v.validTo])).toEqual([
      ['1950-01-01', '1960-01-01'],
      ['1970-01-01', '2016-04-28'],
      ['2016-04-28', null],
    ]);
  });

  it('a parent code identifying no entity is null and blocking, one anomaly per version', () => {
    const anomalies = new AnomalyCollector();
    const [orphan] = buildMunicipalityVersions({
      entities: [
        entity(9, [
          interval('municipality', row('092001', '092', 'Orfano', 'A001'), '2010-01-01', '2020-01-01'),
          interval('municipality', row('092001', '092', 'Orfano', 'A002'), '2020-01-01', null),
        ]),
      ],
      provinces,
      regions,
      anomalies,
    });
    expect(orphan?.versions.map((v) => [v.validFrom, v.validTo, v.cadastralCode, v.provinceId])).toEqual([
      ['2010-01-01', '2016-04-28', 'A001', E(10)],
      ['2016-04-28', '2020-01-01', 'A001', null],
      ['2020-01-01', null, 'A002', null],
    ]);
    expect(
      anomalies.list().map((a) => [a.level, a.code, a.context.validFrom, a.context.field, a.context.parentCode]),
    ).toEqual([
      ['blocking', 'version-parent-unresolved', '2016-04-28', 'provinceId', '092'],
      ['blocking', 'version-parent-unresolved', '2020-01-01', 'provinceId', '092'],
    ]);
  });
});

describe('I1–I3 on built versions', () => {
  /** A deterministic pseudo-random history of one municipality over contiguous and separate intervals. */
  function randomHistory(seed: number): SnapshotInterval<'municipality'>[] {
    let state = seed;
    const next = (n: number): number => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state % n;
    };
    const intervals: SnapshotInterval<'municipality'>[] = [];
    let date = '1900-01-01';
    for (let i = 0; i < 40; i++) {
      const length = 1 + next(400);
      const end = addDays(date, length);
      const r = municipality('001001', {
        officialName: `N${next(3)}`,
        cadastralCode: next(4) === 0 ? null : `A00${next(2)}`,
        historicalUtsCode: `00${next(3)}`,
        utsCode: next(5) === 0 ? '002' : '001',
      });
      intervals.push(interval('municipality', r, date, i === 39 ? null : end));
      date = next(6) === 0 ? addDays(end, 1 + next(30)) : end;
    }
    return intervals;
  }

  it('versions are sorted, non-overlapping, maximal, and gaps only where the entity does not exist', () => {
    const provinces = EntityTimeline.of('province', [
      entity(1, [interval('province', uts('001'), '1800-01-01', null)]),
      entity(2, [interval('province', uts('002'), '1800-01-01', null)]),
    ]);
    const regions = EntityTimeline.of('region', [
      entity(1, [interval('region', region('01', 'R'), '1800-01-01', null)]),
    ]);
    for (let seed = 1; seed <= 50; seed++) {
      const entities = [entity(seed, randomHistory(seed))];
      const built = buildMunicipalityVersions({ entities, provinces, regions, anomalies: new AnomalyCollector() });
      expect(versionPropertyViolations(built, () => entities[0]?.intervals ?? [])).toEqual([]);
      expect(built[0]?.versions.length).toBeLessThanOrEqual(40);
    }
  });

  it('the property check detects overlapping, non-maximal and unexplained gaps', () => {
    const v = (validFrom: IsoDate, validTo: IsoDate | null, officialName = 'A') => ({
      validFrom,
      validTo,
      istatCode: '001001',
      officialName,
      italianName: officialName,
      foreignName: null,
      cadastralCode: null,
      provinceId: E(1),
      regionId: E(1),
    });
    const draft = (versions: ReturnType<typeof v>[]) => [
      { level: 'municipality' as const, id: E(1), istatOriginId: null, versions },
    ];
    const always = () => [{ validFrom: '1900-01-01', validTo: null }];
    expect(
      versionPropertyViolations(draft([v('1900-01-01', '1910-01-01'), v('1905-01-01', null, 'B')]), always),
    ).toHaveLength(1);
    expect(
      versionPropertyViolations(draft([v('1900-01-01', '1910-01-01'), v('1910-01-01', null)]), always),
    ).toHaveLength(1);
    expect(
      versionPropertyViolations(draft([v('1900-01-01', '1910-01-01'), v('1920-01-01', null, 'B')]), always),
    ).toHaveLength(1);
  });
});
