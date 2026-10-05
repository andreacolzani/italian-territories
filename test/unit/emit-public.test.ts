import { describe, expect, it } from 'vitest';
import { EmitError, toPublicAnomalies, toPublicData } from '../../src/emit/index.ts';
import { PUBLIC_FILE_MODELS } from '../../src/model/json-schema.ts';
import { at, baseline, entityOf, mut, participant, variationOf, versionOf } from '../helpers/invariants.ts';

const world = baseline;

describe('internal → public model (§4, §6.12)', () => {
  it('converts the baseline world into files valid against the public models', () => {
    const data = toPublicData(world());
    expect(PUBLIC_FILE_MODELS.regions.safeParse(data.regions).success).toBe(true);
    expect(PUBLIC_FILE_MODELS.provinces.safeParse(data.provinces).success).toBe(true);
    expect(PUBLIC_FILE_MODELS.municipalities.safeParse(data.municipalities).success).toBe(true);
    expect(PUBLIC_FILE_MODELS.variations.safeParse(data.variations).success).toBe(true);
  });

  it('publishes inclusive ends, snake_case keys in the published order and no internal-only field', () => {
    const data = toPublicData(world());
    const alfa = at(data.municipalities);
    expect(Object.keys(alfa)).toEqual([
      'id',
      'istat_origin_id',
      'status',
      'is_former_italian',
      'predecessors',
      'successors',
      'current_successors',
      'versions',
    ]);
    expect(alfa.versions).toEqual([
      {
        id: 1,
        valid_from: '1861-03-17',
        valid_until: '1949-12-31',
        istat_code: '001001',
        cadastral_code: 'A001',
        official_name: 'Alfa',
        italian_name: 'Alfa',
        foreign_name: null,
        province_id: 1,
        region_id: 1,
      },
      expect.objectContaining({ id: 2, valid_from: '1950-01-01', valid_until: null }),
    ]);
    expect(Object.keys(at(alfa.versions))).toEqual([
      'id',
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
      'id',
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
    const gamma = at(data.municipalities, 1);
    expect(gamma).toMatchObject({
      status: 'suppressed',
      successors: [{ id: 1, kind: 'merged_into', date: '1900-01-01', variation_id: 1 }],
      current_successors: [1],
    });
  });

  it('sorts entities, versions, participants, links and events, whatever the input order', () => {
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
    expect(data.municipalities.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(at(data.municipalities).versions.map((v) => v.id)).toEqual([1, 2]);
    expect(data.variations.map((v) => v.id)).toEqual([1, 2]);
    const variation = at(data.variations);
    expect(variation.participants.map((p) => p.territory_id)).toEqual([1, 2, 4]);
    expect(variation.links.map((l) => `${l.from}→${l.to}`)).toEqual(['2→1', '4→1']);
    expect(variation.participants.find((p) => p.territory_id === 4)?.istat_events).toEqual(['AS', 'ES']);
  });

  it('drops participations without effect and orders participants by level first', () => {
    const w = world();
    const v2 = variationOf(w, 2);
    v2.participants.push(participant(3, null, ['AP'], null, null));
    v2.participants.push(participant(1, 'indirect', [], 1, 1, { level: 'province' }));
    const variation = at(toPublicData(w).variations, 1);
    expect(variation.participants.map((p) => `${p.level}:${p.territory_id}`)).toEqual(['province:1', 'municipality:1']);
  });

  it('refuses undetermined fields (Step 10) and variations without any effect', () => {
    const nullAbbreviation = world();
    versionOf(nullAbbreviation, 'province', 1, 1).abbreviation = null;
    expect(() => toPublicData(nullAbbreviation)).toThrow(EmitError);

    const nullProvince = world();
    versionOf(nullProvince, 'municipality', 4, 5).provinceId = null;
    expect(() => toPublicData(nullProvince)).toThrow(/province_id is undetermined/);

    const nullRegion = world();
    versionOf(nullRegion, 'province', 2, 2).regionId = null;
    expect(() => toPublicData(nullRegion)).toThrow(/region_id/);

    const noEffect = world();
    at(variationOf(noEffect, 2).participants).role = null;
    expect(() => toPublicData(noEffect)).toThrow(/no participation with effect/);
  });
});

describe('published anomalies (§8.2)', () => {
  const info = { level: 'info' as const, code: 'b-code', message: 'm', context: { x: 1 } };
  const warning = { level: 'warning' as const, code: 'z-code', message: 'm', context: {} };

  it('sorts warnings before infos, then by code and content', () => {
    const other = { ...info, code: 'a-code' };
    const later = { ...info, context: { x: 2 } };
    expect(toPublicAnomalies([later, info, warning, other])).toEqual([warning, other, info, later]);
  });

  it('reduces contexts to plain JSON', () => {
    const [anomaly] = toPublicAnomalies([{ ...info, context: { x: undefined, y: 1 } }]);
    expect(anomaly?.context).toEqual({ y: 1 });
    expect(Object.keys(anomaly?.context ?? {})).toEqual(['y']);
  });

  it('refuses blocking anomalies: a blocking run never publishes', () => {
    expect(() => toPublicAnomalies([info, { ...info, level: 'blocking' }])).toThrow(EmitError);
  });
});
