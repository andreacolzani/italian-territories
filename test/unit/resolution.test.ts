/** §7, D45, on the derived fields of a synthetic world. */
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { deriveFields } from '../../src/derive/index.ts';
import type { ParticipantRole } from '../../src/model/common.ts';
import type { MunicipalityEntity, Participant, Variation } from '../../src/model/internal.ts';
import { M } from '../helpers/invariants.ts';
import { resolve } from '../helpers/resolution.ts';

function entity(n: number, validFrom: IsoDate, validTo: IsoDate | null): MunicipalityEntity {
  return {
    level: 'municipality',
    id: M(n),
    istatOriginId: n,
    versions: [
      {
        validFrom,
        validTo,
        istatCode: String(n).padStart(6, '0'),
        officialName: `M${n}`,
        italianName: `M${n}`,
        foreignName: null,
        cadastralCode: null,
        provinceId: 'prv-000001',
        regionId: 'reg-000001',
      },
    ],
  };
}

function closing(n: number, role: ParticipantRole): Participant {
  return {
    level: 'municipality',
    entityId: M(n),
    istatEvents: [role === 'ceded' ? 'AS' : 'ES'],
    abroad: role === 'ceded',
    role,
    versionBefore: '1900-01-01',
    versionAfter: null,
  };
}

function variation(id: number, date: IsoDate, participants: Participant[], links: [number, number][]): Variation {
  return {
    id,
    date,
    istatActId: id,
    origin: 'istat',
    description: null,
    participants,
    links: links.map(([from, to]) => ({ level: 'municipality', from: M(from), to: M(to), kind: 'merged_into' })),
  };
}

/**
 * 1 → {2, 3} on 1923 (2 active; 3 ceded on 1947): one current successor, a former Italian one.
 * 4 → {2} on 1923: automatic. 5 → 6 on 1923, 6 → {2, 7} on 1930, 7 ceded on 1947: a former Italian
 * successor two steps away. 8 → {2, 9} on 1923 (9 active): two current successors. 7 is ceded itself.
 */
function world() {
  const entities = [
    entity(1, '1900-01-01', '1923-02-08'),
    entity(2, '1900-01-01', null),
    entity(3, '1900-01-01', '1947-09-16'),
    entity(4, '1900-01-01', '1923-02-08'),
    entity(5, '1900-01-01', '1923-02-08'),
    entity(6, '1900-01-01', '1930-01-01'),
    entity(7, '1900-01-01', '1947-09-16'),
    entity(8, '1900-01-01', '1923-02-08'),
    entity(9, '1900-01-01', null),
  ];
  const variations = [
    variation(
      1,
      '1923-02-08',
      [closing(1, 'suppressed'), closing(4, 'suppressed'), closing(5, 'suppressed'), closing(8, 'suppressed')],
      [
        [1, 2],
        [1, 3],
        [4, 2],
        [5, 6],
        [8, 2],
        [8, 9],
      ],
    ),
    variation(
      2,
      '1930-01-01',
      [closing(6, 'suppressed')],
      [
        [6, 2],
        [6, 7],
      ],
    ),
    variation(3, '1947-09-16', [closing(3, 'ceded'), closing(7, 'ceded')], []),
  ];
  return deriveFields({ level: 'municipality', entities, variations, anomalies: new AnomalyCollector() }).map((e) => ({
    id: e.id,
    status: e.status,
    is_former_italian: e.isFormerItalian,
    successors: e.successors,
    current_successors: e.currentSuccessors ?? [],
  }));
}

describe('resolution to the current territory (§7, D45)', () => {
  const entities = world();

  it('an active entity resolves to itself', () => {
    expect(resolve(entities, M(2))).toEqual({ kind: 'current', id: M(2) });
  });

  it('one current successor and no former Italian successor: automatic', () => {
    expect(resolve(entities, M(4))).toEqual({ kind: 'automatic', id: M(2) });
  });

  it('a former Italian successor, direct or indirect, leaves it to supervision (Occisla-Clanzo shape)', () => {
    expect(entities.find((e) => e.id === M(1))?.current_successors).toEqual([M(2)]);
    expect(resolve(entities, M(1))).toEqual({ kind: 'supervision', reason: 'former-italian-successor' });
    expect(entities.find((e) => e.id === M(5))?.current_successors).toEqual([M(2)]);
    expect(resolve(entities, M(5))).toEqual({ kind: 'supervision', reason: 'former-italian-successor' });
  });

  it('several current successors, or a former Italian entity: supervision', () => {
    expect(resolve(entities, M(8))).toEqual({ kind: 'supervision', reason: 'several-current-successors' });
    expect(resolve(entities, M(3))).toEqual({ kind: 'supervision', reason: 'former-italian' });
  });
});
