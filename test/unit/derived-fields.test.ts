import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { deriveFields } from '../../src/derive/index.ts';
import type { LinkKind, ParticipantRole } from '../../src/model/common.ts';
import type { MunicipalityEntity, Participant, Variation } from '../../src/model/internal.ts';

/** A municipality entity whose versions are `[from, to)` pairs; version ids are `entity * 10 + n`. */
function entity(id: number, ...spans: [IsoDate, IsoDate | null][]): MunicipalityEntity {
  return {
    level: 'municipality',
    id,
    istatOriginId: id,
    versions: spans.map(([validFrom, validTo], n) => ({
      id: id * 10 + n,
      validFrom,
      validTo,
      istatCode: String(id).padStart(6, '0'),
      officialName: `M${id}`,
      italianName: `M${id}`,
      foreignName: null,
      cadastralCode: null,
      provinceId: 1,
      regionId: 1,
    })),
  };
}

function participant(
  entityId: number,
  role: ParticipantRole | null,
  before: number | null,
  after: number | null,
): Participant {
  return {
    level: 'municipality',
    entityId,
    istatEvents: [],
    abroad: role === 'ceded',
    role,
    versionBeforeId: before,
    versionAfterId: after,
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
    links: links.map(([from, to, kind]) => ({ level: 'municipality', from, to, kind })),
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
          [participant(1, 'suppressed', 10, null), participant(2, 'established', null, 20)],
          [[1, 2, 'merged_into']],
        ),
        variation(
          11,
          '2000-01-01',
          [participant(2, 'suppressed', 20, null), participant(3, 'established', null, 30)],
          [[2, 3, 'merged_into']],
        ),
      ],
    );
    expect(result.get(1)).toMatchObject({
      status: 'suppressed',
      isFormerItalian: false,
      predecessors: [],
      successors: [{ id: 2, kind: 'merged_into', date: '1950-01-01', variationId: 10 }],
      currentSuccessors: [3],
    });
    expect(result.get(2)?.predecessors).toEqual([{ id: 1, kind: 'merged_into', date: '1950-01-01', variationId: 10 }]);
    expect(result.get(3)).toMatchObject({ status: 'active', successors: [], currentSuccessors: [] });
  });

  it('ignores intermediate closures and links outside the first and last boundary', () => {
    const result = derive(
      [
        entity(1, ['1900-01-01', '1929-01-01'], ['1947-01-01', null]),
        entity(2, ['1900-01-01', null]),
        entity(3, ['1900-01-01', '1960-01-01'], ['1960-01-01', null]),
      ],
      [
        variation(10, '1929-01-01', [participant(1, 'suppressed', 10, null)], [[1, 2, 'merged_into']]),
        variation(11, '1947-01-01', [participant(1, 'established', null, 11)], [[2, 1, 'detached_into']]),
        variation(
          12,
          '1960-01-01',
          [participant(3, 'changed', 30, 31), participant(2, null, null, null)],
          [[3, 2, 'transferred_to']],
        ),
      ],
    );
    expect(result.get(1)).toMatchObject({ status: 'active', predecessors: [], successors: [], currentSuccessors: [] });
    expect(result.get(2)?.predecessors).toEqual([]);
    expect(result.get(3)?.predecessors).toEqual([]);
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
        variation(10, '1940-01-01', [participant(1, 'suppressed', 10, null)], [[1, 2, 'merged_into']]),
        variation(
          11,
          '1947-09-16',
          [participant(2, 'ceded', 20, null), participant(4, 'ceded', 40, null)],
          [[2, 3, 'merged_into']],
        ),
      ],
    );
    expect(result.get(2)).toMatchObject({ isFormerItalian: true, currentSuccessors: [3] });
    expect(result.get(4)).toMatchObject({ isFormerItalian: true, successors: [], currentSuccessors: [] });
    expect(result.get(1)).toMatchObject({ isFormerItalian: true, currentSuccessors: [3] });
    expect(result.get(3)?.isFormerItalian).toBe(false);
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
          [participant(1, 'suppressed', 10, null), participant(5, 'suppressed', 50, null)],
          [
            [1, 2, 'merged_into'],
            [1, 3, 'merged_into'],
            [5, 2, 'merged_into'],
            [5, 4, 'merged_into'],
          ],
        ),
        variation(11, '1947-09-16', [participant(2, 'ceded', 20, null)]),
        variation(12, '1950-01-01', [participant(4, 'suppressed', 40, null)]),
      ],
    );
    expect(result.get(1)).toMatchObject({ isFormerItalian: false, currentSuccessors: [3] });
    expect(result.get(5)).toMatchObject({ isFormerItalian: false, currentSuccessors: [] });
    expect(result.get(4)).toMatchObject({ status: 'suppressed', isFormerItalian: false, currentSuccessors: [] });
  });

  it('follows merged_into and detached_into only', () => {
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
            participant(1, 'suppressed', 10, null),
            participant(2, 'suppressed', 20, null),
            participant(4, 'suppressed', 40, null),
          ],
          [
            [1, 2, 'merged_into'],
            [2, 3, 'detached_into'],
            [4, 3, 'transferred_to'],
          ],
        ),
      ],
    );
    expect(result.get(1)).toMatchObject({ isFormerItalian: false, currentSuccessors: [3] });
    expect(result.get(2)).toMatchObject({ isFormerItalian: false, currentSuccessors: [3] });
    expect(result.get(4)?.successors).toEqual([{ id: 3, kind: 'transferred_to', date: '1950-01-01', variationId: 10 }]);
    expect(result.get(4)?.currentSuccessors).toEqual([]);
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
          [1, 2, 4, 5].map((id) => participant(id, 'suppressed', id * 10, null)),
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
      ['blocking', 'successor-cycle', [1, 2]],
      ['blocking', 'successor-cycle', [4]],
    ]);
    expect(result.get(5)).toMatchObject({ isFormerItalian: false, currentSuccessors: [3] });
  });

  it('a cession and a partial transfer of the same day in different acts: the Italian successor counts', () => {
    const result = derive(
      [entity(1, ['1900-01-01', '1947-09-16']), entity(2, ['1900-01-01', null])],
      [
        variation(10, '1947-09-16', [{ ...participant(1, 'ceded', 10, null), istatEvents: ['AS'] }]),
        variation(
          11,
          '1947-09-16',
          [{ ...participant(1, 'territory_changed', null, null), istatEvents: ['CE'] }],
          [[1, 2, 'merged_into']],
        ),
      ],
    );
    expect(result.get(1)).toMatchObject({
      status: 'suppressed',
      isFormerItalian: true,
      successors: [{ id: 2, kind: 'merged_into', date: '1947-09-16', variationId: 11 }],
      currentSuccessors: [2],
    });
  });

  it('predecessors come from every variation dated on the first version', () => {
    const result = derive(
      [entity(1, ['1900-01-01', null]), entity(2, ['1950-01-01', null]), entity(3, ['1900-01-01', '1950-01-01'])],
      [
        variation(
          10,
          '1950-01-01',
          [participant(2, 'established', null, 20), participant(3, 'suppressed', 30, null)],
          [[3, 2, 'merged_into']],
        ),
        variation(11, '1950-01-01', [participant(1, 'territory_changed', null, null)], [[1, 2, 'transferred_to']]),
      ],
    );
    expect(result.get(2)?.predecessors.map((l) => [l.id, l.kind, l.variationId])).toEqual([
      [1, 'transferred_to', 11],
      [3, 'merged_into', 10],
    ]);
  });

  it('joins the links of every variation of the closing date, once each, sorted', () => {
    const result = derive(
      [entity(1, ['1900-01-01', '1950-01-01']), entity(2, ['1900-01-01', null]), entity(3, ['1900-01-01', null])],
      [
        variation(11, '1950-01-01', [participant(1, 'suppressed', 10, null)], [[1, 3, 'merged_into']]),
        variation(
          10,
          '1950-01-01',
          [participant(1, 'suppressed', 10, null)],
          [
            [1, 2, 'merged_into'],
            [1, 3, 'merged_into'],
          ],
        ),
        variation(12, '1950-01-01', [], [[1, 2, 'merged_into']]),
      ],
    );
    expect(result.get(1)?.successors.map((l) => [l.id, l.variationId])).toEqual([
      [2, 10],
      [2, 12],
      [3, 10],
      [3, 11],
    ]);
    expect(result.get(1)?.currentSuccessors).toEqual([2, 3]);
  });

  it('ignores links and participants of other levels', () => {
    const other = variation(
      10,
      '1950-01-01',
      [{ ...participant(1, 'suppressed', 10, null), level: 'province' }],
      [[1, 2, 'merged_into']],
    );
    const result = derive(
      [entity(1, ['1900-01-01', '1950-01-01']), entity(2, ['1900-01-01', null])],
      [{ ...other, links: other.links.map((l) => ({ ...l, level: 'province' as const })) }],
    );
    expect(result.get(1)).toMatchObject({ status: 'suppressed', successors: [], currentSuccessors: [] });
  });
});
