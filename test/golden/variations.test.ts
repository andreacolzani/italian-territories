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
import type { Level } from '../../src/model/common.ts';
import type { Variation } from '../../src/model/internal.ts';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { deriveFields } from '../../src/derive/index.ts';
import { internalIdentity } from '../../src/identity/index.ts';
import { IntervalIndex } from '../../src/resolve/index.ts';
import { municipalityGraph, regionGraph, snapshotIndex, utsGraph } from '../helpers/identity.ts';
import { withSources } from '../helpers/sources.ts';
import {
  accountViolations,
  eventLists,
  buildVariationWorld,
  fixtureWorld,
  onDates,
  regionDetails,
  variationEvents,
  variationOf,
  variationPropertyViolations,
  type BuiltVariations,
} from '../helpers/variations.ts';
import { entityAt } from '../helpers/versions.ts';

const lists = await eventLists();

/** Participants of a variation as `[level, entity id, events, role]`. */
function roles(variation: Variation): [Level, string, string[], string | null][] {
  return variation.participants.map((p) => [p.level, p.entityId, p.istatEvents, p.role]);
}

function links(variation: Variation): [string, string, string][] {
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
  const built = await fixtureWorld(dates, {
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
      ].sort((a, b) => cmp(a[1] as string, b[1] as string)),
    );
    expect(links(variation)).toEqual(
      [
        [queroVas.id, setteville.id, 'merged_into'],
        [alano.id, setteville.id, 'merged_into'],
      ].sort((a, b) => cmp(a[0] ?? '', b[0] ?? '')),
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
      ].sort((a, b) => cmp(a[0] ?? '', b[0] ?? '')),
    );
    expect(built.variations).toHaveLength(3);
    expectComplete(built);
  });
});

describe('golden-2: Sassofeltrio', async () => {
  const built = await fixtureWorld(
    ['1929-05-13', '1929-05-14', '1947-11-24', '1947-11-25', '2021-06-16', '2021-06-17'],
    {
      codes: { region: ['08', '11'], province: ['041', '099'], municipality: ['041060', '099031', '041035', '041026'] },
      municipalities: await municipalityGraph(['099031_sassofeltrio.json']),
    },
  );
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
      ].sort((a, b) => cmp(a[1] ?? '', b[1] ?? '')),
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
      ].sort((a, b) => cmp(a[0] ?? '', b[0] ?? '')),
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
        versionBefore: sassofeltrio.versions[1]?.validFrom,
        versionAfter: last?.validFrom,
      },
    ]);
    expect(first?.validTo).toBe('1929-05-14');
  });
});

describe('golden-15: the regions of 1948-01-01, links of act 6107 repeated by pfun 106 (D43)', async () => {
  const DAY: IsoDate = '1948-01-01';
  // Compartments Piemonte, Veneto, Venezia Giulia; regions Piemonte, Valle d'Aosta, Veneto, Friuli-Venezia Giulia.
  const CODES = ['01', '02', '05', '06', '83'];
  const graph = await regionGraph([
    ['01', 'compartment', '01_1_piemonte.json'],
    ['01', 'region', '01_2_piemonte.json'],
    ['02', 'region', '02_2_valle-d-aosta.json'],
    ['05', 'compartment', '05_1_veneto.json'],
    ['05', 'region', '05_2_veneto.json'],
    ['06', 'region', '06_2_friuli-venezia-giulia.json'],
    ['83', 'compartment', '83_1_venezia-giulia.json'],
  ]);
  const details = await regionDetails([
    '25_CS_6107.json',
    '29_CS_6107.json',
    '14_CSCT_6107.json',
    '12_CSCT_6107.json',
    '14_ES_6107.json',
    '12_ES_6107.json',
    '23_ES_6107.json',
  ]);
  const index = await withSources(({ situasPublic }) =>
    snapshotIndex(situasPublic, 'region', ['1947-12-31', DAY], CODES),
  );
  const kept = (r: { date: IsoDate; code: string; related: { code: string | null } | null }) =>
    r.date === DAY && CODES.includes(r.code) && (r.related?.code == null || CODES.includes(r.related.code));
  const built = await buildVariationWorld({
    region: {
      index,
      internal: internalIdentity(graph, true, (e) => ({ ...e, recordId: e.originId }), 'r4:region-events'),
      eventLists: { 106: lists.region[106].filter(kept), 107: lists.region[107].filter(kept) },
    },
    province: { index: new IntervalIndex('province', new Map()) },
    internalEvents: { region: onDates(variationEvents(graph, details), [DAY]) },
  });
  const regions = deriveFields({
    level: 'region',
    entities: built.entities.region,
    variations: built.variations,
    anomalies: new AnomalyCollector(),
  });
  const at = (code: string, date: IsoDate) => entityAt(regions, code, date);

  it('the ESCT rows of pfun 106 are explained by act 6107: no nk: variation', () => {
    const esct = [...lists.region[106]].filter((r) => kept(r) && r.event === 'ESCT');
    expect(esct.map((r) => [r.code, r.related?.code])).toEqual(
      expect.arrayContaining([
        ['01', '02'],
        ['05', '06'],
      ]),
    );
    expect(built.variations.map((v) => v.istatActId)).toEqual([6107]);
    const explained = built.variationAnomalies.list().filter((a) => a.code === 'link-explained-by-act');
    expect(explained.map((a) => a.context.count)).toEqual([2]);
    expect(accountViolations(built)).toEqual([]);
    expect(variationPropertyViolations(built)).toEqual([]);
    expect(
      [...built.identityAnomalies.list(), ...built.variationAnomalies.list()].filter((a) => a.level === 'blocking'),
    ).toEqual([]);
  });

  it("Valle d'Aosta has one predecessor, Friuli-Venezia Giulia two, none duplicated", () => {
    const piemonte = at('01', '1947-12-31').id;
    const veneto = at('05', '1947-12-31').id;
    const veneziaGiulia = at('83', '1947-12-31').id;
    expect(at('02', DAY).predecessors).toEqual([{ id: piemonte, kind: 'detached_into', date: DAY }]);
    expect(at('06', DAY).predecessors).toEqual(
      [
        { id: veneto, kind: 'detached_into', date: DAY },
        { id: veneziaGiulia, kind: 'merged_into', date: DAY },
      ].sort((a, b) => cmp(a.id, b.id)),
    );
  });
});

describe('golden-20: Caserta, suppressed in 1927 and reconstituted in 1945', async () => {
  const built = await fixtureWorld(['1927-01-11', '1927-01-12', '1945-08-31', '1945-09-01'], {
    codes: { region: ['13', '15'], province: ['061', '062', '063', '070'], municipality: [] },
    provinces: {
      graph: await utsGraph([
        ['061', 'province', '061_1_caserta.json'],
        ['062', 'province', '062_1_benevento.json'],
        ['063', 'province', '063_1_napoli.json'],
        ['070', 'province', '070_1_campobasso.json'],
      ]),
      details: ['35_CS_5390.json', '43_CECS_5390.json', '36_CECS_5390.json', '37_CECS_5390.json'],
    },
  });
  const at = (code: string, date: IsoDate) => entityAt(built.entities.province, code, date);
  const caserta = at('061', '1945-09-01');
  const anomalies = [...built.identityAnomalies.list(), ...built.anomalies.list(), ...built.variationAnomalies.list()];

  it('is one entity (origin 35) with an uncovered period, like Sassofeltrio', () => {
    expect(caserta.istatOriginId).toBe(35);
    expect(at('061', '1927-01-11').id).toBe(caserta.id);
    expect(caserta.versions.map((v) => [v.validFrom, v.validTo, v.officialName])).toEqual([
      ['1927-01-11', '1927-01-12', 'Caserta'],
      ['1945-09-01', null, 'Caserta'],
    ]);
  });

  it('ignores Caserta among the associated territories of its own establishment (act 5390)', () => {
    expect(anomalies.filter((a) => a.code === 'self-reference-ignored').map((a) => [a.level, a.context])).toEqual([
      [
        'info',
        {
          count: 1,
          items: [
            expect.objectContaining({ level: 'province', event: 'CS', date: '1945-09-01', code: '061', actId: 5390 }),
          ],
        },
      ],
    ]);
    expect(anomalies.filter((a) => a.code === 'code-unresolved' && a.context.code === '061')).toEqual([]);
    const variation = variationOf(built, 'province', caserta.id, '1945-09-01');
    expect(variation.istatActId).toBe(5390);
    expect(links(variation).filter(([, to]) => to === caserta.id)).toEqual(
      ['062', '063', '070']
        .map((code): [string, string, string] => [at(code, '1945-09-01').id, caserta.id, 'detached_into'])
        .sort((a, b) => cmp(a[0], b[0])),
    );
    expect(links(variation).some(([from, to]) => from === to)).toBe(false);
  });
});

describe('golden-21: Riola Sardo, two acts of the same day and event (1946-02-07)', async () => {
  const dates: IsoDate[] = ['1946-02-06', '1946-02-07'];
  const world = async (details: string[]) =>
    fixtureWorld(dates, {
      codes: { region: false, province: false, municipality: ['092092', '092014', '092074'] },
      municipalities: await municipalityGraph(['092092_riola-sardo.json']),
      municipalityDetails: details,
    });
  const built = await world(['7543_CECS_5831.json', '7543_CECS_5841.json']);
  const at = (code: string, date: IsoDate) => entityAt(built.entities.municipality, code, date);

  it('each CECS row of Riola Sardo joins the act whose r9 details list its related territory', () => {
    const riola = at('092092', '1946-02-06');
    const ceded = built.variations
      .filter((v) => v.participants.some((p) => p.entityId === riola.id && p.istatEvents.includes('CECS')))
      .map((v) => [v.istatActId, links(v)]);
    expect(ceded).toEqual([
      [5831, [[riola.id, at('092014', '1946-02-07').id, 'detached_into']]],
      [5841, [[riola.id, at('092074', '1946-02-07').id, 'detached_into']]],
    ]);
    expect(built.variationAnomalies.list().map((a) => a.code)).not.toContain('variation-act-ambiguous');
  });

  it('without the r9 details the ambiguity stays a warning', async () => {
    const ambiguous = (await world([])).variationAnomalies.list().filter((a) => a.code === 'variation-act-ambiguous');
    expect(ambiguous.map((a) => a.level)).toEqual(['warning', 'warning']);
  });
});

describe('golden-4: Sardinia 2026', async () => {
  const dates: IsoDate[] = ['2025-12-31', '2026-01-01'];
  const built = await fixtureWorld(dates, {
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
  const participant = (level: Level, entityId: string) =>
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
      successors.sort(cmp).map((id) => [id, 'merged_into']),
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
      versionBefore: before?.validFrom,
      versionAfter: after?.validFrom,
    });
    const alghero = entityAt(built.entities.municipality, '112001', '2026-01-01');
    expect(variationOf(built, 'municipality', alghero.id, '2026-01-01').participants).toEqual([
      expect.objectContaining({ istatEvents: ['RNAPUTS'], role: 'changed' }),
    ]);
    expectComplete(built);
  });
});

describe('golden-6: same-day suppressions', async () => {
  const built = await fixtureWorld(['1927-01-11', '1927-01-12']);
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
    expect(roles(variation)).toEqual(
      [
        ...suppressed.map((e): [Level, string, string[], string] => ['municipality', e.id, ['ES'], 'suppressed']),
        ['municipality', finaleLigure.id, ['CS'], 'established'],
      ].sort((a, b) => cmp(a[1] as string, b[1] as string)),
    );
    expect(links(variation)).toEqual(
      suppressed.map((e) => [e.id, finaleLigure.id, 'merged_into']).sort((a, b) => cmp(a[0] ?? '', b[0] ?? '')),
    );
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
  const built = await fixtureWorld(['1936-06-03', '1936-06-04'], { codes: { region: false, province: false } });

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
  const built = await fixtureWorld(['1947-09-15', '1947-09-16']);
  const at = (code: string, date: IsoDate) => entityAt(built.entities.municipality, code, date);
  const participantOf = (entityId: string) =>
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
        versionBefore: null,
        versionAfter: null,
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
      ].sort((a, b) => cmp(a[0] ?? '', b[0] ?? '')),
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
      expectComplete(await fixtureWorld(dates));
    });
  }
});

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
