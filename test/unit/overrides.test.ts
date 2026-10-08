import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { canonicalJson } from '../../src/http/index.ts';
import type { Level } from '../../src/model/common.ts';
import type { SnapshotRowByLevel, UtsSnapshotRow } from '../../src/model/internal.ts';
import { loadOverrides, OverrideFileError, parseOverrideFile, type Override } from '../../src/overrides/index.ts';
import { buildIntervalIndex, type IntervalIndex } from '../../src/resolve/index.ts';
import { withTempDir } from '../helpers/http.ts';
import { buildWorld, entityAt } from '../helpers/versions.ts';

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

describe('override applier (§6.10): day by day, before the versions are merged', () => {
  const D1 = '1950-01-01';
  const D2 = '1960-01-01';
  const D3 = '1970-01-01';

  /** UTS rows of each date (post-1948: the abbreviation is the UTS row's own). */
  async function build(provinces: Record<IsoDate, UtsSnapshotRow[]>, overrides: Override[]) {
    const dates = Object.keys(provinces);
    const regions = Object.fromEntries(
      dates.map((d) => [d, [{ code: '01', name: 'Regione', type: 'region' as const }]]),
    );
    const built = await buildWorld({
      region: { index: await index('region', regions) },
      province: { index: await index('province', provinces) },
      overrides,
    });
    const versions = (code: string, date: IsoDate) =>
      entityAt(built.province, code, date).versions.map((v) => [v.validFrom, v.validTo, v.abbreviation]);
    return { built, versions, anomalies: built.anomalies.list(), applied: built.appliedOverrides };
  }

  it('replaces the value on the days of the target with the target code (Venezia Giulia → VG)', async () => {
    const { versions, applied, anomalies } = await build(
      { [D1]: [uts('801', 'Venezia Giulia'), uts('802', 'TN')], [D2]: [uts('802', 'TN')] },
      [override('801', '1940-01-01', '1965-01-01', 'VG')],
    );
    expect(versions('801', D1)).toEqual([[D1, D2, 'VG']]);
    expect(versions('802', D1)).toEqual([[D1, null, 'TN']]);
    expect(applied).toEqual([
      {
        key: 'k',
        entityId: expect.any(String) as string,
        validFrom: D1,
        validTo: D2,
        field: 'abbreviation',
        before: 'Venezia Giulia',
        after: 'VG',
      },
    ]);
    expect(anomalies).toEqual([]);
  });

  it('removes a version boundary: the overridden days merge with the next ones (Littoria LT, 1934)', async () => {
    const { versions, applied, anomalies } = await build(
      { [D1]: [uts('059', null)], [D2]: [uts('059', 'LT')], [D3]: [uts('059', 'LT')] },
      [override('059', D1, D2, 'LT')],
    );
    expect(versions('059', D1)).toEqual([[D1, null, 'LT']]);
    expect(applied.map((a) => [a.validFrom, a.validTo, a.before, a.after])).toEqual([[D1, D2, null, 'LT']]);
    expect(anomalies).toEqual([]);
  });

  it('never creates a version boundary (blocking)', async () => {
    const { anomalies } = await build({ [D1]: [uts('059', 'AA')], [D2]: [uts('059', 'AA')] }, [
      override('059', D1, '1955-01-01', 'BB'),
    ]);
    expect(anomalies.map((a) => [a.level, a.code, a.context.date, a.context.keys])).toEqual([
      ['blocking', 'override-creates-boundary', '1955-01-01', ['k']],
    ]);
  });

  it('applies to every entity with the code in the target (code reuse), and to nothing outside', async () => {
    const { built, applied } = await build(
      { [D1]: [uts('090', 'AA')], [D2]: [uts('091', 'BB')], [D3]: [uts('090', 'CC')] },
      [override('090', '1900-01-01', null, 'QQ')],
    );
    expect(built.province.map((e) => e.versions.map((v) => [v.istatCode, v.abbreviation]))).toEqual([
      [['090', 'QQ']],
      [['091', 'BB']],
      [['090', 'QQ']],
    ]);
    expect(applied.map((a) => [a.validFrom, a.before])).toEqual([
      [D1, 'AA'],
      [D3, 'CC'],
    ]);
  });

  it('reports an override matching no day as obsolete', async () => {
    const { applied, anomalies } = await build({ [D1]: [uts('801', 'Venezia Giulia')] }, [
      override('801', '1920-01-01', '1924-01-01', 'VG'),
    ]);
    expect(applied).toEqual([]);
    expect(anomalies.map((a) => [a.level, a.code, a.context.reason, a.context.key])).toEqual([
      ['warning', 'override-obsolete', 'no-match', 'k'],
    ]);
  });

  it('reports an override whose days already have the value as obsolete (ISTAT fixed it)', async () => {
    const { anomalies } = await build({ [D1]: [uts('801', 'VG')] }, [override('801', D1, null, 'VG')]);
    expect(anomalies.map((a) => [a.level, a.code, a.context.reason])).toEqual([
      ['warning', 'override-obsolete', 'already-applied'],
    ]);
  });

  it('is still needed while one targeted day lacks the value', async () => {
    const { applied, anomalies } = await build({ [D1]: [uts('801', 'VG')], [D2]: [uts('801', 'V')] }, [
      override('801', D1, null, 'VG'),
    ]);
    expect(applied.map((a) => [a.validFrom, a.before])).toEqual([
      [D1, 'VG'],
      [D2, 'V'],
    ]);
    expect(anomalies).toEqual([]);
  });
});

function uts(code: string, abbreviation: string | null): UtsSnapshotRow {
  return { code, name: `UTS ${code}`, regionCode: '01', type: 'province', abbreviation, historicalCode: code };
}

async function index<L extends Level>(
  level: L,
  snapshots: Record<IsoDate, SnapshotRowByLevel[L][]>,
): Promise<IntervalIndex<L>> {
  return buildIntervalIndex({
    level,
    snapshots: Object.entries(snapshots).map(([date, rows]) => ({
      date,
      rows: rows.map((r) => ({ hash: canonicalJson(r), row: r })),
    })),
    anomalies: new AnomalyCollector(),
  });
}
