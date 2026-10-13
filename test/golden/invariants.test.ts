/**
 * Invariants on real SITUAS fixtures (§8.1): the full worlds of two consecutive days pass
 * every invariant that can run; golden-17 (I13) and I12 on the whole 2026-10-01 world; golden-4 and
 * golden-7 for I6, I7, I8 and I12 with the real `COD_PROV_STORICO` and the Venezia Giulia override.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { deriveFields } from '../../src/derive/index.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import {
  checkActive8xxCodes,
  checkI4,
  checkI5,
  checkI6,
  checkI7,
  checkI8,
  checkI12,
  checkInvariants,
  existenceOf,
  historicalCodesOf,
  INVARIANT_IDS,
  type InvariantEntities,
  type InvariantWorld,
  type SnapshotSet,
} from '../../src/invariants/index.ts';
import { LEVELS, type Level } from '../../src/model/common.ts';
import { loadOverrides } from '../../src/overrides/index.ts';
import { withSources } from '../helpers/sources.ts';
import { municipalityGraph, utsGraph } from '../helpers/identity.ts';
import { fixtureWorld, type BuiltVariations } from '../helpers/variations.ts';
import { entityAt } from '../helpers/versions.ts';

const OVERRIDES_DIR = fileURLToPath(new URL('../../overrides/', import.meta.url));
const PROVINCE_SNAPSHOTS = new URL('../fixtures/situas-public/snapshots/provinces/', import.meta.url);

/**
 * The codes of the UTS of every date with a province fixture: a world of a few dates does not know
 * the UTS created later (the prefix of an 8xx municipality code may be one of them, §3.5 item 17),
 * which the whole dataset does (I7).
 */
let known: Promise<Set<string>> | undefined;

function knownUtsCodes(): NonNullable<typeof known> {
  known ??= withSources(async ({ situasPublic }) => {
    const dates = readdirSync(PROVINCE_SNAPSHOTS)
      .map((file) => /_(\d{4}-\d{2}-\d{2})\.json$/.exec(file)?.[1])
      .filter((date): date is IsoDate => date !== undefined);
    const codes = new Set<string>();
    for (const date of dates) {
      for (const row of (await situasPublic.fetchSnapshot('province', date)).data.snapshot.rows) {
        codes.add(row.code);
        codes.add(row.historicalCode);
      }
    }
    return codes;
  });
  return known;
}

/** The snapshots of `dates` as the sets I12 compares with, the rows of each level reduced by `keep`. */
async function snapshotSets(
  dates: readonly IsoDate[],
  keep: Partial<Record<Level, readonly string[]>> = {},
): Promise<SnapshotSet[]> {
  return withSources(async ({ situasPublic }) => {
    const sets: SnapshotSet[] = [];
    for (const date of dates) {
      const rows: SnapshotSet['rows'] = {};
      for (const level of LEVELS) {
        const { snapshot } = (await situasPublic.fetchSnapshot(level, date)).data;
        const codes = keep[level];
        (rows as Record<Level, readonly { code: string }[]>)[level] = snapshot.rows.filter(
          (r) => codes === undefined || codes.includes(r.code),
        );
      }
      sets.push({ date, rows });
    }
    return sets;
  });
}

const overrides = await loadOverrides(OVERRIDES_DIR);

/** The invariant world of a built one: derived fields, existence, accounts, applied overrides. */
async function worldOf(
  built: BuiltVariations,
  options: { start: IsoDate; today: IsoDate; snapshots?: SnapshotSet[]; counts?: InvariantWorld['counts'] },
) {
  const anomalies = new AnomalyCollector();
  // The overrides were applied by the version builder (`overrides` of `fixtureWorld`).
  const provinces = built.entities.province;
  const applied = built.appliedOverrides;
  const { variations } = built;
  const entities: InvariantEntities = {
    region: deriveFields({ level: 'region', entities: built.entities.region, variations, anomalies }),
    province: deriveFields({ level: 'province', entities: provinces, variations, anomalies }),
    municipality: deriveFields({ level: 'municipality', entities: built.entities.municipality, variations, anomalies }),
  };
  const world: InvariantWorld = {
    ...options,
    entities,
    variations,
    existence: existenceOf(built.identified),
    historicalCodes: historicalCodesOf(provinces),
    extraUtsCodes: await knownUtsCodes(),
    overrides: applied,
    accounts: built.accounts,
    variationIdOf: (key) => built.registry.variationId(key),
  };
  return { world, anomalies, applied };
}

describe('full worlds of two consecutive days: every invariant that can run passes', () => {
  for (const dates of [
    ['1920-10-15', '1920-10-16'],
    ['1929-05-13', '1929-05-14'],
    ['1947-11-24', '1947-11-25'],
    ['1947-11-27', '1947-11-28'],
    ['2009-01-28', '2009-01-29'],
    ['2014-12-31', '2015-01-01'],
    ['2021-06-16', '2021-06-17'],
  ] as [IsoDate, IsoDate][]) {
    it(dates.join(' → '), async () => {
      const built = await fixtureWorld(dates, { overrides });
      const { world } = await worldOf(built, {
        start: dates[0],
        today: dates[1],
        snapshots: await snapshotSets(dates),
      });
      const report = await checkInvariants(world);
      expect(report.results.filter((r) => r.status === 'failed').map((r) => r.id)).toEqual([]);
      expect(report.results.filter((r) => r.status === 'failed')).toEqual([]);
      expect(report.results.filter((r) => r.status === 'skipped').map((r) => r.id)).toEqual(['I13']);
      expect(report.anomalies.filter((a) => a.level === 'blocking')).toEqual([]);
    });
  }
});

describe('golden-17: the 2026-10-01 world', async () => {
  const date: IsoDate = '2026-10-01';
  const built = await fixtureWorld([date], { overrides });
  const counts = await withSources(async ({ situasPublic }) => ({
    region: (await situasPublic.fetchCount(68, { date })).data,
    province: (await situasPublic.fetchCount(64, { date })).data,
    municipality: (await situasPublic.fetchCount(61, { date })).data,
  }));
  const { world } = await worldOf(built, { start: date, today: date, snapshots: await snapshotSets([date]), counts });

  it('the reconstructed counts equal the SITUAS count endpoints', () => {
    expect(counts).toEqual({ region: 20, province: 110, municipality: 7894 });
    expect(LEVELS.map((l) => [l, world.entities[l].length])).toEqual([
      ['region', 20],
      ['province', 110],
      ['municipality', 7894],
    ]);
  });

  it('passes every invariant but the ones that need events, and I12 compares all 8,024 rows', async () => {
    const report = await checkInvariants(world);
    expect(report.results.map((r) => [r.id, r.status])).toEqual(INVARIANT_IDS.map((id) => [id, 'passed']));
    expect(report.anomalies).toEqual([]);
  });

  it('a wrong count is I13 and nothing else', async () => {
    const report = await checkInvariants({ ...world, counts: { ...counts, municipality: 7896 } });
    expect(report.results.filter((r) => r.status === 'failed').map((r) => r.id)).toEqual(['I13']);
    expect(report.anomalies[0]?.context).toMatchObject({ level: 'municipality', reconstructed: 7894, expected: 7896 });
  });

  it('no active municipality has an 8xx code (D30)', () => {
    expect(checkActive8xxCodes(world.entities)).toEqual([]);
  });
});

describe('golden-4: Sardinia 2026 (I6, I7)', async () => {
  const dates: IsoDate[] = ['2025-12-31', '2026-01-01'];
  const built = await fixtureWorld(dates, {
    overrides,
    codes: {
      region: ['20'],
      province: ['090', '091', '092', '095', '111', '292', '113', '114', '115', '116', '117', '119', '312', '318'],
    },
    provinces: {
      graph: await utsGraph([
        ['090', 'province', '090_1_sassari.json'],
        ['312', 'metropolitan_city', '312_3_sassari.json'],
        ['092', 'province', '092_1_cagliari.json'],
        ['318', 'metropolitan_city', '318_3_cagliari.json'],
        ['111', 'province', '111_1_sud-sardegna.json'],
        ['113', 'province', '113_1_gallura-nord-est-sardegna.json'],
        ['114', 'province', '114_1_nuoro.json'],
        ['115', 'province', '115_1_oristano.json'],
        ['116', 'province', '116_1_ogliastra.json'],
        ['117', 'province', '117_1_medio-campidano.json'],
        ['119', 'province', '119_1_sulcis-iglesiente.json'],
      ]),
      details: ['126_ES_6151.json'],
    },
    municipalities: await municipalityGraph(['115064_siamanna.json']),
  });
  const { world } = await worldOf(built, { start: '2025-12-31', today: '2026-01-01' });

  it('SU belongs to Sud Sardegna until 2025-12-31 and to Sulcis Iglesiente from 2026-01-01 (I6 passes)', () => {
    const sudSardegna = entityAt(world.entities.province, '111', '2025-12-31');
    const sulcis = entityAt(world.entities.province, '119', '2026-01-01');
    expect(sudSardegna.versions.map((v) => [v.abbreviation, v.validTo])).toEqual([['SU', '2026-01-01']]);
    expect(sulcis.versions.map((v) => [v.abbreviation, v.validFrom])).toEqual([['SU', '2026-01-01']]);
    expect(checkI6(world.entities)).toEqual([]);
  });

  it('I7: the prefix of Alghero 112001 is the historical code of UTS 312, the metropolitan city of Sassari', () => {
    const alghero = entityAt(world.entities.municipality, '112001', '2026-01-01');
    const sassari = entityAt(world.entities.province, '312', '2026-01-01');
    const current = alghero.versions.at(-1);
    expect(current).toMatchObject({ istatCode: '112001', provinceId: sassari.id });
    expect(world.historicalCodes?.get(sassari.id)?.map((p) => p.value)).toEqual(['090', '112']);
    expect(checkI7(world.entities, world.historicalCodes ?? new Map(), world.extraUtsCodes)).toEqual([]);
  });

  it('I7: a UTS code taken for the historical one makes it fail (the §3.5 item 16 fallback)', () => {
    const sassari = entityAt(world.entities.province, '312', '2026-01-01');
    const wrong = new Map(world.historicalCodes ?? []).set(sassari.id, [
      { validFrom: '2025-12-31', validTo: null, value: '312' },
    ]);
    const found = checkI7(world.entities, wrong, world.extraUtsCodes);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((a) => a.level === 'blocking' && a.context.invariant === 'I7')).toBe(true);
    expect(found.some((a) => a.context.istatCode === '112001')).toBe(true);
  });
});

describe('golden-7: Venezia Giulia 1921 (I6, I7, I8, I12)', async () => {
  const dates: IsoDate[] = ['1921-06-01', '1923-02-07', '1923-02-08'];
  const built = await fixtureWorld(dates, { overrides });
  const { world, applied } = await worldOf(built, {
    start: '1921-06-01',
    today: '1923-02-08',
    snapshots: await snapshotSets(dates),
  });

  it('I8 passes after the override, and I12 expects VG for UTS 801 although SITUAS reports the full name', async () => {
    const veneziaGiulia = entityAt(world.entities.province, '801', '1921-06-01');
    expect(applied.map((a) => [a.entityId, a.before, a.after])).toEqual([[veneziaGiulia.id, 'Venezia Giulia', 'VG']]);
    expect(checkI8(world.entities.province)).toEqual([]);
    expect(
      await checkI12({
        entities: world.entities,
        historicalCodes: world.historicalCodes ?? new Map(),
        overrides: world.overrides ?? [],
        snapshots: world.snapshots ?? [],
      }),
    ).toEqual([]);
  });

  it('I12 fails on the same world without the override', async () => {
    const found = await checkI12({
      entities: world.entities,
      historicalCodes: world.historicalCodes ?? new Map(),
      overrides: [],
      snapshots: world.snapshots ?? [],
    });
    expect(found.every((a) => a.context.level === 'province')).toBe(true);
    expect(found.length).toBeGreaterThan(0);
  });

  it('I12 detects a merge error that alters the abbreviation of a pre-1948 version (Venezia Tridentina TN)', async () => {
    const tridentina = entityAt(world.entities.province, '802', '1921-06-01');
    const broken: InvariantEntities = {
      ...world.entities,
      province: world.entities.province.map((e) =>
        e.id === tridentina.id ? { ...e, versions: e.versions.map((v) => ({ ...v, abbreviation: 'XX' })) } : e,
      ),
    };
    const found = await checkI12({
      entities: broken,
      historicalCodes: world.historicalCodes ?? new Map(),
      overrides: world.overrides ?? [],
      snapshots: world.snapshots ?? [],
    });
    expect(found.map((a) => [a.context.level, a.context.date])).toEqual(dates.map((d) => ['province', d]));
    expect(found[0]?.context).toMatchObject({
      differences: [{ code: '802', fields: [{ field: 'abbreviation', snapshot: 'TN', version: 'XX' }] }],
    });
  });

  it('I7: the 8xx codes with another prefix are info; nothing is blocking, and I4, I5, I6 pass', () => {
    const found = checkI7(world.entities, world.historicalCodes ?? new Map(), world.extraUtsCodes);
    expect(found.filter((a) => a.level === 'blocking')).toEqual([]);
    // 36 municipality rows of the 1921 snapshot have a prefix other than their UTS (§3.5 item 17).
    expect(found).toHaveLength(36);
    expect(found.every((a) => a.level === 'info' && Number(String(a.context.istatCode).slice(3)) >= 800)).toBe(true);
    expect(checkI4(world.entities)).toEqual([]);
    expect(checkI5(world.entities)).toEqual([]);
    expect(checkI6(world.entities)).toEqual([]);
  });
});
