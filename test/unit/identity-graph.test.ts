import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { canonicalJson } from '../../src/http/index.ts';
import {
  buildIdentityGraph,
  IDENTITY_ANOMALIES,
  type IdentityGraph,
  type IdentitySource,
} from '../../src/identity/index.ts';
import type {
  InternalMunicipalityEvent,
  InternalRegionEvent,
  InternalUtsEvent,
  UtsListRecord,
} from '../../src/sources/situas-internal/index.ts';
import { decodedRows } from '../helpers/internal.ts';

const utsList = await decodedRows('utsList', 'r2-uts-list/all.json');

function listedUts(code: string, type: UtsListRecord['type']): UtsListRecord {
  const record = utsList.find((r) => r.code === code && r.type === type);
  if (record === undefined) throw new Error(`UTS ${code} (${type}) not listed by r2`);
  return record;
}

async function utsSource(code: string, type: UtsListRecord['type'], fixture?: string) {
  const listed = listedUts(code, type);
  const events = fixture === undefined ? [] : await decodedRows('utsEvents', `r5-uts-events/${fixture}`);
  return { listed, events };
}

function utsGraph(sources: IdentitySource<InternalUtsEvent>[], anomalies = new AnomalyCollector()) {
  return buildIdentityGraph<InternalUtsEvent>({
    level: 'province',
    sources,
    pointer: (e) => ({ id: e.utsId, originId: e.originId }),
    record: (e) => ({ id: e.utsId, code: e.code, name: e.name, type: e.type }),
    date: (e) => e.date,
    eventKey: canonicalJson,
    anomalies,
  });
}

function componentOf<E>(graph: IdentityGraph<E>, id: number) {
  const component = graph.byId.get(id);
  if (component === undefined) throw new Error(`no component for ${id}`);
  return component;
}

describe('identity graph on real UTS fixtures (§5.1)', async () => {
  const cagliari318 = await utsSource('318', 'metropolitan_city', '318_3_cagliari.json');
  const sources = [
    await utsSource('015', 'province', '015_1_milano.json'),
    await utsSource('215', 'metropolitan_city', '215_3_milano.json'),
    await utsSource('090', 'province', '090_1_sassari.json'),
    await utsSource('312', 'metropolitan_city', '312_3_sassari.json'),
    await utsSource('092', 'province', '092_1_cagliari.json'),
    cagliari318,
    // r5 under the older code of the same `id_uts` returns the same rows (verified on 292 and
    // 091): the graph merges them.
    { listed: listedUts('292', 'metropolitan_city'), events: cagliari318.events },
    await utsSource('111', 'province', '111_1_sud-sardegna.json'),
    await utsSource('114', 'province', '114_1_nuoro.json'),
    await utsSource('116', 'province', '116_1_ogliastra.json'),
    await utsSource('117', 'province', '117_1_medio-campidano.json'),
    await utsSource('119', 'province', '119_1_sulcis-iglesiente.json'),
    // The 2005–2016 homonyms, listed only.
    await utsSource('105', 'province'),
    await utsSource('106', 'province'),
  ];
  const anomalies = new AnomalyCollector();
  const graph = utsGraph(sources, anomalies);

  it('joins Milano, Cagliari and Sassari across type changes (roots 9, 59, 58)', () => {
    expect(componentOf(graph, 119)).toMatchObject({ root: 9, ids: [9, 119] });
    expect(componentOf(graph, 127)).toMatchObject({ root: 59, ids: [59, 127] });
    expect(componentOf(graph, 143)).toMatchObject({ root: 58, ids: [58, 143] });
  });

  it('keeps Ogliastra and Medio Campidano 2026 apart from their homonyms and from each other', () => {
    expect(componentOf(graph, 146)).toMatchObject({ root: 146, ids: [146] });
    expect(componentOf(graph, 144)).toMatchObject({ root: 144, ids: [144] });
    expect(componentOf(graph, 111)).toMatchObject({ root: 111, ids: [111] });
    expect(componentOf(graph, 112)).toMatchObject({ root: 112, ids: [112] });
    expect(componentOf(graph, 126)).toMatchObject({ root: 126, ids: [126] });
  });

  it('keeps Nuoro one entity across the 2026 renumbering (RN keeps id_uts)', () => {
    const nuoro = componentOf(graph, 95);
    expect(nuoro.ids).toEqual([95]);
    expect(nuoro.records.map((r) => r.code)).toEqual(['091', '114']);
  });

  it('merges the history of every typed record without duplicates, by date then event key', () => {
    const cagliari = componentOf(graph, 59);
    expect(cagliari.events.map((e) => `${e.date} ${e.event} ${e.code}`)).toEqual([
      '1861-03-17 PV 092',
      '1927-01-12 CECS 092',
      '1974-08-20 CECS 092',
      '2006-01-01 CECS 092',
      '2006-01-01 CECS 092',
      '2006-01-01 AQ 092',
      '2016-04-28 ESCT 092',
      '2016-04-28 CSCT 292',
      '2026-01-01 AQES 318',
      '2026-01-01 RN 318',
    ]);
    expect(cagliari.records).toEqual([
      { id: 59, code: '092', name: 'Cagliari', type: 'province' },
      { id: 127, code: '292', name: 'Cagliari', type: 'metropolitan_city' },
      { id: 127, code: '318', name: 'Cagliari', type: 'metropolitan_city' },
    ]);
  });

  it('reports nothing on consistent data', () => {
    expect(anomalies.list()).toEqual([]);
  });

  it('does not depend on the order of the sources', () => {
    const reversed = utsGraph([...sources].reverse());
    expect(reversed.components).toEqual(graph.components);
  });
});

describe('identity graph on real region and municipality fixtures', () => {
  it('Piemonte compartment and region are one entity (origin 14)', async () => {
    const regionList = await decodedRows('regionList', 'r1-region-list/all.json');
    const piemonte = regionList.filter((r) => r.name === 'Piemonte');
    const files = { compartment: '01_1_piemonte.json', region: '01_2_piemonte.json' } as const;
    const sources = await Promise.all(
      piemonte.map(async (listed) => ({
        listed,
        events: await decodedRows('regionEvents', `r4-region-events/${files[listed.type]}`),
      })),
    );
    const graph = buildIdentityGraph<InternalRegionEvent>({
      level: 'region',
      sources,
      pointer: (e) => ({ id: e.originId, originId: e.originId }),
      record: (e) => ({ id: e.originId, code: e.code, name: e.name, type: e.type }),
      date: (e) => e.date,
      eventKey: canonicalJson,
      anomalies: new AnomalyCollector(),
    });
    expect(graph.components).toHaveLength(1);
    expect(graph.components[0]).toMatchObject({ root: 14, ids: [14] });
    expect(graph.components[0]?.events.map((e) => e.event)).toEqual(['CS', 'AQ', 'AQ', 'CE', 'CSCT', 'ES']);
  });

  it('Sassofeltrio is a single component whatever pair is queried (origin 4450)', async () => {
    const events = await decodedRows('municipalityEvents', 'r6-municipality-events/099031_sassofeltrio.json');
    const graph = buildIdentityGraph<InternalMunicipalityEvent>({
      level: 'municipality',
      sources: [
        { listed: { code: '099031', name: 'Sassofeltrio', type: null, originId: null }, events },
        { listed: { code: '041060', name: 'Sassofeltrio', type: null, originId: null }, events },
      ],
      pointer: (e) => ({ id: e.originId, originId: e.originId }),
      record: (e) => ({ id: e.originId, code: e.code, name: e.name, type: null }),
      date: (e) => e.date,
      eventKey: canonicalJson,
      anomalies: new AnomalyCollector(),
    });
    expect(graph.components).toHaveLength(1);
    const [sassofeltrio] = graph.components;
    expect(sassofeltrio).toMatchObject({ root: 4450, ids: [4450] });
    expect(sassofeltrio?.events.map((e) => `${e.date} ${e.event}`)).toEqual([
      '1861-03-17 PV',
      '1929-05-14 ES',
      '1947-11-25 CS',
      '2021-06-17 AP',
    ]);
    expect(sassofeltrio?.records.map((r) => r.code)).toEqual(['041060', '099031']);
  });
});

describe('identity graph anomalies', () => {
  interface E {
    id: number;
    originId: number;
    date: string;
  }

  function graph(sources: IdentitySource<E>[]) {
    const anomalies = new AnomalyCollector();
    const result = buildIdentityGraph<E>({
      level: 'province',
      sources,
      pointer: (e) => e,
      record: (e) => ({ id: e.id, code: String(e.id).padStart(3, '0'), name: `UTS ${e.id}`, type: 'province' }),
      date: (e) => e.date,
      eventKey: canonicalJson,
      anomalies,
    });
    return { result, anomalies: anomalies.list() };
  }

  const listed = (code: string, originId: number | null = null) => ({
    code,
    name: `UTS ${code}`,
    type: 'province' as const,
    originId,
  });

  it('blocks a component with two ends of the origin chain and falls back to the oldest record', () => {
    const { result, anomalies } = graph([
      {
        listed: listed('001'),
        events: [
          { id: 1, originId: 1, date: '1900-01-01' },
          { id: 2, originId: 2, date: '1861-03-17' },
          { id: 3, originId: 1, date: '1950-01-01' },
          { id: 3, originId: 2, date: '1950-01-01' },
        ],
      },
    ]);
    expect(result.components).toHaveLength(1);
    expect(result.components[0]).toMatchObject({ root: 2, ids: [1, 2, 3] });
    expect(anomalies).toMatchObject([
      { level: 'blocking', code: IDENTITY_ANOMALIES.ambiguousRoot, context: { chain_ends: [1, 2], root: 2 } },
    ]);
  });

  it('blocks a chain whose end is not the oldest record', () => {
    const { result, anomalies } = graph([
      {
        listed: listed('005'),
        events: [
          { id: 5, originId: 5, date: '2000-01-01' },
          { id: 6, originId: 5, date: '1990-01-01' },
        ],
      },
    ]);
    expect(result.components[0]?.root).toBe(6);
    expect(anomalies).toMatchObject([
      { level: 'blocking', code: IDENTITY_ANOMALIES.ambiguousRoot, context: { chain_ends: [5], oldest: [6] } },
    ]);
  });

  it('blocks a listed record whose origin id is not in the component of its events', () => {
    const { anomalies } = graph([{ listed: listed('005', 99), events: [{ id: 5, originId: 5, date: '2000-01-01' }] }]);
    expect(anomalies).toMatchObject([{ level: 'blocking', code: IDENTITY_ANOMALIES.inconsistentRecord }]);
  });
});
