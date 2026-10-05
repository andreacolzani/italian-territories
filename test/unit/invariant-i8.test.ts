import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../src/dates/index.ts';
import { checkI8 } from '../../src/invariants/index.ts';
import type { ProvinceEntity, ProvinceVersion } from '../../src/model/internal.ts';

function version(id: number, validFrom: IsoDate, abbreviation: string | null): ProvinceVersion {
  return {
    id,
    validFrom,
    validTo: null,
    istatCode: '801',
    officialName: 'Venezia Giulia',
    italianName: 'Venezia Giulia',
    foreignName: null,
    type: 'province',
    abbreviation,
    regionId: 1,
  };
}

function province(id: number, versions: ProvinceVersion[]): ProvinceEntity {
  return { level: 'province', id, istatOriginId: null, versions, historicalCodes: [] };
}

describe('invariant I8 (§8.1): UTS abbreviations are two uppercase letters', () => {
  it('passes on conforming abbreviations', () => {
    expect(checkI8([province(1, [version(1, '1921-01-05', 'VG'), version(2, '1923-02-08', 'TS')])])).toEqual([]);
  });

  it.each([
    ['the full name', 'Venezia Giulia'],
    ['lowercase letters', 'vg'],
    ['one letter', 'V'],
    ['three letters', 'VGG'],
    ['digits', 'V1'],
    ['an accented letter', 'VÈ'],
  ])('rejects %s', (_, abbreviation) => {
    const violations = checkI8([province(7, [version(70, '1921-01-05', abbreviation)])]);
    expect(violations.map((a) => [a.level, a.code, a.context])).toEqual([
      [
        'blocking',
        'invariant-i8',
        {
          invariant: 'I8',
          entityId: 7,
          versionId: 70,
          istatCode: '801',
          validFrom: '1921-01-05',
          validTo: null,
          abbreviation,
        },
      ],
    ]);
  });

  it('reports a null abbreviation left undetermined by the version builder, one anomaly per version', () => {
    const violations = checkI8([
      province(1, [version(1, '1921-01-05', null), version(2, '1922-01-01', 'XX'), version(3, '1923-01-01', 'Xx')]),
    ]);
    expect(violations.map((a) => [a.context.versionId, a.context.abbreviation])).toEqual([
      [1, null],
      [3, 'Xx'],
    ]);
    expect(violations[0]?.message).toMatch(/has no abbreviation/);
  });
});
