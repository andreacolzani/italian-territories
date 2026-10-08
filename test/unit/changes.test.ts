import { describe, expect, it } from 'vitest';
import {
  computeChanges,
  dataVersionDate,
  toDataVersion,
  toPublicData,
  toReportVariations,
  type PreviousRelease,
  type ReleaseData,
} from '../../src/emit/index.ts';
import { changesSchema } from '../../src/model/reports.ts';
import { at, baseline, M, P, R } from '../helpers/invariants.ts';

/** The baseline world, released; the previous release was generated on 2020-06-01. */
function published(): ReleaseData {
  const world = baseline();
  return structuredClone({ ...toPublicData(world), variations: toReportVariations(world.variations) });
}

const PREVIOUS_META = { data_version: '2020.06.01', generated_at: '2020-06-01T04:00:00Z' };
const TO = { data_version: '2020.06.08', generated_at: '2020-06-08T04:00:00Z' };

function previous(data: ReleaseData = published()): PreviousRelease {
  return { ...data, meta: PREVIOUS_META };
}

function changes(current: ReleaseData, prev: PreviousRelease | null = previous()) {
  const result = computeChanges(prev, current, TO);
  expect(changesSchema.safeParse(result).success).toBe(true);
  return result;
}

const noChanges = { added: [], updated: [], removed: [] };

describe('changes.json (§9)', () => {
  it('converts data versions', () => {
    expect(toDataVersion('2026-10-05')).toBe('2026.10.05');
    expect(dataVersionDate('2026.10.05')).toBe('2026-10-05');
  });

  it('the first release adds everything, nothing retroactive', () => {
    const result = changes(published(), null);
    expect(result.from).toBeNull();
    expect(result.to).toEqual(TO);
    expect(result.retroactive).toBe(false);
    expect(result.municipalities.entities.added).toEqual([1, 2, 3, 4].map((n) => ({ id: M(n), retroactive: false })));
    expect(result.municipalities.versions.added).toContainEqual({
      entity_id: M(1),
      valid_from: '1950-01-01',
      retroactive: false,
    });
    expect(result.variations.added).toHaveLength(2);
  });

  it('identical data: no changes', () => {
    const result = changes(published());
    expect(result.from).toEqual(PREVIOUS_META);
    expect(result.retroactive).toBe(false);
    expect(result.municipalities).toEqual({ entities: noChanges, versions: noChanges });
    expect(result.variations).toEqual(noChanges);
  });

  it('closing an open version after the reference, with a new version and a variation, is additive', () => {
    const current = published();
    const beta = at(current.municipalities);
    at(beta.versions, 1).valid_until = '2020-06-04';
    beta.versions.push({
      ...at(beta.versions, 1),
      valid_from: '2020-06-05',
      valid_until: null,
      official_name: 'Zeta',
      italian_name: 'Zeta',
    });
    current.variations.push({
      id: 7,
      date: '2020-06-05',
      istat_act_id: 7,
      origin: 'istat',
      description: null,
      participants: [
        {
          level: 'municipality',
          territory_id: M(1),
          istat_events: ['CD'],
          abroad: false,
          role: 'changed',
          version_before: '1950-01-01',
          version_after: '2020-06-05',
        },
      ],
      links: [],
    });
    const result = changes(current);
    expect(result.municipalities.versions).toEqual({
      added: [{ entity_id: M(1), valid_from: '2020-06-05', retroactive: false }],
      updated: [
        {
          entity_id: M(1),
          valid_from: '1950-01-01',
          fields: ['valid_until'],
          affected_from: '2020-06-05',
          retroactive: false,
        },
      ],
      removed: [],
    });
    expect(result.variations.added).toEqual([{ id: 7, retroactive: false }]);
    expect(result.retroactive).toBe(false);
  });

  it('closing an open version before the reference is retroactive (a late ISTAT event, §10.2)', () => {
    const current = published();
    at(at(current.municipalities).versions, 1).valid_until = '2019-12-31';
    const result = changes(current);
    expect(result.municipalities.versions.updated).toEqual([
      {
        entity_id: M(1),
        valid_from: '1950-01-01',
        fields: ['valid_until'],
        affected_from: '2020-01-01',
        retroactive: true,
      },
    ]);
    expect(result.retroactive).toBe(true);
  });

  it('a closing whose first new day is the reference is additive', () => {
    const current = published();
    at(at(current.municipalities).versions, 1).valid_until = '2020-05-31';
    expect(changes(current).retroactive).toBe(false);
  });

  it('reopening or moving an end affects the day after the earlier end', () => {
    const current = published();
    at(at(current.municipalities, 1).versions).valid_until = null;
    at(at(current.municipalities, 3).versions).valid_until = '1900-01-10';
    const updated = changes(current).municipalities.versions.updated;
    expect(updated).toEqual([
      {
        entity_id: M(2),
        valid_from: '1861-03-17',
        fields: ['valid_until'],
        affected_from: '1900-01-01',
        retroactive: true,
      },
      {
        entity_id: M(4),
        valid_from: '1861-03-17',
        fields: ['valid_until'],
        affected_from: '1900-01-01',
        retroactive: true,
      },
    ]);
  });

  it('any other version field affects the whole version from its valid_from', () => {
    const current = published();
    at(at(current.municipalities).versions, 1).cadastral_code = 'A009';
    expect(changes(current).municipalities.versions.updated).toEqual([
      {
        entity_id: M(1),
        valid_from: '1950-01-01',
        fields: ['cadastral_code'],
        affected_from: '1950-01-01',
        retroactive: true,
      },
    ]);
  });

  it('a version whose start moves is another version: removed and added', () => {
    const current = published();
    at(at(current.municipalities).versions, 1).valid_from = '1950-01-02';
    const versions = changes(current).municipalities.versions;
    expect(versions.removed).toEqual([
      { entity_id: M(1), valid_from: '1950-01-01', affected_from: '1950-01-01', retroactive: true },
    ]);
    expect(versions.added).toEqual([{ entity_id: M(1), valid_from: '1950-01-02', retroactive: true }]);
  });

  it('removed items carry their first affected day', () => {
    const current = published();
    current.municipalities.splice(3, 1);
    current.variations.splice(1, 1);
    const result = changes(current);
    expect(result.municipalities.entities.removed).toEqual([
      { id: M(4), affected_from: '1861-03-17', retroactive: true },
    ]);
    expect(result.municipalities.versions.removed).toEqual([
      { entity_id: M(4), valid_from: '1861-03-17', affected_from: '1861-03-17', retroactive: true },
    ]);
    expect(result.variations.removed).toEqual([{ id: 2, affected_from: '1950-01-01', retroactive: true }]);
  });

  it('added items are retroactive when they start before the reference', () => {
    const current = published();
    current.provinces.push({ ...at(current.provinces), id: P(3) });
    at(current.provinces, 2).versions = [{ ...at(at(current.provinces, 2).versions), valid_from: '2020-06-01' }];
    current.regions.push({ ...at(current.regions), id: R(2) });
    expect(changes(current).provinces.entities.added).toEqual([{ id: P(3), retroactive: false }]);
    expect(changes(current).regions.entities.added).toEqual([{ id: R(2), retroactive: true }]);
  });

  it('entity fields: links are dated, status by the end of the last version, the others undated', () => {
    const current = published();
    const delta = at(current.municipalities, 2);
    delta.partially_ceded = true;
    const alfa = at(current.municipalities);
    alfa.predecessors = [{ id: M(2), kind: 'merged_into', date: '1900-01-01' }];
    const suppressed = at(current.municipalities, 1);
    suppressed.status = 'active';
    const updated = changes(current).municipalities.entities.updated;
    expect(updated).toEqual([
      { id: M(1), fields: ['predecessors'], affected_from: '1900-01-01', retroactive: true },
      { id: M(2), fields: ['status'], affected_from: '1900-01-01', retroactive: true },
      { id: M(3), fields: ['partially_ceded'], affected_from: null, retroactive: false },
    ]);
  });

  it('a new version alone does not update the entity record', () => {
    const current = published();
    const beta = at(current.municipalities);
    beta.versions.push({ ...at(beta.versions, 1), valid_from: '2021-01-01' });
    expect(changes(current).municipalities.entities.updated).toEqual([]);
  });

  it('variations: changed fields, from the earlier date', () => {
    const current = published();
    at(current.variations, 1).description = 'Ridenominazione';
    expect(changes(current).variations.updated).toEqual([
      { id: 2, fields: ['description'], affected_from: '1950-01-01', retroactive: true },
    ]);
  });
});
