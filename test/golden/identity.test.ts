/**
 * Identity resolution on real SITUAS fixtures (§6.7, Step 9): the identity parts of golden 1–5,
 * and stable ids across builds on the same store (§5.3).
 *
 * Worlds of two consecutive dates are complete snapshots: every change of that day must be
 * explained. Worlds of non-consecutive dates are reduced to a few codes (`snapshotIndex`), so the
 * changes of the other territories in between do not enter the test.
 */
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import {
  Registry,
  resolveLevelIdentity,
  type InternalIdentity,
  type LevelEventLists,
  type ResolvedEntity,
} from '../../src/identity/index.ts';
import type { Level } from '../../src/model/common.ts';
import type { IntervalIndex } from '../../src/resolve/index.ts';
import { withTempDir } from '../helpers/http.ts';
import { municipalityIdentity, regionIdentity, snapshotIndex, utsIdentity } from '../helpers/identity.ts';
import { withSources } from '../helpers/sources.ts';

const SARDINIA_2026: IsoDate[] = ['2025-12-31', '2026-01-01'];
const SARDINIA_UTS_CODES = ['090', '091', '095', '111', '292', '113', '114', '115', '116', '117', '119', '312', '318'];

const world = await withSources(async ({ situasPublic }) => {
  const list = async <L extends Level>(level: L, pfun: number, from: IsoDate, to: IsoDate) =>
    (await situasPublic.fetchEventList(level, pfun as never, from, to)).data;
  return {
    municipalityLists: {
      98: await list('municipality', 98, '1861-03-17', '2026-09-30'),
      100: await list('municipality', 100, '1861-03-17', '2026-10-01'),
      104: await list('municipality', 104, '1861-03-17', '2026-09-30'),
      105: await list('municipality', 105, '1861-03-17', '2026-09-30'),
    },
    // The 2026 lists: the full-range ones cross-check rows of territories outside the reduced world.
    provinceLists2026: {
      112: await list('province', 112, '2026-01-01', '2026-09-30'),
      113: await list('province', 113, '2026-01-01', '2026-09-30'),
      114: await list('province', 114, '1861-03-17', '2026-10-01'),
    },
    setteville: await snapshotIndex(situasPublic, 'municipality', ['2024-01-21', '2024-01-22']),
    sardiniaMunicipalities: await snapshotIndex(situasPublic, 'municipality', SARDINIA_2026),
    sardiniaUts: await snapshotIndex(situasPublic, 'province', SARDINIA_2026, SARDINIA_UTS_CODES),
    sassofeltrio: await snapshotIndex(
      situasPublic,
      'municipality',
      ['1929-05-13', '1929-05-14', '1947-11-24', '1947-11-25', '2021-06-16', '2021-06-17'],
      ['041060', '099031', '041035', '041026'],
    ),
    siamanna1947: await snapshotIndex(
      situasPublic,
      'municipality',
      ['1928-05-03', '1928-05-04', '1947-11-27', '1947-11-28'],
      ['095809', '092128'],
    ),
    milano2015: await snapshotIndex(situasPublic, 'province', ['2014-12-31', '2015-01-01'], ['015', '215']),
  };
});

const sardiniaUtsIdentity = await utsIdentity([
  ['090', 'province', '090_1_sassari.json'],
  ['312', 'metropolitan_city', '312_3_sassari.json'],
  ['092', 'province', '092_1_cagliari.json'],
  ['318', 'metropolitan_city', '318_3_cagliari.json'],
  ['111', 'province', '111_1_sud-sardegna.json'],
  ['114', 'province', '114_1_nuoro.json'],
  ['115', 'province', '115_1_oristano.json'],
  ['113', 'province', '113_1_gallura-nord-est-sardegna.json'],
  ['116', 'province', '116_1_ogliastra.json'],
  ['117', 'province', '117_1_medio-campidano.json'],
  ['119', 'province', '119_1_sulcis-iglesiente.json'],
]);

const sassofeltrioIdentity = await municipalityIdentity(['099031_sassofeltrio.json']);

function resolve<L extends Level>(
  level: L,
  index: IntervalIndex<L>,
  internal: InternalIdentity | null,
  eventLists: LevelEventLists<L>,
) {
  const anomalies = new AnomalyCollector();
  return { ...resolveLevelIdentity({ level, index, internal, eventLists, anomalies }), anomalies };
}

/** Each entity as `key → interval keys`. */
function summary(entities: readonly ResolvedEntity[]): Record<string, string[]> {
  return Object.fromEntries(entities.map((e) => [e.key, e.intervals.map((i) => `${i.code}@${i.validFrom}`)]));
}

function entityOf(entities: readonly ResolvedEntity[], code: string, date: IsoDate): ResolvedEntity {
  const entity = entities.find((e) =>
    e.intervals.some((i) => i.code === code && i.validFrom <= date && (i.validTo === null || date < i.validTo)),
  );
  if (entity === undefined) throw new Error(`no entity with ${code} on ${date}`);
  return entity;
}

function codes(anomalies: AnomalyCollector): string[] {
  return anomalies.list().map((a) => `${a.level}:${a.code}`);
}

describe('golden-1: the 2024-01-22 municipality transition', () => {
  const { entities, transitions, anomalies } = resolve('municipality', world.setteville, null, world.municipalityLists);

  it('explains every change of the day; only the establishments need internal data', () => {
    // Without internal data an establishment could be a reconstitution (§6.1): blocking.
    expect(anomalies.list().map((a) => [a.level, a.code, (a.context.intervals as string[])[0]])).toEqual([
      ['blocking', 'internal-data-required', '024128@2024-01-22'],
      ['blocking', 'internal-data-required', '025075@2024-01-22'],
      ['blocking', 'internal-data-required', '028108@2024-01-22'],
    ]);
  });

  it('ends Quero Vas and Alano di Piave on 2024-01-21 and starts Setteville as another entity', () => {
    const queroVas = entityOf(entities, '025070', '2024-01-21');
    const alano = entityOf(entities, '025002', '2024-01-21');
    const setteville = entityOf(entities, '025075', '2024-01-22');
    expect(queroVas.intervals.at(-1)?.validTo).toBe('2024-01-22');
    expect(alano.intervals.at(-1)?.validTo).toBe('2024-01-22');
    expect(setteville.intervals[0]?.validFrom).toBe('2024-01-22');
    expect(new Set([queroVas.key, alano.key, setteville.key]).size).toBe(3);
    expect(transitions.ends.get('025070@2024-01-21')).toEqual(['ES']);
    expect(transitions.starts.get('025075@2024-01-22')).toEqual(['CS']);
  });

  it('keeps the new Sovizzo apart from the old one (name reuse, §3.5 item 5)', () => {
    const oldSovizzo = entityOf(entities, '024103', '2024-01-21');
    const newSovizzo = entityOf(entities, '024128', '2024-01-22');
    expect(oldSovizzo.key).not.toBe(newSovizzo.key);
    expect(oldSovizzo.intervals.map((i) => i.code)).toEqual(['024103']);
  });
});

describe('golden-2: Sassofeltrio, suppressed in 1929 and reconstituted in 1947', () => {
  const { entities, anomalies } = resolve(
    'municipality',
    world.sassofeltrio,
    sassofeltrioIdentity,
    world.municipalityLists,
  );

  it('is one entity (origin id 4450) with a gap, its code changed in 2021', () => {
    const sassofeltrio = entityOf(entities, '099031', '2021-06-17');
    expect(sassofeltrio).toMatchObject({ key: 'istat:4450', istatOriginId: 4450, members: [4450] });
    expect(sassofeltrio.intervals.map((i) => [i.code, i.validFrom, i.validTo])).toEqual([
      ['041060', '1929-05-13', '1929-05-14'],
      ['041060', '1947-11-25', '2021-06-16'],
      ['041060', '2021-06-16', '2021-06-17'],
      ['099031', '2021-06-17', null],
    ]);
  });

  it('joins the two chains without anomalies: the suppression and the reconstitution are documented', () => {
    // The renames of Piandicastello (1940) and Monte Grimano (2002) fall between the dates of
    // the reduced world, so their rows change on dates without a CD event.
    expect(codes(anomalies)).toEqual(['warning:name-change-without-event', 'warning:name-change-without-event']);
  });

  it('keeps Monte Grimano and Piandicastello/Mercatino Conca as their own entities', () => {
    expect(entityOf(entities, '041035', '1929-05-13').key).toBe('nk:municipality:041035:1929-05-13');
    expect(entityOf(entities, '041026', '2021-06-17').key).toBe('nk:municipality:041026:1929-05-13');
  });
});

describe('golden-3: Siamanna', () => {
  it('the 1861–1928 Siamanna (095809) is not the Siamanna-Siapiccia of 1947 (origin id 10704)', async () => {
    const internal = await municipalityIdentity(['115064_siamanna.json']);
    const { entities, anomalies } = resolve('municipality', world.siamanna1947, internal, world.municipalityLists);
    expect(summary(entities)).toEqual({
      'nk:municipality:095809:1928-05-03': ['095809@1928-05-03'],
      'istat:10704': ['092128@1947-11-28'],
    });
    expect(anomalies.list()).toEqual([]);
  });

  it('keeps origin id 10704 through the 2026 renumbering 095057 → 115064', async () => {
    const internal = await municipalityIdentity(['115064_siamanna.json']);
    const { entities } = resolve('municipality', world.sardiniaMunicipalities, internal, world.municipalityLists);
    expect(summary([entityOf(entities, '115064', '2026-01-01')])).toEqual({
      'istat:10704': ['095057@2025-12-31', '115064@2026-01-01'],
    });
  });
});

describe('golden-4: Sardinia 2026', () => {
  it('UTS: renumberings and type changes keep the entity, reconstituted provinces are new entities', () => {
    const { entities, transitions, anomalies } = resolve(
      'province',
      world.sardiniaUts,
      sardiniaUtsIdentity,
      world.provinceLists2026,
    );
    expect(anomalies.list()).toEqual([]);
    expect(summary(entities)).toEqual({
      'istat:58': ['090@2025-12-31', '312@2026-01-01'],
      'istat:95': ['091@2025-12-31', '114@2026-01-01'],
      'istat:101': ['095@2025-12-31', '115@2026-01-01'],
      'istat:126': ['111@2025-12-31'],
      'istat:59': ['292@2025-12-31', '318@2026-01-01'],
      'istat:142': ['113@2026-01-01'],
      'istat:146': ['116@2026-01-01'],
      'istat:144': ['117@2026-01-01'],
      'istat:145': ['119@2026-01-01'],
    });
    expect(entities.find((e) => e.key === 'istat:58')?.members).toEqual([58, 143]);
    expect(entities.find((e) => e.key === 'istat:59')?.members).toEqual([59, 127]);
    expect(transitions.ends.get('111@2025-12-31')).toEqual(['ES']);
    expect(transitions.links.filter((l) => l.rule === 'code-change').map((l) => [l.from, l.to])).toEqual([
      ['090@2025-12-31', '312@2026-01-01'],
      ['091@2025-12-31', '114@2026-01-01'],
      ['095@2025-12-31', '115@2026-01-01'],
      ['292@2025-12-31', '318@2026-01-01'],
    ]);
  });

  it('municipalities: the whole transition is explained; Alghero 090003 → 112001 is one entity', () => {
    const { entities, anomalies } = resolve(
      'municipality',
      world.sardiniaMunicipalities,
      null,
      world.municipalityLists,
    );
    expect(anomalies.list()).toEqual([]);
    expect(summary([entityOf(entities, '112001', '2026-01-01')])).toEqual({
      'nk:municipality:090003:2025-12-31': ['090003@2025-12-31', '112001@2026-01-01'],
    });
  });
});

describe('golden-5: Milano 2015', () => {
  it('province 015 (id_uts 9) and metropolitan city 215 (id_uts 119) are one entity, root 9', async () => {
    const internal = await utsIdentity([
      ['015', 'province', '015_1_milano.json'],
      ['215', 'metropolitan_city', '215_3_milano.json'],
    ]);
    const { entities, anomalies } = resolve('province', world.milano2015, internal, {});
    expect(anomalies.list()).toEqual([]);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ key: 'istat:9', istatOriginId: 9, members: [9, 119] });
    expect(summary(entities)).toEqual({ 'istat:9': ['015@2014-12-31', '215@2015-01-01'] });
  });
});

describe('registry ids across builds (§5.3)', () => {
  const build = () => resolve('province', world.sardiniaUts, sardiniaUtsIdentity, world.provinceLists2026).entities;

  it('two builds on the same store produce identical ids', async () => {
    await withTempDir(async (dir) => {
      const options = { recordedOn: '2026-10-04', anomalies: new AnomalyCollector() };
      const first = await Registry.load(dir);
      const firstIds = first.assignEntities('province', build(), options).ids;
      await first.save();
      const second = await Registry.load(dir);
      const secondAssignment = second.assignEntities('province', build(), options);
      expect([...secondAssignment.ids]).toEqual([...firstIds]);
      expect(secondAssignment.remaps).toEqual([]);

      await withTempDir(async (other) => {
        const fresh = (await Registry.load(other)).assignEntities('province', build(), options).ids;
        expect([...fresh]).toEqual([...firstIds]);
      });
      expect(options.anomalies.list()).toEqual([]);
    });
  });
});

describe('golden-15: type changes of 1948 without ESCT', async () => {
  const CODES = ['01', '82', '04'];
  const DAY = '1948-01-01';
  const { index, lists } = await withSources(async ({ situasPublic }) => {
    const rows = async (pfun: 106 | 107) =>
      (await situasPublic.fetchEventList('region', pfun, '1861-03-17', '2026-10-01')).data.filter(
        (r) => r.date === DAY && CODES.includes(r.code),
      );
    return {
      index: await snapshotIndex(situasPublic, 'region', ['1947-12-31', DAY], CODES),
      lists: { 106: await rows(106), 107: await rows(107) },
    };
  });
  const internal = await regionIdentity([
    ['01', 'compartment', '01_1_piemonte.json'],
    ['01', 'region', '01_2_piemonte.json'],
    ['82', 'compartment', '82_1_venezia-tridentina.json'],
    ['04', 'region', '04_2_trentino-alto-adige-sudtirol.json'],
  ]);
  const { entities, transitions, anomalies } = resolve('region', index, internal, lists);

  it('Venezia Tridentina (82, no event on the day) becomes Trentino-Alto Adige (04, CSCT): one entity, origin 22', () => {
    expect(entityOf(entities, '82', '1947-12-31')).toBe(entityOf(entities, '04', DAY));
    expect(entityOf(entities, '04', DAY)).toMatchObject({ key: 'istat:22', istatOriginId: 22 });
    expect(transitions.links).toContainEqual({
      date: DAY,
      from: '82@1947-12-31',
      to: '04@1948-01-01',
      rule: 'type-change',
    });
  });

  it('Piemonte (ES on the compartment, CSCT on the region) is a type change of the same code', () => {
    expect(entityOf(entities, '01', '1947-12-31')).toBe(entityOf(entities, '01', DAY));
    expect(transitions.links).toContainEqual({
      date: DAY,
      from: '01@1947-12-31',
      to: '01@1948-01-01',
      rule: 'type-change',
    });
  });

  it('explains the ESCT rows of pfun 106 and the new name of the typed record: no anomaly', () => {
    expect(lists[106].map((r) => [r.event, r.code, r.related?.code])).toEqual(
      expect.arrayContaining([
        ['ESCT', '82', '04'],
        ['ESCT', '01', '01'],
      ]),
    );
    // The new name comes with the new typed record: no `name-change-without-event` (§6.7).
    expect(codes(anomalies)).toEqual([]);
  });
});
