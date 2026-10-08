/**
 * Derived fields on real SITUAS fixtures (§7, Step 13): the Quero → Quero Vas → Setteville chain,
 * Sud Sardegna split into several successors (golden-4), Fiume (golden-9), partial cessions abroad
 * (golden-18), Tenda (golden-19) and Sassofeltrio active after a gap (golden-2).
 *
 * The worlds are those of the variation tests (`fixtureWorld`); worlds of non-consecutive dates are
 * reduced to the codes of the case.
 */
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { deriveFields, type DerivedEntity } from '../../src/derive/index.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { LEVELS, type Level } from '../../src/model/common.ts';
import type { EntityByLevel } from '../../src/model/internal.ts';
import { municipalityGraph, utsGraph } from '../helpers/identity.ts';
import { fixtureWorld, type BuiltVariations } from '../helpers/variations.ts';
import { entityAt } from '../helpers/versions.ts';

type DerivedWorld = { [L in Level]: DerivedEntity<EntityByLevel[L]>[] };

/** The derived fields of every level; the derivation reports nothing on these worlds. */
function derive(built: BuiltVariations): DerivedWorld {
  const anomalies = new AnomalyCollector();
  const { entities, variations } = built;
  const world = {
    region: deriveFields({ level: 'region', entities: entities.region, variations, anomalies }),
    province: deriveFields({ level: 'province', entities: entities.province, variations, anomalies }),
    municipality: deriveFields({ level: 'municipality', entities: entities.municipality, variations, anomalies }),
  };
  expect(anomalies.list()).toEqual([]);
  return world;
}

/** I11 (second part): every suppressed entity that is not former Italian has current successors. */
function withoutCurrentSuccessors(world: DerivedWorld): string[] {
  return LEVELS.flatMap((level) =>
    world[level]
      .filter((e) => e.status === 'suppressed' && !e.isFormerItalian && e.currentSuccessors.length === 0)
      .map((e) => `${level} ${e.id} (${e.versions.at(-1)?.istatCode})`),
  );
}

const ascending = (ids: string[]) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe('Quero → Quero Vas → Setteville', async () => {
  const built = await fixtureWorld(['2013-12-27', '2013-12-28', '2024-01-21', '2024-01-22'], {
    codes: { region: false, province: false, municipality: ['025042', '025064', '025070', '025002', '025075'] },
    municipalities: await municipalityGraph([
      '025042_quero.json',
      '025064_vas.json',
      '025070_quero-vas.json',
      '025002_alano-di-piave.json',
      '025075_setteville.json',
    ]),
  });
  const world = derive(built);
  const at = (code: string, date: IsoDate) => entityAt(world.municipality, code, date);
  const quero = at('025042', '2013-12-27');
  const vas = at('025064', '2013-12-27');
  const queroVas = at('025070', '2013-12-28');
  const alano = at('025002', '2024-01-21');
  const setteville = at('025075', '2024-01-22');

  it('Quero is merged into Quero Vas; its current successor is Setteville', () => {
    const merger = built.variations.find((v) => v.istatActId === 5964);
    expect(merger?.date).toBe('2013-12-28');
    expect(quero).toMatchObject({
      status: 'suppressed',
      isFormerItalian: false,
      successors: [{ id: queroVas.id, kind: 'merged_into', date: '2013-12-28' }],
      currentSuccessors: [setteville.id],
    });
    expect(vas.currentSuccessors).toEqual([setteville.id]);
  });

  it('Quero Vas comes from Quero and Vas and resolves to Setteville', () => {
    expect(queroVas.status).toBe('suppressed');
    expect(queroVas.predecessors.map((l) => [l.id, l.kind, l.date])).toEqual(
      ascending([quero.id, vas.id]).map((id) => [id, 'merged_into', '2013-12-28']),
    );
    expect(queroVas.successors.map((l) => [l.id, l.kind, l.date])).toEqual([
      [setteville.id, 'merged_into', '2024-01-22'],
    ]);
    expect(queroVas.currentSuccessors).toEqual([setteville.id]);
  });

  it('Setteville is active, with Alano di Piave and Quero Vas as predecessors', () => {
    expect(setteville).toMatchObject({ status: 'active', isFormerItalian: false, successors: [] });
    expect(setteville.currentSuccessors).toEqual([]);
    expect(setteville.predecessors.map((l) => l.id)).toEqual(ascending([alano.id, queroVas.id]));
    expect(withoutCurrentSuccessors(world)).toEqual([]);
  });
});

describe('Sud Sardegna with several successors (golden-4)', async () => {
  const built = await fixtureWorld(['2025-12-31', '2026-01-01'], {
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
  const world = derive(built);
  const uts = (code: string) => entityAt(world.province, code, '2026-01-01');
  const sudSardegna = entityAt(world.province, '111', '2025-12-31');

  it('suppressed, split into Nuoro, Ogliastra, Medio Campidano, Sulcis Iglesiente and Cagliari', () => {
    const successors = ascending(['114', '116', '117', '119', '318'].map((code) => uts(code).id));
    expect(sudSardegna).toMatchObject({ status: 'suppressed', isFormerItalian: false, partiallyCeded: false });
    expect(sudSardegna.successors).toEqual(successors.map((id) => ({ id, kind: 'split_into', date: '2026-01-01' })));
    expect(sudSardegna.currentSuccessors).toEqual(successors);
  });

  it('the entities renumbered or changed in type stay active without predecessors', () => {
    for (const code of ['114', '115', '312', '318']) {
      expect(uts(code)).toMatchObject({ status: 'active', successors: [], currentSuccessors: [], predecessors: [] });
    }
  });

  it('a new province lists the entities it was detached from or merged from', () => {
    const ogliastra = uts('116');
    expect(ogliastra.predecessors.map((l) => [l.id, l.kind])).toContainEqual([uts('114').id, 'detached_into']);
    expect(ogliastra.predecessors.map((l) => [l.id, l.kind])).toContainEqual([sudSardegna.id, 'split_into']);
    expect(withoutCurrentSuccessors(world)).toEqual([]);
  });
});

describe('the cessions of 1947-09-16 (golden 9, 18, 19)', async () => {
  const world = derive(await fixtureWorld(['1947-09-15', '1947-09-16']));
  const at = (code: string, date: IsoDate) => entityAt(world.municipality, code, date);

  it('golden-9: Fiume is former Italian, without current successors', () => {
    expect(at('701706', '1947-09-15')).toMatchObject({
      status: 'suppressed',
      isFormerItalian: true,
      successors: [],
      currentSuccessors: [],
    });
  });

  it('golden-18: municipalities with a partial cession abroad are not former Italian', () => {
    for (const code of ['031007', '032006', '001022']) {
      expect(at(code, '1947-09-16')).toMatchObject({ status: 'active', isFormerItalian: false, successors: [] });
    }
  });

  it('golden-19: Tenda is former Italian; its current successors are Briga Alta and Limone Piemonte', () => {
    const tenda = at('004820', '1947-09-15');
    const brigaAlta = at('004031', '1947-09-16');
    const limone = at('004110', '1947-09-16');
    expect(tenda).toMatchObject({ status: 'suppressed', isFormerItalian: true, partiallyCeded: false });
    expect(tenda.successors.map((l) => [l.id, l.kind])).toEqual(
      ascending([brigaAlta.id, limone.id]).map((id) => [id, 'split_into']),
    );
    expect(tenda.currentSuccessors).toEqual(ascending([brigaAlta.id, limone.id]));
    expect(brigaAlta.predecessors.map((l) => [l.id, l.kind])).toContainEqual([tenda.id, 'split_into']);
  });

  it('every municipality ceded abroad is former Italian; nothing else is suppressed without successors', () => {
    const ceded = world.municipality.filter((e) => e.status === 'suppressed' && e.isFormerItalian);
    expect(ceded).toHaveLength(107);
    expect(withoutCurrentSuccessors(world)).toEqual([]);
  });
});

describe('Sassofeltrio active after a gap (golden-2)', async () => {
  const world = derive(
    await fixtureWorld(['1929-05-13', '1929-05-14', '1947-11-24', '1947-11-25', '2021-06-16', '2021-06-17'], {
      codes: { region: ['08', '11'], province: ['041', '099'], municipality: ['041060', '099031', '041035', '041026'] },
      municipalities: await municipalityGraph(['099031_sassofeltrio.json']),
    }),
  );

  it('the 1929 suppression is ignored: active, no successors', () => {
    const sassofeltrio = entityAt(world.municipality, '099031', '2021-06-17');
    expect(sassofeltrio.versions[0]?.validTo).toBe('1929-05-14');
    expect(sassofeltrio).toMatchObject({
      status: 'active',
      isFormerItalian: false,
      successors: [],
      currentSuccessors: [],
      predecessors: [],
    });
  });
});
