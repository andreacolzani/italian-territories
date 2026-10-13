import { describe, expect, it } from 'vitest';
import { EmitError, toPublicData, toReportAnomalies, toReportVariations } from '../../src/emit/index.ts';
import { PUBLIC_FILE_MODELS, REPORT_FILE_MODELS } from '../../src/model/json-schema.ts';
import {
  at,
  baseline,
  entityOf,
  M,
  mut,
  P,
  participant,
  R,
  START,
  variationOf,
  versionOf,
} from '../helpers/invariants.ts';

const world = baseline;

describe('internal → public model (§4, §6.12)', () => {
  it('converts the baseline world into files valid against their models', () => {
    const data = toPublicData(world());
    expect(PUBLIC_FILE_MODELS.regions.safeParse(data.regions).success).toBe(true);
    expect(PUBLIC_FILE_MODELS.provinces.safeParse(data.provinces).success).toBe(true);
    expect(PUBLIC_FILE_MODELS.municipalities.safeParse(data.municipalities).success).toBe(true);
    expect(REPORT_FILE_MODELS.variations.safeParse(toReportVariations(world().variations)).success).toBe(true);
  });

  it('publishes inclusive ends, snake_case keys in the published order and no internal-only field', () => {
    const data = toPublicData(world());
    const alfa = at(data.municipalities);
    expect(Object.keys(alfa)).toEqual([
      'id',
      'status',
      'is_former_italian',
      'predecessors',
      'successors',
      'current_successors',
      'versions',
    ]);
    expect(alfa.versions).toEqual([
      {
        valid_from: '1861-03-17',
        valid_until: '1949-12-31',
        istat_code: '001001',
        cadastral_code: 'A001',
        official_name: 'Alfa',
        italian_name: 'Alfa',
        foreign_name: null,
        province_id: P(1),
        region_id: R(1),
      },
      expect.objectContaining({ valid_from: '1950-01-01', valid_until: null }),
    ]);
    expect(Object.keys(at(alfa.versions))).toEqual([
      'valid_from',
      'valid_until',
      'istat_code',
      'cadastral_code',
      'official_name',
      'italian_name',
      'foreign_name',
      'province_id',
      'region_id',
    ]);
    const province = at(data.provinces);
    expect(Object.keys(at(province.versions))).toEqual([
      'valid_from',
      'valid_until',
      'istat_code',
      'official_name',
      'italian_name',
      'foreign_name',
      'type',
      'abbreviation',
      'region_id',
    ]);
    expect(province).not.toHaveProperty('historicalCodes');
    expect(province).not.toHaveProperty('istat_origin_id');
    const gamma = at(data.municipalities, 1);
    expect(gamma).toMatchObject({
      status: 'suppressed',
      successors: [{ id: M(1), kind: 'merged_into', date: '1900-01-01' }],
      current_successors: [M(1)],
    });
  });

  it('orders entities by internal ISTAT id, nk: entities last by first valid_from then id (§6.12)', () => {
    const w = world();
    // Origin ids unrelated to the entity ids: 4 → 10, 3 → 20, 1 → 300, 2 → nk: (null).
    const origins: Record<number, number | null> = { 1: 300, 2: null, 3: 20, 4: 10 };
    for (const [n, origin] of Object.entries(origins)) entityOf(w, 'municipality', Number(n)).istatOriginId = origin;
    const order = (world: typeof w) => toPublicData(world).municipalities.map((e) => e.id);
    expect(order(w)).toEqual([M(4), M(3), M(1), M(2)]);
    // Numerically, not as text: 300 after 20.
    // Whatever the input order.
    mut(w).entities.municipality.reverse();
    expect(order(w)).toEqual([M(4), M(3), M(1), M(2)]);
    // Unchanged when an ISTAT code changes.
    at(entityOf(w, 'municipality', 4).versions).istatCode = '999999';
    expect(order(w)).toEqual([M(4), M(3), M(1), M(2)]);
    // Several nk: entities: by the valid_from of their first version, then by id.
    entityOf(w, 'municipality', 3).istatOriginId = null;
    at(entityOf(w, 'municipality', 3).versions).validFrom = '1860-01-01';
    entityOf(w, 'municipality', 1).istatOriginId = null;
    expect(order(w)).toEqual([M(4), M(3), M(1), M(2)]);
    at(entityOf(w, 'municipality', 3).versions).validFrom = START;
    expect(order(w)).toEqual([M(4), M(1), M(2), M(3)]);
  });

  it('sorts entities and versions, and the variation report, whatever the input order', () => {
    const w = world();
    const reversed = mut(w);
    reversed.entities.municipality.reverse();
    entityOf(w, 'municipality', 1).versions.reverse();
    const v1 = variationOf(w, 1);
    v1.participants.reverse();
    v1.links.reverse();
    at(v1.participants).istatEvents = ['ES', 'AS'];
    reversed.variations.reverse();
    const data = toPublicData(w);
    expect(data.municipalities.map((e) => e.id)).toEqual([M(1), M(2), M(3), M(4)]);
    expect(at(data.municipalities).versions.map((v) => v.valid_from)).toEqual([START, '1950-01-01']);
    const variations = toReportVariations(w.variations);
    expect(variations.map((v) => v.id)).toEqual([1, 2]);
    const variation = at(variations);
    expect(variation.participants.map((p) => p.territory_id)).toEqual([M(1), M(2), M(4)]);
    expect(variation.links.map((l) => `${l.from}→${l.to}`)).toEqual([`${M(2)}→${M(1)}`, `${M(4)}→${M(1)}`]);
    expect(variation.participants.find((p) => p.territory_id === M(4))).toMatchObject({
      istat_events: ['AS', 'ES'],
      version_before: START,
      version_after: null,
    });
  });

  it('drops participations without effect and orders participants by level first', () => {
    const w = world();
    const v2 = variationOf(w, 2);
    v2.participants.push(participant(3, null, ['AP'], null, null));
    v2.participants.push(participant(P(1), 'indirect', [], START, START, { level: 'province' }));
    const variation = at(toReportVariations(w.variations), 1);
    expect(variation.participants.map((p) => `${p.level}:${p.territory_id}`)).toEqual([
      `province:${P(1)}`,
      `municipality:${M(1)}`,
    ]);
  });

  it('refuses undetermined fields (§6.9, §4.2 names) and variations without any effect', () => {
    const nullAbbreviation = world();
    versionOf(nullAbbreviation, 'province', 1, START).abbreviation = null;
    expect(() => toPublicData(nullAbbreviation)).toThrow(EmitError);

    const nullProvince = world();
    versionOf(nullProvince, 'municipality', 4, START).provinceId = null;
    expect(() => toPublicData(nullProvince)).toThrow(/province_id is undetermined/);

    const nullRegion = world();
    versionOf(nullRegion, 'province', 2, START).regionId = null;
    expect(() => toPublicData(nullRegion)).toThrow(/region_id/);

    const unknownName = world();
    versionOf(unknownName, 'region', 1, START).italianName = null;
    expect(() => toPublicData(unknownName)).toThrow(/italian_name is undetermined/);

    const noEffect = world();
    at(variationOf(noEffect, 2).participants).role = null;
    expect(() => toReportVariations(noEffect.variations)).toThrow(/no participation with effect/);
  });
});

describe('report anomalies (§8.2)', () => {
  const info = { level: 'info' as const, code: 'b-code', message: 'm', context: { x: 1 } };
  const warning = { level: 'warning' as const, code: 'z-code', message: 'm', context: {} };

  it('sorts warnings before infos, then by code and content', () => {
    const other = { ...info, code: 'a-code' };
    const later = { ...info, context: { x: 2 } };
    expect(toReportAnomalies([later, info, warning, other])).toEqual([warning, other, info, later]);
  });

  it('reduces contexts to plain JSON', () => {
    const [anomaly] = toReportAnomalies([{ ...info, context: { x: undefined, y: 1 } }]);
    expect(anomaly?.context).toEqual({ y: 1 });
    expect(Object.keys(anomaly?.context ?? {})).toEqual(['y']);
  });

  it('refuses blocking anomalies: a blocking run never publishes', () => {
    expect(() => toReportAnomalies([info, { ...info, level: 'blocking' }])).toThrow(EmitError);
  });
});
