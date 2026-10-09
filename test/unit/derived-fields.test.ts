import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { deriveFields } from '../../src/derive/index.ts';
import type { LinkKind, ParticipantRole } from '../../src/model/common.ts';
import type { MunicipalityEntity, Participant, Variation } from '../../src/model/internal.ts';
import { M } from '../helpers/invariants.ts';

/** A municipality entity `M(n)` whose versions are `[from, to)` pairs. */
function entity(n: number, ...spans: [IsoDate, IsoDate | null][]): MunicipalityEntity {
  return {
    level: 'municipality',
    id: M(n),
    istatOriginId: n,
    versions: spans.map(([validFrom, validTo]) => ({
      validFrom,
      validTo,
      istatCode: String(n).padStart(6, '0'),
      officialName: `M${n}`,
      italianName: `M${n}`,
      foreignName: null,
      cadastralCode: null,
      provinceId: 'prv-000001',
      regionId: 'reg-000001',
    })),
  };
}

/** A participant of `M(n)`; versions by `validFrom`. */
function participant(
  n: number,
  role: ParticipantRole | null,
  before: IsoDate | null,
  after: IsoDate | null,
): Participant {
  return {
    level: 'municipality',
    entityId: M(n),
    istatEvents: [],
    abroad: role === 'ceded',
    role,
    versionBefore: before,
    versionAfter: after,
  };
}

function variation(
  id: number,
  date: IsoDate,
  participants: Participant[],
  links: [number, number, LinkKind][] = [],
): Variation {
  return {
    id,
    date,
    istatActId: null,
    origin: 'istat',
    description: null,
    participants,
    links: links.map(([from, to, kind]) => ({ level: 'municipality', from: M(from), to: M(to), kind })),
  };
}

/** Derived entities by id; without `anomalies`, the derivation must report none. */
function derive(entities: MunicipalityEntity[], variations: Variation[], anomalies?: AnomalyCollector) {
  const collector = anomalies ?? new AnomalyCollector();
  const derived = deriveFields({ level: 'municipality', entities, variations, anomalies: collector });
  if (anomalies === undefined) expect(collector.list()).toEqual([]);
  return new Map(derived.map((e) => [e.id, e]));
}

describe('deriveFields', () => {
  it('follows a chain of mergers to the active entity', () => {
    const result = derive(
      [
        entity(1, ['1900-01-01', '1950-01-01']),
        entity(2, ['1950-01-01', '2000-01-01']),
        entity(3, ['2000-01-01', null]),
      ],
      [
        variation(
          10,
          '1950-01-01',
          [participant(1, 'suppressed', '1900-01-01', null), participant(2, 'established', null, '1950-01-01')],
          [[1, 2, 'merged_into']],
        ),
        variation(
          11,
          '2000-01-01',
          [participant(2, 'suppressed', '1950-01-01', null), participant(3, 'established', null, '2000-01-01')],
          [[2, 3, 'merged_into']],
        ),
      ],
    );
    expect(result.get(M(1))).toMatchObject({
      status: 'suppressed',
      isFormerItalian: false,
      predecessors: [],
      successors: [{ id: M(2), kind: 'merged_into', date: '1950-01-01' }],
      currentSuccessors: [M(3)],
    });
    expect(result.get(M(2))?.predecessors).toEqual([{ id: M(1), kind: 'merged_into', date: '1950-01-01' }]);
    expect(result.get(M(3))).toMatchObject({ status: 'active', successors: [], currentSuccessors: [] });
  });

  it('ignores intermediate closures and links outside the first and last boundary', () => {
    const result = derive(
      [
        entity(1, ['1900-01-01', '1929-01-01'], ['1947-01-01', null]),
        entity(2, ['1900-01-01', null]),
        entity(3, ['1900-01-01', '1960-01-01'], ['1960-01-01', null]),
      ],
      [
        variation(10, '1929-01-01', [participant(1, 'suppressed', '1900-01-01', null)], [[1, 2, 'merged_into']]),
        variation(11, '1947-01-01', [participant(1, 'established', null, '1947-01-01')], [[2, 1, 'detached_into']]),
        variation(
          12,
          '1960-01-01',
          [participant(3, 'changed', '1900-01-01', '1960-01-01'), participant(2, null, null, null)],
          [[3, 2, 'transferred_to']],
        ),
      ],
    );
    expect(result.get(M(1))).toMatchObject({
      status: 'active',
      predecessors: [],
      successors: [],
      currentSuccessors: [],
    });
    expect(result.get(M(2))?.predecessors).toEqual([]);
    expect(result.get(M(3))?.predecessors).toEqual([]);
  });

  it('a ceded entity is former Italian and a terminal point, its links still give current successors', () => {
    const result = derive(
      [
        entity(1, ['1900-01-01', '1940-01-01']),
        entity(2, ['1900-01-01', '1947-09-16']),
        entity(3, ['1900-01-01', null]),
        entity(4, ['1900-01-01', '1947-09-16']),
      ],
      [
        variation(10, '1940-01-01', [participant(1, 'suppressed', '1900-01-01', null)], [[1, 2, 'merged_into']]),
        variation(
          11,
          '1947-09-16',
          [participant(2, 'ceded', '1900-01-01', null), participant(4, 'ceded', '1900-01-01', null)],
          [[2, 3, 'merged_into']],
        ),
      ],
    );
    expect(result.get(M(2))).toMatchObject({ isFormerItalian: true, currentSuccessors: [M(3)] });
    expect(result.get(M(4))).toMatchObject({ isFormerItalian: true, successors: [], currentSuccessors: [] });
    expect(result.get(M(1))).toMatchObject({ isFormerItalian: true, currentSuccessors: [M(3)] });
    expect(result.get(M(3))).toMatchObject({ isFormerItalian: false });
  });

  it('is not former Italian when one path ends in an active or a non-ceded entity', () => {
    const result = derive(
      [
        entity(1, ['1900-01-01', '1940-01-01']),
        entity(2, ['1900-01-01', '1947-09-16']),
        entity(3, ['1900-01-01', null]),
        entity(4, ['1900-01-01', '1950-01-01']),
        entity(5, ['1900-01-01', '1940-01-01']),
      ],
      [
        variation(
          10,
          '1940-01-01',
          [participant(1, 'suppressed', '1900-01-01', null), participant(5, 'suppressed', '1900-01-01', null)],
          [
            [1, 2, 'merged_into'],
            [1, 3, 'merged_into'],
            [5, 2, 'merged_into'],
            [5, 4, 'merged_into'],
          ],
        ),
        variation(11, '1947-09-16', [participant(2, 'ceded', '1900-01-01', null)]),
        variation(12, '1950-01-01', [participant(4, 'suppressed', '1900-01-01', null)]),
      ],
    );
    // Occisla-Clanzo (golden-22): one path ends in an active entity, the other in a ceded one.
    expect(result.get(M(1))).toMatchObject({ isFormerItalian: false, currentSuccessors: [M(3)] });
    expect(result.get(M(1))?.successors.map((l) => l.kind)).toEqual(['split_into', 'split_into']);
    expect(result.get(M(5))).toMatchObject({ isFormerItalian: false, currentSuccessors: [] });
    expect(result.get(M(4))).toMatchObject({
      status: 'suppressed',
      isFormerItalian: false,
      currentSuccessors: [],
    });
  });

  it('follows merged_into, split_into and detached_into only; transferred_to is never published', () => {
    const result = derive(
      [
        entity(1, ['1900-01-01', '1950-01-01']),
        entity(2, ['1900-01-01', '1950-01-01']),
        entity(3, ['1900-01-01', null]),
        entity(4, ['1900-01-01', '1950-01-01']),
      ],
      [
        variation(
          10,
          '1950-01-01',
          [
            participant(1, 'suppressed', '1900-01-01', null),
            participant(2, 'suppressed', '1900-01-01', null),
            participant(4, 'suppressed', '1900-01-01', null),
          ],
          [
            [1, 2, 'merged_into'],
            [2, 3, 'detached_into'],
            [4, 3, 'transferred_to'],
          ],
        ),
      ],
    );
    expect(result.get(M(1))).toMatchObject({ isFormerItalian: false, currentSuccessors: [M(3)] });
    expect(result.get(M(2))).toMatchObject({ isFormerItalian: false, currentSuccessors: [M(3)] });
    expect(result.get(M(4))?.successors).toEqual([]);
    expect(result.get(M(4))?.currentSuccessors).toEqual([]);
    expect(result.get(M(3))?.predecessors).toEqual([]);
  });

  it('a cycle among final closures is a blocking successor-cycle, one per component', () => {
    const anomalies = new AnomalyCollector();
    const result = derive(
      [
        entity(1, ['1900-01-01', '1950-01-01']),
        entity(2, ['1900-01-01', '1950-01-01']),
        entity(3, ['1900-01-01', null]),
        entity(4, ['1900-01-01', '1950-01-01']),
        entity(5, ['1900-01-01', '1950-01-01']),
      ],
      [
        variation(
          10,
          '1950-01-01',
          [1, 2, 4, 5].map((n) => participant(n, 'suppressed', '1900-01-01', null)),
          [
            [2, 1, 'merged_into'],
            [1, 2, 'merged_into'],
            [2, 3, 'detached_into'],
            [4, 4, 'merged_into'],
            [5, 1, 'merged_into'],
          ],
        ),
      ],
      anomalies,
    );
    expect(anomalies.list().map((a) => [a.level, a.code, a.context.entityIds])).toEqual([
      ['blocking', 'successor-cycle', [M(1), M(2)]],
      ['blocking', 'successor-cycle', [M(4)]],
    ]);
    expect(result.get(M(5))).toMatchObject({ isFormerItalian: false, currentSuccessors: [M(3)] });
  });

  it('a cession and a partial transfer of the same day in different acts: the Italian successor counts', () => {
    const result = derive(
      [entity(1, ['1900-01-01', '1947-09-16']), entity(2, ['1900-01-01', null])],
      [
        variation(10, '1947-09-16', [{ ...participant(1, 'ceded', '1900-01-01', null), istatEvents: ['AS'] }]),
        variation(
          11,
          '1947-09-16',
          [{ ...participant(1, 'territory_changed', null, null), istatEvents: ['CE'] }],
          [[1, 2, 'merged_into']],
        ),
      ],
    );
    expect(result.get(M(1))).toMatchObject({
      status: 'suppressed',
      isFormerItalian: true,
      successors: [{ id: M(2), kind: 'merged_into', date: '1947-09-16' }],
      currentSuccessors: [M(2)],
    });
  });

  it('predecessors come from every variation dated on the first version', () => {
    const result = derive(
      [entity(1, ['1900-01-01', null]), entity(2, ['1950-01-01', null]), entity(3, ['1900-01-01', '1950-01-01'])],
      [
        variation(
          10,
          '1950-01-01',
          [participant(2, 'established', null, '1950-01-01'), participant(3, 'suppressed', '1900-01-01', null)],
          [[3, 2, 'merged_into']],
        ),
        variation(11, '1950-01-01', [participant(1, 'territory_changed', null, null)], [[1, 2, 'detached_into']]),
      ],
    );
    expect(result.get(M(2))?.predecessors.map((l) => [l.id, l.kind])).toEqual([
      [M(1), 'detached_into'],
      [M(3), 'merged_into'],
    ]);
  });

  it('joins the links of every variation of the closing date once each, as split_into towards several destinations', () => {
    const result = derive(
      [entity(1, ['1900-01-01', '1950-01-01']), entity(2, ['1900-01-01', null]), entity(3, ['1900-01-01', null])],
      [
        variation(11, '1950-01-01', [participant(1, 'suppressed', '1900-01-01', null)], [[1, 3, 'merged_into']]),
        variation(
          10,
          '1950-01-01',
          [participant(1, 'suppressed', '1900-01-01', null)],
          [
            [1, 2, 'merged_into'],
            [1, 3, 'merged_into'],
          ],
        ),
        variation(12, '1950-01-01', [], [[1, 2, 'merged_into']]),
      ],
    );
    expect(result.get(M(1))?.successors).toEqual([
      { id: M(2), kind: 'split_into', date: '1950-01-01' },
      { id: M(3), kind: 'split_into', date: '1950-01-01' },
    ]);
    expect(result.get(M(1))?.currentSuccessors).toEqual([M(2), M(3)]);
    expect(result.get(M(2))?.predecessors).toEqual([]);
  });

  it('ignores links and participants of other levels', () => {
    const other = variation(
      10,
      '1950-01-01',
      [{ ...participant(1, 'suppressed', '1900-01-01', null), level: 'province' }],
      [[1, 2, 'merged_into']],
    );
    const result = derive(
      [entity(1, ['1900-01-01', '1950-01-01']), entity(2, ['1900-01-01', null])],
      [{ ...other, links: other.links.map((l) => ({ ...l, level: 'province' as const })) }],
    );
    expect(result.get(M(1))).toMatchObject({ status: 'suppressed', successors: [], currentSuccessors: [] });
  });
});
