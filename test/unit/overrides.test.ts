import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import type { ProvinceEntity, ProvinceVersion } from '../../src/model/internal.ts';
import {
  applyOverrides,
  loadOverrides,
  OverrideFileError,
  parseOverrideFile,
  type Override,
} from '../../src/overrides/index.ts';
import { withTempDir } from '../helpers/http.ts';

/** A file entry as written in `overrides/`. */
function entry(overrides: Record<string, unknown> = {}, target: Record<string, unknown> = {}) {
  return {
    key: 'uts-801-abbreviation',
    target: { level: 'province', istat_code: '801', date_from: '1920-01-01', date_to: '1923-12-31', ...target },
    field: 'abbreviation',
    value: 'VG',
    reason: 'ISTAT reports the full name.',
    source: 'ANPR',
    source_url: 'https://www.anagrafenazionale.interno.it/wp-content/uploads/ANPR_archivio_comuni.csv',
    ...overrides,
  };
}

function override(istatCode: string, validFrom: IsoDate, validTo: IsoDate | null, value: string, key = 'k'): Override {
  return {
    key,
    file: 'abbreviations.json',
    level: 'province',
    istatCode,
    target: { validFrom, validTo },
    field: 'abbreviation',
    value,
    reason: 'test',
    source: 'test',
    sourceUrl: null,
  };
}

let nextVersionId = 1;
function version(istatCode: string, validFrom: IsoDate, validTo: IsoDate | null, abbreviation: string | null) {
  return {
    id: nextVersionId++,
    validFrom,
    validTo,
    istatCode,
    officialName: `UTS ${istatCode}`,
    italianName: `UTS ${istatCode}`,
    foreignName: null,
    type: 'province',
    abbreviation,
    regionId: 1,
  } satisfies ProvinceVersion;
}

function province(id: number, versions: ProvinceVersion[]): ProvinceEntity {
  return { level: 'province', id, istatOriginId: null, versions, historicalCodes: [] };
}

function apply(overrides: Override[], provinces: ProvinceEntity[]) {
  const anomalies = new AnomalyCollector();
  return { ...applyOverrides({ overrides, provinces, anomalies }), anomalies: anomalies.list() };
}

describe('override loader (§6.10)', () => {
  it('converts entries to the internal model with a half-open target', () => {
    expect(parseOverrideFile('abbreviations.json', JSON.stringify([entry()]))).toEqual([
      {
        key: 'uts-801-abbreviation',
        file: 'abbreviations.json',
        level: 'province',
        istatCode: '801',
        target: { validFrom: '1920-01-01', validTo: '1924-01-01' },
        field: 'abbreviation',
        value: 'VG',
        reason: 'ISTAT reports the full name.',
        source: 'ANPR',
        sourceUrl: 'https://www.anagrafenazionale.interno.it/wp-content/uploads/ANPR_archivio_comuni.csv',
      },
    ]);
    const [open] = parseOverrideFile('a.json', JSON.stringify([entry({ source_url: null }, { date_to: null })]));
    expect([open?.target, open?.sourceUrl]).toEqual([{ validFrom: '1920-01-01', validTo: null }, null]);
  });

  it.each([
    ['a value that is not two uppercase letters', entry({ value: 'Venezia Giulia' })],
    ['a field outside the closed set', entry({ field: 'official_name' })],
    ['another level', entry({}, { level: 'municipality', istat_code: '801256' })],
    ['a malformed code', entry({}, { istat_code: '80' })],
    ['an invalid date', entry({}, { date_from: '1920-02-30' })],
    ['date_to before date_from', entry({}, { date_from: '1924-01-01' })],
    ['a key that is not kebab-case', entry({ key: 'UTS 801' })],
    ['an empty reason', entry({ reason: '' })],
    ['an unknown key', entry({ note: 'x' })],
    ['a missing source', { ...entry(), source: undefined }],
  ])('rejects %s', (_, invalid) => {
    expect(() => parseOverrideFile('abbreviations.json', JSON.stringify([invalid]))).toThrow(OverrideFileError);
  });

  it('rejects invalid JSON and a file that is not an array', () => {
    expect(() => parseOverrideFile('a.json', '[{')).toThrow(/invalid JSON.*a\.json/);
    expect(() => parseOverrideFile('a.json', JSON.stringify(entry()))).toThrow(OverrideFileError);
  });

  it('loads every JSON file of the directory sorted by key, ignoring other files', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'b.json'), JSON.stringify([entry({ key: 'a-first' }, { istat_code: '802' })]));
      await writeFile(join(dir, 'a.json'), JSON.stringify([entry({ key: 'z-last' })]));
      await writeFile(join(dir, '.gitkeep'), '');
      await writeFile(join(dir, 'notes.txt'), 'not an override');
      const loaded = await loadOverrides(dir);
      expect(loaded.map((o) => [o.key, o.file])).toEqual([
        ['a-first', 'b.json'],
        ['z-last', 'a.json'],
      ]);
    });
  });

  it('loads nothing from a missing directory', async () => {
    await withTempDir(async (dir) => {
      expect(await loadOverrides(join(dir, 'missing'))).toEqual([]);
    });
  });

  it('rejects a key used twice, across files', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.json'), JSON.stringify([entry()]));
      await writeFile(join(dir, 'b.json'), JSON.stringify([entry({}, { istat_code: '802' })]));
      await expect(loadOverrides(dir)).rejects.toThrow(/key uts-801-abbreviation already used in a\.json \(b\.json\)/);
    });
  });

  it('rejects two overrides of the same field and code on overlapping periods', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'a.json'),
        JSON.stringify([
          entry({ key: 'early' }, { date_from: '1920-01-01', date_to: '1921-12-31' }),
          entry({ key: 'late' }, { date_from: '1921-12-31', date_to: null }),
        ]),
      );
      await expect(loadOverrides(dir)).rejects.toThrow(/early and late change abbreviation of province 801/);
    });
  });

  it('accepts adjacent periods of the same code', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'a.json'),
        JSON.stringify([
          entry({ key: 'early' }, { date_from: '1920-01-01', date_to: '1921-12-31' }),
          entry({ key: 'late', value: 'VX' }, { date_from: '1922-01-01', date_to: null }),
        ]),
      );
      expect((await loadOverrides(dir)).map((o) => o.key)).toEqual(['early', 'late']);
    });
  });
});

describe('override applier (§6.10)', () => {
  it('replaces the field of every version of the code lying inside the target, without splitting', () => {
    const before = version('801', '1921-01-05', '1923-02-08', 'Venezia Giulia');
    const other = province(2, [version('802', '1920-10-16', null, 'TN')]);
    const { provinces, applied, anomalies } = apply(
      [override('801', '1920-01-01', '1924-01-01', 'VG')],
      [province(1, [before]), other],
    );
    expect(provinces[0]?.versions).toEqual([{ ...before, abbreviation: 'VG' }]);
    expect(provinces[1]).toBe(other);
    expect(applied).toEqual([
      {
        key: 'k',
        entityId: 1,
        validFrom: '1921-01-05',
        validTo: '1923-02-08',
        field: 'abbreviation',
        before: 'Venezia Giulia',
        after: 'VG',
      },
    ]);
    expect(anomalies).toEqual([]);
  });

  it('supplies a missing abbreviation and covers a target equal to the version', () => {
    const { provinces, anomalies } = apply(
      [override('120', '2026-01-01', null, 'XY')],
      [province(1, [version('120', '2026-01-01', null, null)])],
    );
    expect(provinces[0]?.versions[0]?.abbreviation).toBe('XY');
    expect(anomalies).toEqual([]);
  });

  it('applies to every entity that used the code inside the target (code reuse) and to nothing outside', () => {
    const { provinces } = apply(
      [override('090', '1900-01-01', '2000-01-01', 'QQ')],
      [
        province(1, [version('090', '1927-01-12', '1950-01-01', 'AA')]),
        province(2, [version('090', '1960-01-01', '1970-01-01', 'BB'), version('091', '1970-01-01', null, 'BB')]),
      ],
    );
    expect(provinces.map((e) => e.versions.map((v) => [v.istatCode, v.abbreviation]))).toEqual([
      [['090', 'QQ']],
      [
        ['090', 'QQ'],
        ['091', 'BB'],
      ],
    ]);
  });

  it('reports a version only partly inside the target as blocking and leaves it unchanged', () => {
    const partial = version('801', '1921-01-05', null, 'Venezia Giulia');
    const inside = version('801', '1919-01-01', '1920-01-01', 'Venezia Giulia');
    const { provinces, applied, anomalies } = apply(
      [override('801', '1919-01-01', '1924-01-01', 'VG')],
      [province(1, [inside]), province(2, [partial])],
    );
    expect(provinces[1]?.versions).toEqual([partial]);
    expect(provinces[0]?.versions[0]?.abbreviation).toBe('VG');
    expect(applied.map((a) => a.entityId)).toEqual([1]);
    expect(anomalies.map((a) => [a.level, a.code, a.context.entityId, a.context.validFrom])).toEqual([
      ['blocking', 'override-partial-overlap', 2, '1921-01-05'],
    ]);
  });

  it('reports an override matching nothing as obsolete', () => {
    const { provinces, applied, anomalies } = apply(
      [override('801', '1920-01-01', '1924-01-01', 'VG')],
      [province(1, [version('801', '1924-01-01', null, 'Venezia Giulia')])],
    );
    expect(provinces[0]?.versions[0]?.abbreviation).toBe('Venezia Giulia');
    expect(applied).toEqual([]);
    expect(anomalies.map((a) => [a.level, a.code, a.context.reason, a.context.key])).toEqual([
      ['warning', 'override-obsolete', 'no-match', 'k'],
    ]);
  });

  it('reports an override whose targets already have the value as obsolete (ISTAT fixed it)', () => {
    const { applied, anomalies } = apply(
      [override('801', '1920-01-01', '1924-01-01', 'VG')],
      [province(1, [version('801', '1921-01-05', '1923-02-08', 'VG')])],
    );
    expect(applied).toEqual([]);
    expect(anomalies.map((a) => [a.level, a.code, a.context.reason])).toEqual([
      ['warning', 'override-obsolete', 'already-applied'],
    ]);
  });

  it('is still needed while one targeted version lacks the value', () => {
    const { applied, anomalies } = apply(
      [override('801', '1920-01-01', '1924-01-01', 'VG')],
      [
        province(1, [
          version('801', '1921-01-05', '1922-01-01', 'VG'),
          version('801', '1922-01-01', '1923-02-08', 'V'),
        ]),
      ],
    );
    expect(applied.map((a) => a.validFrom)).toEqual(['1922-01-01']);
    expect(anomalies).toEqual([]);
  });

  it('is not obsolete when its only match overlaps partially (the blocking anomaly suffices)', () => {
    const { anomalies } = apply(
      [override('801', '1920-01-01', '1924-01-01', 'VG')],
      [province(1, [version('801', '1923-01-01', '1925-01-01', 'VG')])],
    );
    expect(anomalies.map((a) => a.code)).toEqual(['override-partial-overlap']);
  });
});
