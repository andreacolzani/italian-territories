/**
 * Variations and links on real SITUAS fixtures (§4.3, Step 11): golden 1, 2, 4, 6, 9, 18, 19, and
 * I9, I10, I14 on the full worlds of two consecutive days.
 *
 * Event lists and internal events are restricted to the dates of each world (`onDates`): a row of
 * another date concerns snapshots the world does not have. Worlds of non-consecutive dates are
 * reduced to a few codes, so rows of the other territories do not resolve there (`code-unresolved`):
 * those tests only look at the variations of their territories.
 */
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../src/dates/index.ts';
import { internalIdentity, type IdentityGraph } from '../../src/identity/index.ts';
import type { Level } from '../../src/model/common.ts';
import type { Variation } from '../../src/model/internal.ts';
import { IntervalIndex } from '../../src/resolve/index.ts';
import type { InternalMunicipalityEvent, InternalUtsEvent } from '../../src/sources/situas-internal/index.ts';
import { municipalityGraph, snapshotIndex, utsGraph } from '../helpers/identity.ts';
import { withSources } from '../helpers/sources.ts';
import {
  accountViolations,
  buildVariationWorld,
  onDates,
  utsDetails,
  variationEvents,
  variationOf,
  variationPropertyViolations,
  type BuiltVariations,
} from '../helpers/variations.ts';
import { entityAt } from '../helpers/versions.ts';

const lists = await withSources(async ({ situasPublic }) => {
  const list = async <L extends Level>(level: L, pfun: number, to: IsoDate) =>
    (await situasPublic.fetchEventList(level, pfun as never, '1861-03-17', to)).data;
  return {
    municipality: {
      98: await list('municipality', 98, '2026-09-30'),
      100: await list('municipality', 100, '2026-10-01'),
      103: await list('municipality', 103, '2026-10-01'),
      104: await list('municipality', 104, '2026-09-30'),
      105: await list('municipality', 105, '2026-09-30'),
    },
    province: {
      112: await list('province', 112, '2026-10-01'),
      113: await list('province', 113, '2026-10-01'),
      114: await list('province', 114, '2026-10-01'),
    },
    region: {
      106: await list('region', 106, '2026-10-01'),
      107: await list('region', 107, '2026-10-01'),
      108: await list('region', 108, '2026-10-01'),
    },
  };
});

/** The lists of a level with only the rows of `dates`. */
function listsOn(level: Level, dates: readonly IsoDate[]): Record<number, unknown[]> {
  const byPfun = lists[level] as Record<number, { date: IsoDate }[]>;
  return Object.fromEntries(Object.entries(byPfun).map(([pfun, rows]) => [pfun, onDates(rows, dates)]));
}

interface WorldOptions {
  /** Codes kept per level; `false`: an empty level (no snapshots of those dates). */
  codes?: { region?: string[] | false; province?: string[] | false; municipality?: string[] };
  municipalities?: IdentityGraph<InternalMunicipalityEvent>;
  provinces?: { graph: IdentityGraph<InternalUtsEvent>; details?: string[] };
}

/** A world of `dates`, with the event rows and internal events of every date but the first. */
async function world(dates: readonly IsoDate[], options: WorldOptions = {}): Promise<BuiltVariations> {
  const { codes = {} } = options;
  const eventDates = dates.slice(1);
  const indexes = await withSources(async ({ situasPublic }) => ({
    region:
      codes.region === false
        ? new IntervalIndex('region', new Map())
        : await snapshotIndex(situasPublic, 'region', dates, codes.region),
    province:
      codes.province === false
        ? new IntervalIndex('province', new Map())
        : await snapshotIndex(situasPublic, 'province', dates, codes.province),
    municipality: await snapshotIndex(situasPublic, 'municipality', dates, codes.municipality),
  }));
  const { municipalities, provinces } = options;
  return buildVariationWorld({
    region: { index: indexes.region, eventLists: listsOn('region', eventDates) },
    province: {
      index: indexes.province,
      eventLists: listsOn('province', eventDates),
      internal:
        provinces === undefined
          ? null
          : internalIdentity(provinces.graph, true, (e) => ({ ...e, recordId: e.utsId }), 'r5:uts-events'),
    },
    municipality: {
      index: indexes.municipality,
      eventLists: listsOn('municipality', eventDates),
      internal:
        municipalities === undefined
          ? null
          : internalIdentity(municipalities, false, (e) => ({ ...e, recordId: e.originId }), 'r6:municipality-events'),
    },
    internalEvents: {
      ...(municipalities === undefined ? {} : { municipality: onDates(variationEvents(municipalities), eventDates) }),
      ...(provinces === undefined
        ? {}
        : {
            province: onDates(variationEvents(provinces.graph, await utsDetails(provinces.details ?? [])), eventDates),
          }),
    },
  });
}

/** Participants of a variation as `[level, entity id, events, role]`. */
function roles(variation: Variation): [Level, number, string[], string | null][] {
  return variation.participants.map((p) => [p.level, p.entityId, p.istatEvents, p.role]);
}

function links(variation: Variation): [number, number, string][] {
  return variation.links.map((l) => [l.from, l.to, l.kind]);
}

/** A full world: every boundary referenced (I9, I10), every row accounted for (I14), no anomaly. */
function expectComplete(built: BuiltVariations, allowed: readonly string[] = []): void {
  expect(variationPropertyViolations(built)).toEqual([]);
  expect(accountViolations(built)).toEqual([]);
  expect(
    built.variationAnomalies
      .list()
      .filter((a) => !allowed.includes(a.code))
      .map((a) => a.message),
  ).toEqual([]);
}

describe('golden-1: Setteville and the mergers of 2024-01-22', async () => {
  const dates: IsoDate[] = ['2024-01-21', '2024-01-22'];
  const built = await world(dates, {
    codes: { region: false, province: false },
    municipalities: await municipalityGraph([
      '025075_setteville.json',
      '025070_quero-vas.json',
      '025002_alano-di-piave.json',
    ]),
  });
  const at = (code: string, date: IsoDate) => entityAt(built.entities.municipality, code, date);

  it('one variation (act 6141) merges Quero Vas and Alano di Piave into Setteville', () => {
    const queroVas = at('025070', '2024-01-21');
    const alano = at('025002', '2024-01-21');
    const setteville = at('025075', '2024-01-22');
    expect(queroVas.versions.at(-1)?.validTo).toBe('2024-01-22');
    const variation = variationOf(built, 'municipality', setteville.id, '2024-01-22');
    expect(variation).toMatchObject({ istatActId: 6141, origin: 'istat' });
    expect(variation.description).toContain('SETTEVILLE');
    expect(roles(variation)).toEqual(
      [
        ['municipality', queroVas.id, ['ES'], 'suppressed'],
        ['municipality', alano.id, ['ES'], 'suppressed'],
        ['municipality', setteville.id, ['CS'], 'established'],
      ].sort((a, b) => (a[1] as number) - (b[1] as number)),
    );
    expect(links(variation)).toEqual(
      [
        [queroVas.id, setteville.id, 'merged_into'],
        [alano.id, setteville.id, 'merged_into'],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
  });

  it('the new Sovizzo is another entity; its merger has no act id without internal data', () => {
    const oldSovizzo = at('024103', '2024-01-21');
    const newSovizzo = at('024128', '2024-01-22');
    const gambugliano = at('024044', '2024-01-21');
    expect(newSovizzo.id).not.toBe(oldSovizzo.id);
    const variation = variationOf(built, 'municipality', newSovizzo.id, '2024-01-22');
    expect(variation).toMatchObject({ istatActId: null, description: null, origin: 'istat' });
    expect(links(variation)).toEqual(
      [
        [oldSovizzo.id, newSovizzo.id, 'merged_into'],
        [gambugliano.id, newSovizzo.id, 'merged_into'],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
    expect(built.variations).toHaveLength(3);
    expectComplete(built);
  });
});

describe('golden-2: Sassofeltrio', async () => {
  const built = await world(['1929-05-13', '1929-05-14', '1947-11-24', '1947-11-25', '2021-06-16', '2021-06-17'], {
    codes: { region: ['08', '11'], province: ['041', '099'], municipality: ['041060', '099031', '041035', '041026'] },
    municipalities: await municipalityGraph(['099031_sassofeltrio.json']),
  });
  const at = (code: string, date: IsoDate) => entityAt(built.entities.municipality, code, date);
  const sassofeltrio = at('099031', '2021-06-17');
  const monteGrimano = at('041035', '1929-05-14');
  const piandicastello = at('041026', '1929-05-14');

  it('1929 (act 4928): suppressed, merged into Monte Grimano and Piandicastello', () => {
    const variation = variationOf(built, 'municipality', sassofeltrio.id, '1929-05-14');
    expect(variation.istatActId).toBe(4928);
    expect(roles(variation)).toEqual([['municipality', sassofeltrio.id, ['ES'], 'suppressed']]);
    expect(links(variation)).toEqual(
      [
        [sassofeltrio.id, monteGrimano.id, 'merged_into'],
        [sassofeltrio.id, piandicastello.id, 'merged_into'],
      ].sort((a, b) => (a[1] as number) - (b[1] as number)),
    );
  });

  it('1947 (act 4949): reconstituted, detached from Monte Grimano and Piandicastello renamed Mercatino Conca', () => {
    expect(at('041026', '1947-11-24').id).toBe(piandicastello.id);
    expect(at('041026', '1947-11-24').versions.at(-1)?.officialName).toBe('Mercatino Conca');
    const variation = variationOf(built, 'municipality', sassofeltrio.id, '1947-11-25');
    expect(variation.istatActId).toBe(4949);
    expect(roles(variation)).toEqual([['municipality', sassofeltrio.id, ['CS'], 'established']]);
    expect(links(variation)).toEqual(
      [
        [monteGrimano.id, sassofeltrio.id, 'detached_into'],
        [piandicastello.id, sassofeltrio.id, 'detached_into'],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
  });

  it('2021 (act 6128): the change of province is a change of the same entity', () => {
    const variation = variationOf(built, 'municipality', sassofeltrio.id, '2021-06-17');
    expect(variation.istatActId).toBe(6128);
    const [first, , last] = sassofeltrio.versions;
    expect(variation.participants).toEqual([
      {
        level: 'municipality',
        entityId: sassofeltrio.id,
        istatEvents: ['AP'],
        abroad: false,
        role: 'changed',
        versionBeforeId: sassofeltrio.versions[1]?.id,
        versionAfterId: last?.id,
      },
    ]);
    expect(first?.validTo).toBe('1929-05-14');
  });
});

describe('golden-4: Sardinia 2026', async () => {
  const dates: IsoDate[] = ['2025-12-31', '2026-01-01'];
  const built = await world(dates, {
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
  const uts = (code: string) => entityAt(built.entities.province, code, '2026-01-01').id;
  const sudSardegna = entityAt(built.entities.province, '111', '2025-12-31').id;
  const act = built.variations.find((v) => v.istatActId === 6151);
  const participant = (level: Level, entityId: number) =>
    act?.participants.find((p) => p.level === level && p.entityId === entityId);

  it('one variation (act 6151) for the whole reorganisation', () => {
    expect(act).toMatchObject({ date: '2026-01-01', origin: 'istat' });
    expect(act?.description).toMatch(/^ISTITUITE LA CITTA' METROPOLITANA DI SASSARI/);
    expect(built.variations.filter((v) => v.participants.some((p) => p.level === 'province'))).toEqual([act]);
  });

  it('Sud Sardegna is suppressed and merged into its five successors', () => {
    expect(participant('province', sudSardegna)).toMatchObject({ istatEvents: ['ES'], role: 'suppressed' });
    const successors = ['114', '116', '117', '119', '318'].map(uts);
    expect(act?.links.filter((l) => l.from === sudSardegna).map((l) => [l.to, l.kind])).toEqual(
      successors.sort((a, b) => a - b).map((id) => [id, 'merged_into']),
    );
  });

  it('Sassari becomes a metropolitan city and Gallura Nord-Est Sardegna is detached from it', () => {
    expect(participant('province', uts('312'))).toMatchObject({ istatEvents: ['CSCT', 'ESCT'], role: 'changed' });
    expect(act?.links).toContainEqual({ level: 'province', from: uts('312'), to: uts('113'), kind: 'detached_into' });
  });

  it('renumbered UTS are changed; the new provinces are established', () => {
    for (const code of ['114', '115', '318']) {
      expect(participant('province', uts(code))).toMatchObject({ role: 'changed' });
      expect(participant('province', uts(code))?.istatEvents).toContain('RN');
    }
    for (const code of ['113', '116', '117', '119']) {
      expect(participant('province', uts(code))).toMatchObject({ istatEvents: ['CS'], role: 'established' });
    }
    expect(act?.links).toContainEqual({ level: 'province', from: uts('114'), to: uts('116'), kind: 'detached_into' });
  });

  it('Siamanna 095057 → 115064 takes part in the same act; Alghero 090003 → 112001 is a new version', () => {
    const siamanna = entityAt(built.entities.municipality, '115064', '2026-01-01');
    const [before, after] = siamanna.versions;
    expect(participant('municipality', siamanna.id)).toEqual({
      level: 'municipality',
      entityId: siamanna.id,
      istatEvents: ['RN'],
      abroad: false,
      role: 'changed',
      versionBeforeId: before?.id,
      versionAfterId: after?.id,
    });
    const alghero = entityAt(built.entities.municipality, '112001', '2026-01-01');
    expect(variationOf(built, 'municipality', alghero.id, '2026-01-01').participants).toEqual([
      expect.objectContaining({ istatEvents: ['RNAPUTS'], role: 'changed' }),
    ]);
    expectComplete(built);
  });
});

describe('golden-6: same-day suppressions', async () => {
  const built = await world(['1927-01-11', '1927-01-12']);
  const at = (code: string, date: IsoDate) => entityAt(built.entities.municipality, code, date);

  it('Finalborgo, Finale Marina, Finale Pia: last versions in Genova, merged into Finale Ligure', () => {
    const finaleLigure = at('009029', '1927-01-12');
    const genova = entityAt(built.entities.province, '010', '1927-01-11').id;
    const suppressed = ['010877', '010878', '010879'].map((code) => at(code, '1927-01-11'));
    for (const entity of suppressed) {
      expect(entity.versions).toHaveLength(1);
      expect(entity.versions[0]).toMatchObject({ validTo: '1927-01-12', provinceId: genova });
    }
    const variation = variationOf(built, 'municipality', finaleLigure.id, '1927-01-12');
    expect(roles(variation)).toEqual([
      ...suppressed.map((e): [Level, number, string[], string] => ['municipality', e.id, ['ES'], 'suppressed']),
      ['municipality', finaleLigure.id, ['CS'], 'established'],
    ]);
    expect(links(variation)).toEqual(suppressed.map((e) => [e.id, finaleLigure.id, 'merged_into']));
  });

  it('Lucinico is merged into Gorizia', () => {
    const lucinico = at('030876', '1927-01-11');
    const gorizia = at('031007', '1927-01-12');
    expect(variationOf(built, 'municipality', lucinico.id, '1927-01-12').links).toContainEqual({
      level: 'municipality',
      from: lucinico.id,
      to: gorizia.id,
      kind: 'merged_into',
    });
  });

  it('the 17 same-day AP rows have no effect: dropped (info), the rest of the day is complete', () => {
    const dropped = built.variationAnomalies.list().filter((a) => a.code === 'participation-without-effect');
    expect(dropped).toHaveLength(17);
    expect(new Set(dropped.map((a) => [a.level, a.context.event].join(' ')))).toEqual(new Set(['info AP']));
    const rows = built.accounts.filter((a) => a.dropped === 'no-effect');
    expect(rows.map((a) => [a.source, a.event])).toEqual(Array(17).fill(['events:pfun-105', 'AP']));
    expectComplete(built, ['participation-without-effect']);
  });
});

describe('golden-6: Cantonale (1936-06-04)', async () => {
  const built = await world(['1936-06-03', '1936-06-04'], { codes: { region: false, province: false } });

  it('suppressed under its same-day code, merged into Chignolo Po', () => {
    const cantonale = entityAt(built.entities.municipality, '015992', '1936-06-03');
    const chignolo = entityAt(built.entities.municipality, '018048', '1936-06-04');
    const variation = variationOf(built, 'municipality', cantonale.id, '1936-06-04');
    expect(variation.participants.find((p) => p.entityId === cantonale.id)).toMatchObject({
      istatEvents: ['ES'],
      role: 'suppressed',
    });
    expect(variation.links).toContainEqual({
      level: 'municipality',
      from: cantonale.id,
      to: chignolo.id,
      kind: 'merged_into',
    });
  });
});

describe('the cessions of 1947-09-16 (golden 9, 18, 19)', async () => {
  const built = await world(['1947-09-15', '1947-09-16']);
  const at = (code: string, date: IsoDate) => entityAt(built.entities.municipality, code, date);
  const participantOf = (entityId: number) =>
    variationOf(built, 'municipality', entityId, '1947-09-16').participants.find((p) => p.entityId === entityId);

  it('golden-9: Fiume is ceded abroad on 1947-09-16, like every AS row of pfun 98 dated that day', () => {
    const fiume = at('701706', '1947-09-15');
    expect(fiume.versions.at(-1)?.validTo).toBe('1947-09-16');
    expect(participantOf(fiume.id)).toMatchObject({ istatEvents: ['AS'], role: 'ceded', abroad: true });
    expect(built.variations.flatMap((v) => v.links).filter((l) => l.from === fiume.id || l.to === fiume.id)).toEqual(
      [],
    );
    const cessions = lists.municipality[98].filter((r) => r.event === 'AS');
    expect(cessions).toHaveLength(107);
    expect(new Set(cessions.map((r) => r.date))).toEqual(new Set(['1947-09-16']));
    const ceded = built.variations.flatMap((v) => v.participants).filter((p) => p.role === 'ceded');
    expect(ceded.filter((p) => p.level === 'municipality')).toHaveLength(107);
    expect(ceded.every((p) => p.abroad)).toBe(true);
  });

  it('golden-18: partial cessions abroad are territory changes, abroad, without links', () => {
    for (const code of ['031007', '032006', '001022']) {
      const entity = at(code, '1947-09-16');
      expect(participantOf(entity.id)).toMatchObject({
        istatEvents: ['CE'],
        abroad: true,
        role: 'territory_changed',
        versionBeforeId: null,
        versionAfterId: null,
      });
      expect(built.variations.flatMap((v) => v.links).some((l) => l.from === entity.id || l.to === entity.id)).toBe(
        false,
      );
    }
  });

  it('golden-19: Tenda is ceded abroad after giving territory to Limone Piemonte and Briga Alta', () => {
    const tenda = at('004820', '1947-09-15');
    const limone = at('004110', '1947-09-16');
    const brigaAlta = at('004031', '1947-09-16');
    expect(participantOf(tenda.id)).toMatchObject({ istatEvents: ['AS', 'CE', 'CECS'], role: 'ceded', abroad: true });
    const fromTenda = built.variations.flatMap((v) => v.links).filter((l) => l.from === tenda.id);
    expect(fromTenda.map((l) => [l.to, l.kind])).toEqual(
      [
        [limone.id, 'merged_into'],
        [brigaAlta.id, 'merged_into'],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
  });

  it('no ceded municipality leaves a code unresolved; the day is complete', () => {
    expectComplete(built);
  });
});

describe('full worlds of two consecutive days (I9, I10, I14)', () => {
  for (const dates of [
    ['1920-10-15', '1920-10-16'],
    ['1929-05-13', '1929-05-14'],
    ['1947-11-24', '1947-11-25'],
    ['1947-11-27', '1947-11-28'],
    ['2009-01-28', '2009-01-29'],
    ['2014-12-31', '2015-01-01'],
    ['2021-06-16', '2021-06-17'],
  ]) {
    it(`${dates[1]}: every boundary referenced, every row accounted for`, async () => {
      expectComplete(await world(dates));
    });
  }
});
