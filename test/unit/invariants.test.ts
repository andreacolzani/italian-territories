/**
 * Invariants I1–I15 (§8.1, Step 15): a negative test for each, on the crafted world of
 * `test/helpers/invariants.ts`, on which every invariant passes.
 */
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { deriveFields } from '../../src/derive/index.ts';
import {
  assertInvariants,
  checkActive8xxCodes,
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI6,
  checkI7,
  checkI9,
  checkI10,
  checkI11,
  checkI12,
  checkI12Detailed,
  checkI13,
  checkI14,
  checkI15,
  checkInvariants,
  INVARIANT_IDS,
  InvariantViolation,
  MAX_LISTED,
  type InvariantEntities,
} from '../../src/invariants/index.ts';
import type { Anomaly } from '../../src/model/internal.ts';
import {
  baseline,
  at,
  entityOf,
  M,
  municipalityVersion,
  mut,
  P,
  participant,
  R,
  rowsOf,
  snapshotSet,
  START,
  TODAY,
  variationOf,
  versionOf,
  type Baseline,
} from '../helpers/invariants.ts';

const codes = (anomalies: Anomaly[]): string[] => anomalies.map((a) => a.code);
const contexts = (anomalies: Anomaly[]) => anomalies.map((a) => a.context);

async function i12(world: Baseline): Promise<Anomaly[]> {
  return checkI12({
    entities: world.entities,
    historicalCodes: world.historicalCodes,
    overrides: world.overrides,
    snapshots: world.snapshots,
  });
}

describe('the crafted baseline world', () => {
  it('passes every invariant, with every check executed', async () => {
    const world = baseline();
    const anomalies = new AnomalyCollector();
    const report = await checkInvariants(world, anomalies);
    expect(report.results.map((r) => [r.id, r.status])).toEqual(INVARIANT_IDS.map((id) => [id, 'passed']));
    expect(anomalies.list()).toEqual([]);
    expect(() => {
      assertInvariants(report);
    }).not.toThrow();
  });
});

describe('I1: versions are sorted and do not overlap', () => {
  it('rejects unsorted versions', () => {
    const world = baseline();
    mut(entityOf(world, 'municipality', 1).versions).reverse();
    expect(contexts(checkI1(world.entities))).toMatchObject([{ invariant: 'I1', entityId: M(1), problem: 'unsorted' }]);
  });

  it('rejects overlapping versions, an open version followed by another, and an inverted interval', () => {
    const world = baseline();
    versionOf(world, 'municipality', 1, START).validTo = '1960-01-01';
    expect(contexts(checkI1(world.entities))).toMatchObject([
      { entityId: M(1), versionFrom: '1950-01-01', problem: 'overlap' },
    ]);

    const open = baseline();
    versionOf(open, 'municipality', 1, START).validTo = null;
    expect(contexts(checkI1(open.entities))).toMatchObject([{ entityId: M(1), problem: 'overlap' }]);

    const inverted = baseline();
    versionOf(inverted, 'municipality', 2, START).validTo = '1800-01-01';
    expect(contexts(checkI1(inverted.entities))).toMatchObject([
      { entityId: M(2), versionFrom: START, validTo: '1800-01-01' },
    ]);
  });

  it('rejects an entity without versions', () => {
    const world = baseline();
    mut(entityOf(world, 'region', 1)).versions = [];
    expect(checkI1(world.entities).map((a) => a.message)).toEqual([`I1: region entity ${R(1)} has no versions`]);
  });
});

describe('I2: a gap between versions needs an entity absent from the snapshots', () => {
  it('rejects a gap while the entity exists, passes when it does not', () => {
    const world = baseline();
    versionOf(world, 'municipality', 1, '1950-01-01').validFrom = '1951-01-01';
    expect(contexts(checkI2(world.entities, world.existence))).toMatchObject([
      { invariant: 'I2', entityId: M(1), gap: { validFrom: '1950-01-01', validTo: '1951-01-01' } },
    ]);

    world.existence.municipality = new Map(world.existence.municipality).set(M(1), [
      { validFrom: START, validTo: '1950-01-01' },
      { validFrom: '1951-01-01', validTo: null },
    ]);
    expect(checkI2(world.entities, world.existence)).toEqual([]);
  });

  it('rejects a gap of an entity the snapshots know nothing about', () => {
    const world = baseline();
    versionOf(world, 'municipality', 1, '1950-01-01').validFrom = '1951-01-01';
    world.existence.municipality = new Map([...world.existence.municipality].filter(([id]) => id !== M(1)));
    expect(checkI2(world.entities, world.existence).map((a) => a.message)).toEqual([
      expect.stringContaining('cannot be checked'),
    ]);
  });
});

describe('I3: contiguous versions differ in a published field', () => {
  it('rejects contiguous versions with equal fields', () => {
    const world = baseline();
    versionOf(world, 'municipality', 1, '1950-01-01').officialName = 'Alfa';
    versionOf(world, 'municipality', 1, '1950-01-01').italianName = 'Alfa';
    expect(contexts(checkI3(world.entities))).toMatchObject([
      { invariant: 'I3', entityId: M(1), previousVersionFrom: START, versionFrom: '1950-01-01', date: '1950-01-01' },
    ]);
  });

  it('accepts equal versions separated by a gap, and a change of any single field', () => {
    const world = baseline();
    versionOf(world, 'municipality', 1, '1950-01-01').officialName = 'Alfa';
    versionOf(world, 'municipality', 1, '1950-01-01').italianName = 'Alfa';
    versionOf(world, 'municipality', 1, '1950-01-01').validFrom = '1951-01-01';
    expect(checkI3(world.entities)).toEqual([]);

    for (const change of [
      (v: ReturnType<typeof municipalityV>) => (v.cadastralCode = 'A999'),
      (v: ReturnType<typeof municipalityV>) => (v.foreignName = 'Alpha'),
      (v: ReturnType<typeof municipalityV>) => (v.provinceId = P(2)),
      (v: ReturnType<typeof municipalityV>) => (v.regionId = R(2)),
      (v: ReturnType<typeof municipalityV>) => (v.istatCode = '001999'),
    ]) {
      const changed = baseline();
      const next = municipalityV(changed);
      next.officialName = 'Alfa';
      next.italianName = 'Alfa';
      change(next);
      expect(checkI3(changed.entities)).toEqual([]);
    }
  });
});

function municipalityV(world: Baseline) {
  return versionOf(world, 'municipality', 1, '1950-01-01');
}

describe('I4: parents cover the interval of the referencing version', () => {
  it('rejects a reference to no entity, a null reference and an uncovered interval', () => {
    const world = baseline();
    versionOf(world, 'municipality', 3, START).provinceId = P(99);
    versionOf(world, 'municipality', 3, START).regionId = null;
    versionOf(world, 'province', 1, START).regionId = R(99);
    expect(contexts(checkI4(world.entities))).toMatchObject([
      { entityId: P(1), field: 'regionId', target: R(99), level: 'province' },
      { entityId: M(3), field: 'provinceId', target: P(99) },
      { entityId: M(3), field: 'regionId', target: null },
    ]);
    expect(checkI4(world.entities).map((a) => a.message)).toEqual([
      expect.stringContaining('references no region entity'),
      expect.stringContaining('references no province entity'),
      expect.stringContaining('is undetermined'),
    ]);
  });

  it('rejects a parent whose versions leave part of the interval uncovered', () => {
    const world = baseline();
    versionOf(world, 'province', 2, START).validFrom = '1900-01-01';
    expect(contexts(checkI4(world.entities))).toMatchObject([
      { entityId: M(3), field: 'provinceId', uncovered: [{ validFrom: START, validTo: '1900-01-01' }] },
    ]);

    const closed = baseline();
    versionOf(closed, 'region', 1, START).validTo = '2000-01-01';
    expect(checkI4(closed.entities).length).toBeGreaterThan(0);
    expect(checkI4(closed.entities).every((a) => a.context.parentLevel === 'region')).toBe(true);
  });

  it('accepts a parent covered by several contiguous versions', () => {
    const world = baseline();
    const province = entityOf(world, 'province', 2);
    province.versions = [
      { ...at(province.versions), validTo: '1950-01-01' },
      { ...at(province.versions), validFrom: '1950-01-01', officialName: 'Nuova' },
    ];
    expect(checkI4(world.entities)).toEqual([]);
  });
});

describe('I5: a municipality has the region of its province', () => {
  it('rejects a different region over the whole interval or only part of it', () => {
    const world = baseline();
    versionOf(world, 'municipality', 3, START).regionId = R(2);
    expect(contexts(checkI5(world.entities))).toMatchObject([
      {
        invariant: 'I5',
        entityId: M(3),
        regionId: R(2),
        conflicts: [{ validFrom: START, validTo: null, provinceRegionId: R(1) }],
      },
    ]);

    const partial = baseline();
    const province = entityOf(partial, 'province', 2);
    province.versions = [
      { ...at(province.versions), validTo: '1950-01-01' },
      { ...at(province.versions), validFrom: '1950-01-01', regionId: R(2) },
    ];
    expect(contexts(checkI5(partial.entities))).toMatchObject([
      { entityId: M(3), conflicts: [{ validFrom: '1950-01-01', validTo: null, provinceVersionFrom: '1950-01-01' }] },
    ]);
  });

  it('skips versions whose province or region is undetermined', () => {
    const world = baseline();
    versionOf(world, 'municipality', 3, START).regionId = null;
    versionOf(world, 'municipality', 1, '1950-01-01').provinceId = null;
    versionOf(world, 'municipality', 1, '1950-01-01').regionId = R(2);
    expect(checkI5(world.entities)).toEqual([]);
  });
});

describe('I6: per-date uniqueness', () => {
  it('rejects a code, a cadastral code and an abbreviation held by two entities at once', () => {
    const world = baseline();
    versionOf(world, 'municipality', 3, START).istatCode = '001001';
    versionOf(world, 'municipality', 3, START).cadastralCode = 'A001';
    versionOf(world, 'province', 2, START).abbreviation = 'AA';
    expect(contexts(checkI6(world.entities))).toMatchObject([
      { level: 'province', field: 'abbreviation', value: 'AA' },
      {
        level: 'municipality',
        field: 'istat_code',
        value: '001001',
        overlap: { validFrom: START, validTo: '1950-01-01' },
      },
      {
        level: 'municipality',
        field: 'istat_code',
        value: '001001',
        overlap: { validFrom: '1950-01-01', validTo: null },
      },
      { level: 'municipality', field: 'cadastral_code', value: 'A001' },
      { level: 'municipality', field: 'cadastral_code', value: 'A001' },
    ]);
  });

  it('accepts reuse over time and any number of null cadastral codes', () => {
    const world = baseline();
    const reused = {
      level: 'municipality' as const,
      id: M(9),
      istatOriginId: 9,
      versions: [municipalityVersion(['1900-01-01', null], '001002', null, 'Riuso')],
      status: 'active' as const,
      isFormerItalian: false,
      predecessors: [],
      successors: [],
      currentSuccessors: [],
    };
    const entities: InvariantEntities = { ...world.entities, municipality: [...world.entities.municipality, reused] };
    expect(checkI6(entities)).toEqual([]);

    const nulls = { ...reused, id: M(10), versions: [municipalityVersion([START, null], '001003', null, 'Altro')] };
    expect(checkI6({ ...entities, municipality: [...entities.municipality, nulls] })).toEqual([]);
  });
});

describe('I7: the code prefix is the historical code of the UTS', () => {
  it('rejects a prefix that differs at any date (suffix < 800)', () => {
    const world = baseline();
    versionOf(world, 'municipality', 3, START).istatCode = '009001';
    expect(contexts(checkI7(world.entities, world.historicalCodes))).toMatchObject([
      { invariant: 'I7', entityId: M(3), istatCode: '009001', prefix: '009', different: [{ historicalCode: '002' }] },
    ]);
  });

  it('rejects a wrong COD_PROV_STORICO fallback (§3.5 item 16)', () => {
    const world = baseline();
    // The fallback gave the UTS code of 2026 where the municipalities still carry the historical prefix.
    at(mut(at(world.provinceEntities, 1)).versions).istatCode = '318';
    mut(at(world.provinceEntities, 1)).historicalCodes = [{ validFrom: START, validTo: null, value: '318' }];
    const historicalCodes = new Map(world.historicalCodes).set(P(2), at(world.provinceEntities, 1).historicalCodes);
    const found = checkI7(world.entities, historicalCodes);
    expect(codes(found)).toEqual(['invariant-i7']);
    expect(found[0]?.message).toContain(`historical code of its UTS ${P(2)}`);
  });

  it('classifies 8xx codes: prefix of another UTS is info, of no UTS blocking, a mismatch below 800 blocking', () => {
    const another = baseline();
    versionOf(another, 'municipality', 4, START).istatCode = '002801';
    const info = checkI7(another.entities, another.historicalCodes);
    expect(info.map((a) => [a.level, a.code])).toEqual([['info', 'municipality-8xx-prefix-of-another-uts']]);
    expect(info[0]?.context).toMatchObject({ entityId: M(4), versionFrom: START, prefix: '002' });

    const unknown = baseline();
    versionOf(unknown, 'municipality', 4, START).istatCode = '777801';
    expect(checkI7(unknown.entities, unknown.historicalCodes).map((a) => [a.level, a.code])).toEqual([
      ['blocking', 'invariant-i7'],
    ]);

    const low = baseline();
    versionOf(low, 'municipality', 4, START).istatCode = '002799';
    expect(checkI7(low.entities, low.historicalCodes).map((a) => [a.level, a.code])).toEqual([
      ['blocking', 'invariant-i7'],
    ]);
  });

  it('knows the UTS codes of every time, historical ones included, and skips undetermined provinces', () => {
    const world = baseline();
    // 215 was the code of UTS 2 from 1950 only (a metropolitan-city renumbering): a known UTS code.
    const historicalCodes = new Map(world.historicalCodes).set(P(2), [
      { validFrom: START, validTo: '1950-01-01', value: '002' },
      { validFrom: '1950-01-01', validTo: null, value: '215' },
    ]);
    versionOf(world, 'municipality', 4, START).istatCode = '215801';
    const ofM4 = (found: Anomaly[]) => found.filter((a) => a.context.entityId === M(4)).map((a) => a.level);
    expect(ofM4(checkI7(world.entities, historicalCodes))).toEqual(['info']);

    // A version whose province is undetermined is skipped altogether.
    versionOf(world, 'municipality', 3, START).provinceId = null;
    versionOf(world, 'municipality', 3, START).istatCode = '009001';
    expect(checkI7(world.entities, historicalCodes).filter((a) => a.context.entityId === M(3))).toEqual([]);
  });

  it('takes the historical codes of the UTS of the world as UTS codes, and nothing else unless a test adds them', () => {
    const world = baseline();
    versionOf(world, 'municipality', 4, START).istatCode = '215801';
    expect(codes(checkI7(world.entities, world.historicalCodes))).toEqual(['invariant-i7']);
    // A historical code of an entity the world does not list does not count.
    const stray = new Map(world.historicalCodes).set(P(99), [{ validFrom: START, validTo: null, value: '215' }]);
    expect(codes(checkI7(world.entities, stray))).toEqual(['invariant-i7']);
    // The historical code of a UTS of the world does.
    const own = new Map(world.historicalCodes).set(P(2), [{ validFrom: START, validTo: null, value: '215' }]);
    expect(
      checkI7(world.entities, own)
        .filter((a) => a.context.entityId === M(4))
        .map((a) => a.level),
    ).toEqual(['info']);
    // The explicit test parameter adds codes.
    expect(checkI7(world.entities, world.historicalCodes, new Set(['215'])).map((a) => a.level)).toEqual(['info']);
  });

  it('rejects a code that is not six digits', () => {
    const world = baseline();
    versionOf(world, 'municipality', 3, START).istatCode = '2001';
    expect(codes(checkI7(world.entities, world.historicalCodes))).toEqual(['invariant-i7']);
  });
});

describe('D30: an active municipality with an 8xx code is a warning', () => {
  it('warns on the current version of an active municipality only', () => {
    const world = baseline();
    expect(checkActive8xxCodes(world.entities)).toEqual([]);
    versionOf(world, 'municipality', 3, START).istatCode = '002850';
    const found = checkActive8xxCodes(world.entities);
    expect(found.map((a) => [a.level, a.code, a.context.entityId])).toEqual([
      ['warning', 'active-municipality-8xx-code', M(3)],
    ]);
  });
});

describe('I9: every version boundary is referenced by a variation', () => {
  it('passes on the baseline, the first date being exempt', () => {
    const world = baseline();
    expect(checkI9(world)).toEqual([]);
  });

  it('rejects boundaries no variation references', () => {
    const world = baseline();
    mut(world).variations = world.variations.filter((v) => v.id !== 2);
    expect(contexts(checkI9(world))).toMatchObject([
      { entityId: M(1), versionFrom: START, side: 'before', date: '1950-01-01' },
      { entityId: M(1), versionFrom: '1950-01-01', side: 'after', date: '1950-01-01' },
    ]);
  });

  it('rejects references to a missing version or entity, and dates that disagree', () => {
    const world = baseline();
    variationOf(world, 2).participants = [
      participant(1, 'changed', ['RN'], START, '1977-01-01'),
      participant(42, 'changed', ['RN'], START, '1950-01-01'),
    ];
    at(variationOf(world, 1).participants, 1).versionBefore = '1950-01-01';
    const found = checkI9(world);
    expect(found.map((a) => a.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('has no version from 1977-01-01'),
        expect.stringContaining(`municipality entity ${M(42)} does not exist`),
        expect.stringContaining('has no version from 1950-01-01'),
      ]),
    );
  });

  it('rejects a version that does not end or start on the date of the variation', () => {
    const world = baseline();
    variationOf(world, 2).date = '1951-01-01';
    expect(checkI9(world).map((a) => a.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`version from ${START} does not end on 1951-01-01`),
        expect.stringContaining('version from 1950-01-01 does not start on 1951-01-01'),
      ]),
    );
  });

  it('rejects a link to a missing entity', () => {
    const world = baseline();
    at(variationOf(world, 1).links).to = M(77);
    expect(contexts(checkI9(world))).toMatchObject([{ entityId: M(77), link: { from: M(2), to: M(77) } }]);
  });
});

describe('I10: no zero-length versions, no participation without effect', () => {
  it('rejects a zero-length version', () => {
    const world = baseline();
    versionOf(world, 'municipality', 2, START).validTo = START;
    expect(contexts(checkI10(world))).toMatchObject([
      { invariant: 'I10', entityId: M(2), versionFrom: START, date: START },
    ]);
  });

  it('rejects a participant inconsistent with its role, and a variation without any effect', () => {
    const world = baseline();
    variationOf(world, 2).participants = [participant(1, 'changed', ['RN'], START, null)];
    expect(contexts(checkI10(world))).toMatchObject([
      { variationId: 2, entityId: M(1), role: 'changed', problems: ['role changed: version_after is required'] },
    ]);

    const empty = baseline();
    variationOf(empty, 2).participants = [participant(1, null, ['AP'], null, null)];
    expect(checkI10(empty).map((a) => a.message)).toEqual([expect.stringContaining('no participation with effect')]);
  });

  it('accepts no-effect participations next to participations with effect (the emitter drops them)', () => {
    const world = baseline();
    variationOf(world, 1).participants.push(participant(3, null, ['AP'], null, null));
    expect(checkI10(world)).toEqual([]);
  });
});

describe('I11: derived fields are consistent', () => {
  it('rejects a stale status, link list, successor list or former-Italian flag, one violation per field', () => {
    const world = baseline();
    const m2 = entityOf(world, 'municipality', 2);
    m2.status = 'active';
    m2.currentSuccessors = [M(3)];
    m2.isFormerItalian = true;
    m2.successors = [];
    entityOf(world, 'municipality', 1).predecessors = [{ id: M(2), kind: 'split_into', date: '1900-01-01' }];
    expect(contexts(checkI11(world)).map((c) => [c.entityId, c.field])).toEqual([
      [M(1), 'predecessors'],
      [M(2), 'status'],
      [M(2), 'isFormerItalian'],
      [M(2), 'successors'],
      [M(2), 'currentSuccessors'],
    ]);
  });

  it('publishes a merged_into towards several destinations of one date as split_into, on both sides', () => {
    const world = baseline();
    // Municipalities 2 and 4 each merge into 1 alone: merged_into, not split.
    expect(entityOf(world, 'municipality', 2).successors).toEqual([
      { id: M(1), kind: 'merged_into', date: '1900-01-01' },
    ]);
    // Municipality 2 now also merges into 3 on the same date, in another variation.
    const variations = [
      ...world.variations,
      {
        ...at(world.variations),
        id: 3,
        istatActId: 3,
        participants: [participant(3, 'territory_changed', ['AQES'], null, null)],
        links: [{ level: 'municipality' as const, from: M(2), to: M(3), kind: 'merged_into' as const }],
      },
    ];
    const derived = deriveFields({
      level: 'municipality',
      entities: world.entities.municipality,
      variations,
      anomalies: new AnomalyCollector(),
    });
    const of = (id: string) => derived.find((e) => e.id === id);
    expect(of(M(2))?.successors).toEqual([
      { id: M(1), kind: 'split_into', date: '1900-01-01' },
      { id: M(3), kind: 'split_into', date: '1900-01-01' },
    ]);
    expect(of(M(2))?.currentSuccessors).toEqual([M(1), M(3)]);
    expect(of(M(4))?.successors).toEqual([{ id: M(1), kind: 'merged_into', date: '1900-01-01' }]);
  });

  it('rejects current successors on a region or province (D46)', () => {
    const world = baseline();
    expect(entityOf(world, 'region', 1).currentSuccessors).toBeNull();
    entityOf(world, 'province', 2).currentSuccessors = [];
    expect(contexts(checkI11(world)).map((c) => [c.entityId, c.field])).toEqual([[P(2), 'currentSuccessors']]);
  });

  it('rejects a suppressed entity that is not former Italian and has no current successors', () => {
    const world = baseline();
    variationOf(world, 1).links = [];
    const derived = deriveFields({
      level: 'municipality',
      entities: world.entities.municipality,
      variations: world.variations,
      anomalies: new AnomalyCollector(),
    });
    mut(world.entities).municipality = derived;
    const found = checkI11(world);
    expect(contexts(found).map((c) => [c.entityId, c.problem])).toEqual([
      [M(2), 'suppressed-without-successors'],
      [M(4), 'suppressed-without-successors'],
    ]);
  });
});

describe('I12: the reconstruction equals the snapshots', () => {
  it('passes on the baseline snapshots, before and after 1948', async () => {
    expect(await i12(baseline())).toEqual([]);
  });

  it('rejects a changed field, naming the code and the field', async () => {
    const world = baseline();
    versionOf(world, 'municipality', 3, START).cadastralCode = 'B999';
    const found = await i12(world);
    expect(found.length).toBe(world.snapshots.length);
    expect(contexts(found)[0]).toMatchObject({
      invariant: 'I12',
      level: 'municipality',
      date: START,
      total: 1,
      differences: [
        {
          code: '002001',
          kind: 'field',
          entityId: M(3),
          fields: [{ field: 'cadastralCode', snapshot: 'B001', version: 'B999' }],
        },
      ],
    });
  });

  it('rejects a version without row, a row without version and a different count', async () => {
    const world = baseline();
    const set = mut(at(world.snapshots, 2));
    set.rows.municipality = rowsOf(set, 'municipality').filter((r) => r.code !== '002001');
    set.rows.region = [...rowsOf(set, 'region'), { code: '99', name: 'Altra', type: 'region' }];
    const found = await i12(world);
    expect(found.map((a) => a.context.level)).toEqual(['region', 'municipality']);
    expect(contexts(found)).toMatchObject([
      {
        differences: [
          { kind: 'count', rows: 2, versions: 1 },
          { kind: 'no-version', code: '99' },
        ],
      },
      {
        differences: [
          { kind: 'count', rows: 1, versions: 2 },
          { kind: 'no-row', code: '002001', entityId: M(3), versionFrom: START },
        ],
      },
    ]);
  });

  it('rejects the parent codes and the historical code', async () => {
    const world = baseline();
    const set = mut(at(world.snapshots, 2));
    at(rowsOf(set, 'municipality')).utsCode = '009';
    at(rowsOf(set, 'municipality')).regionCode = '09';
    at(rowsOf(set, 'municipality')).historicalUtsCode = '009';
    at(rowsOf(set, 'province')).regionCode = '09';
    at(rowsOf(set, 'province'), 1).historicalCode = '009';
    const found = await i12(world);
    const fields = found.flatMap((a) =>
      (a.context.differences as { fields: { field: string }[] }[]).flatMap((d) => d.fields.map((f) => f.field)),
    );
    expect(fields.sort()).toEqual(['historicalCode', 'historicalUtsCode', 'regionCode', 'regionCode', 'utsCode']);
  });

  it('detects a merge error that alters the abbreviation of a pre-1948 version', async () => {
    const world = baseline();
    // The municipalities of UTS 1 report AA before 1948; the version says otherwise.
    versionOf(world, 'province', 1, START).abbreviation = 'ZZ';
    const found = await i12(world);
    const wrong = contexts(found).filter((c) => c.level === 'province');
    expect(wrong.map((c) => c.date)).toEqual(['1861-03-17', '1900-01-01', '1950-01-01', '1960-01-01', '2020-01-01']);
    expect(wrong[0]).toMatchObject({
      differences: [{ code: '001', fields: [{ field: 'abbreviation', snapshot: 'AA', version: 'ZZ' }] }],
    });
  });

  it('derives a missing pre-1948 abbreviation, and expects null when the municipalities disagree', async () => {
    const world = baseline();
    const set = mut(at(world.snapshots, 0));
    at(rowsOf(set, 'municipality'), 1).utsAbbreviation = 'XX';
    // Municipalities 1 and 2 are both in UTS 1 and now report AA and XX: not unanimous.
    const found = await i12(world);
    expect(contexts(found).map((c) => [c.level, c.date])).toEqual([['province', START]]);
    expect(contexts(found)[0]).toMatchObject({ differences: [{ fields: [{ snapshot: null, version: 'AA' }] }] });

    versionOf(world, 'province', 1, START).abbreviation = null;
    expect(contexts(await i12(world)).filter((c) => c.date === START)).toEqual([]);
  });

  it('expects the value of the override applied to a version, whatever the snapshot says', async () => {
    const world = baseline();
    // ISTAT reports a full name; the published value is the override's.
    versionOf(world, 'province', 1, START).abbreviation = 'VG';
    for (const set of mut(world.snapshots)) {
      for (const row of set.rows.province ?? [])
        if (row.code === '001' && row.abbreviation !== null) row.abbreviation = 'Venezia';
      for (const row of set.rows.municipality ?? []) if (row.utsCode === '001') row.utsAbbreviation = 'Venezia';
    }
    expect((await i12(world)).length).toBeGreaterThan(0);

    const override = {
      key: 'uts-1-abbreviation',
      entityId: P(1),
      validFrom: START,
      validTo: null,
      field: 'abbreviation' as const,
      before: 'Venezia',
      after: 'VG',
    };
    world.overrides.push(override);
    expect(await i12(world)).toEqual([]);

    // An override for another version of the entity does not apply to this one.
    world.overrides[0] = { ...override, validFrom: '1900-01-01' };
    expect((await i12(world)).length).toBeGreaterThan(0);
  });

  it('lists at most MAX_LISTED differences per level and date, with the total', async () => {
    const world = baseline();
    const set = mut(at(world.snapshots, 0));
    set.rows.municipality = Array.from({ length: MAX_LISTED + 5 }, (_, i) => ({
      ...at(snapshotSet(world.entities, START).rows.municipality),
      code: `00${i + 1}999`.padStart(6, '0'),
    }));
    const found = (await i12(world)).filter((a) => a.context.level === 'municipality');
    expect(found).toHaveLength(1);
    const context = found[0]?.context as { total: number; differences: unknown[] };
    expect(context.differences).toHaveLength(MAX_LISTED);
    expect(context.total).toBeGreaterThan(MAX_LISTED);
  });

  it('skips a level absent from a set, and accepts an async source', async () => {
    const world = baseline();
    const only = mut(snapshotSet(world.entities, '1950-01-01'));
    delete only.rows.municipality;
    async function* source() {
      await Promise.resolve();
      yield only;
      yield snapshotSet(world.entities, '2020-01-01');
    }
    expect(
      await checkI12({
        entities: world.entities,
        historicalCodes: world.historicalCodes,
        overrides: [],
        snapshots: source(),
      }),
    ).toEqual([]);
  });

  it('does not compare a pre-1948 abbreviation without the municipality rows of the date, and counts what it left out', async () => {
    const world = baseline();
    const sets = ['1861-03-17', '1900-01-01'].map((date) => {
      const set = mut(snapshotSet(world.entities, date));
      delete set.rows.municipality;
      return set;
    });
    // Province 2 is wrong too, but its abbreviation is not compared either.
    versionOf(world, 'province', 1, START).abbreviation = 'ZZ';
    const options = {
      entities: world.entities,
      historicalCodes: world.historicalCodes,
      overrides: [],
      snapshots: sets,
    };
    const { anomalies, uncompared } = await checkI12Detailed(options);
    expect(anomalies).toEqual([]);
    // Two province versions on two dates.
    expect(uncompared).toEqual({ abbreviation: { versions: 2, dates: 2 } });
    expect(await checkI12(options)).toEqual([]);

    const report = await checkInvariants({ ...world, snapshots: sets });
    const result = report.results.find((r) => r.id === 'I12');
    expect(result).toMatchObject({ status: 'passed', uncompared: { abbreviation: { versions: 2, dates: 2 } } });
  });

  it('reports nothing left out when every date has its municipality rows', async () => {
    const world = baseline();
    const report = await checkInvariants(world);
    expect(report.results.find((r) => r.id === 'I12')).toEqual({ id: 'I12', status: 'passed', violations: 0 });
  });
});

describe('I13: the reconstructed counts equal the SITUAS counts', () => {
  it('rejects a level whose count differs, naming both', () => {
    const world = baseline();
    expect(checkI13({ entities: world.entities, today: TODAY, counts: world.counts })).toEqual([]);
    expect(
      contexts(
        checkI13({
          entities: world.entities,
          today: TODAY,
          counts: { region: 1, province: 3, municipality: 1 },
        }),
      ),
    ).toEqual([
      { invariant: 'I13', level: 'province', date: TODAY, reconstructed: 2, expected: 3 },
      { invariant: 'I13', level: 'municipality', date: TODAY, reconstructed: 2, expected: 1 },
    ]);
  });

  it('counts the versions valid on the date, not the entities, and ignores closed ones', () => {
    const world = baseline();
    expect(
      checkI13({ entities: world.entities, today: '1861-03-17', counts: { region: 1, province: 2, municipality: 4 } }),
    ).toEqual([]);
    expect(
      checkI13({ entities: world.entities, today: '1900-01-01', counts: { region: 1, province: 2, municipality: 2 } }),
    ).toEqual([]);
  });
});

describe('I14: every event row is represented or dropped with a reason', () => {
  const check = (world: Baseline) =>
    checkI14({ accounts: world.accounts, variations: world.variations, variationIdOf: world.variationIdOf });

  it('passes on the baseline', () => {
    expect(check(baseline())).toEqual([]);
  });

  it('rejects a row that is neither, both, in an unregistered variation, or dropped for an unknown reason', () => {
    const world = baseline();
    at(world.accounts, 0).variation = null;
    at(world.accounts, 1).dropped = 'no-effect';
    at(world.accounts, 2).variation = 'act:9:1990-01-01';
    at(world.accounts, 3).dropped = 'because' as never;
    expect(check(world).map((a) => a.message)).toEqual([
      expect.stringContaining('neither represented in a variation nor dropped'),
      expect.stringContaining('both represented in a variation and dropped'),
      expect.stringContaining('refers to the variation act:9:1990-01-01, which does not exist'),
      expect.stringContaining('unknown reason (because)'),
    ]);
  });

  it('rejects a variation key registered but missing from the variations', () => {
    const world = baseline();
    mut(world).variations = world.variations.filter((v) => v.id !== 2);
    expect(check(world).map((a) => a.context.index)).toEqual([0]);
  });
});

describe('I15: abroad participants', () => {
  it('rejects ceded and annexed participants that are not abroad', () => {
    const world = baseline();
    variationOf(world, 2).participants = [
      participant(1, 'ceded', ['AS'], START, null),
      participant(2, 'annexed', ['AN'], null, '1950-01-01'),
    ];
    expect(contexts(checkI15(world.variations))).toMatchObject([
      { invariant: 'I15', entityId: M(1), role: 'ceded', abroad: false },
      { entityId: M(2), role: 'annexed', abroad: false },
    ]);
  });

  it('rejects an abroad participant without AS, AN, CE or AQ', () => {
    const world = baseline();
    variationOf(world, 2).participants = [participant(1, 'changed', ['RN'], START, '1950-01-01', { abroad: true })];
    expect(checkI15(world.variations).map((a) => a.message)).toEqual([
      expect.stringContaining('abroad without an AS, AN, CE, AQ event'),
    ]);
  });

  it('accepts the abroad events, partial cessions and acquisitions of territory abroad included', () => {
    const world = baseline();
    variationOf(world, 2).participants = [
      participant(1, 'ceded', ['AS'], START, null, { abroad: true }),
      participant(2, 'annexed', ['AN'], null, '1950-01-01', { abroad: true }),
      participant(3, 'territory_changed', ['CE'], null, null, { abroad: true }),
      participant(4, 'territory_changed', ['AQ'], null, null, { abroad: true }),
    ];
    expect(checkI15(world.variations)).toEqual([]);
  });
});

describe('checkInvariants', () => {
  it('reports a failed invariant, adds its anomalies to the collector and makes assertInvariants throw', async () => {
    const world = baseline();
    versionOf(world, 'municipality', 3, START).cadastralCode = 'B999';
    const anomalies = new AnomalyCollector();
    const report = await checkInvariants(world, anomalies);
    // One violation per snapshot date.
    expect(report.results.filter((r) => r.status === 'failed').map((r) => [r.id, r.violations])).toEqual([
      ['I12', world.snapshots.length],
    ]);
    expect(anomalies.list('blocking')).toHaveLength(world.snapshots.length);
    expect(anomalies.list()).toEqual(report.anomalies);
    expect(() => {
      assertInvariants(report);
    }).toThrow(InvariantViolation);
    try {
      assertInvariants(report);
    } catch (error) {
      expect((error as InvariantViolation).failed).toEqual(['I12']);
      expect((error as InvariantViolation).anomalies).toEqual(report.anomalies);
    }
  });

  it('marks the invariants whose data the world lacks as skipped, with the reason, never as passed', async () => {
    const world: Parameters<typeof checkInvariants>[0] = {
      start: START,
      today: TODAY,
      entities: baseline().entities,
      variations: baseline().variations,
    };
    const report = await checkInvariants(world);
    expect(report.results.filter((r) => r.status === 'skipped').map((r) => r.id)).toEqual([
      'I2',
      'I7',
      'I12',
      'I13',
      'I14',
    ]);
    expect(report.results.find((r) => r.id === 'I12')?.reason).toBe(
      'the world has no snapshots, historicalCodes, overrides',
    );
    expect(report.results.find((r) => r.id === 'I2')?.reason).toBe('the world has no existence');
    expect(report.results.filter((r) => r.status === 'passed').map((r) => r.id)).toEqual([
      'I1',
      'I3',
      'I4',
      'I5',
      'I6',
      'I8',
      'I9',
      'I10',
      'I11',
      'I15',
    ]);
    expect(() => {
      assertInvariants(report);
    }).not.toThrow();
  });

  it('keeps the non-blocking anomalies of I7 and D30 out of the verdict', async () => {
    const world = baseline();
    versionOf(world, 'municipality', 3, START).istatCode = '002850';
    const report = await checkInvariants(world);
    expect(report.results.find((r) => r.id === 'I7')?.status).toBe('passed');
    expect(report.anomalies.map((a) => [a.level, a.code])).toEqual(
      expect.arrayContaining([['warning', 'active-municipality-8xx-code']]),
    );
  });
});
