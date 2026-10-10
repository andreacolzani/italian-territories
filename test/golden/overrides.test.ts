/**
 * Overrides on real SITUAS fixtures (§6.10, Step 12): golden-7, with the committed
 * `overrides/abbreviations.json`.
 *
 * The world runs from 1921-06-01 to the 1923-02-08 split of Venezia Giulia, so the version of UTS
 * 801 is closed and lies inside the override's target period. No event lists are passed: the
 * identity anomalies of a world of non-consecutive dates are Step 9's subject, these tests only
 * look at the versions, the overrides and I8.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../src/dates/index.ts';
import { checkI8 } from '../../src/invariants/index.ts';
import { canonicalJson } from '../../src/http/index.ts';
import { loadOverrides } from '../../src/overrides/index.ts';
import { snapshotIndex } from '../helpers/identity.ts';
import { withSources } from '../helpers/sources.ts';
import { buildWorld, entityAt } from '../helpers/versions.ts';

const OVERRIDES_DIR = fileURLToPath(new URL('../../overrides/', import.meta.url));

describe('golden-7: Venezia Giulia 1921', async () => {
  const dates: IsoDate[] = ['1921-06-01', '1923-02-07', '1923-02-08'];
  const indexes = await withSources(async ({ situasPublic }) => ({
    region: await snapshotIndex(situasPublic, 'region', dates),
    province: await snapshotIndex(situasPublic, 'province', dates),
    municipality: await snapshotIndex(situasPublic, 'municipality', dates),
  }));
  const world = {
    region: { index: indexes.region },
    province: { index: indexes.province },
    municipality: { index: indexes.municipality },
  };
  const plain = await buildWorld(world);
  const built = await buildWorld({ ...world, overrides: await loadOverrides(OVERRIDES_DIR) });
  const provinces = built.province;

  it('fails I8 without the override, on UTS 801 only', () => {
    expect(plain.anomalies.list()).toEqual([]);
    const violations = checkI8(plain.province);
    expect(violations.map((a) => [a.code, a.context.istatCode, a.context.abbreviation])).toEqual([
      ['invariant-i8', '801', 'Venezia Giulia'],
    ]);
  });

  it('publishes VG for UTS 801 through the override, and I8 passes', () => {
    const veneziaGiulia = entityAt(provinces, '801', '1921-06-01');
    expect(veneziaGiulia.versions.map((v) => [v.validFrom, v.validTo, v.abbreviation])).toEqual([
      ['1921-06-01', '1923-02-08', 'VG'],
    ]);
    expect(built.appliedOverrides).toEqual([
      {
        key: 'uts-801-abbreviation',
        entityId: veneziaGiulia.id,
        validFrom: '1921-06-01',
        validTo: '1923-02-08',
        field: 'abbreviation',
        before: 'Venezia Giulia',
        after: 'VG',
      },
    ]);
    // The Littoria override targets 1934: obsolete in this world, which ends in 1923.
    expect(built.anomalies.list().map((a) => [a.code, a.context.key, a.context.reason])).toEqual([
      ['override-obsolete', 'uts-059-abbreviation', 'no-match'],
    ]);
    expect(checkI8(provinces)).toEqual([]);
  });

  it('changes no version boundary and no other UTS', () => {
    expect(built.province.map((e) => e.versions.map((v) => [v.validFrom, v.validTo]))).toEqual(
      plain.province.map((e) => e.versions.map((v) => [v.validFrom, v.validTo])),
    );
    const changed = built.province.filter((e, i) => canonicalJson(e) !== canonicalJson(plain.province[i]));
    expect(changed.map((e) => e.id)).toEqual([entityAt(provinces, '801', '1921-06-01').id]);
  });

  it('has Zara (801256, M149) in UTS 801 in 1921 and Venezia Tridentina (802) as TN', () => {
    const zara = entityAt(built.municipality, '801256', '1921-06-01');
    const version = zara.versions.find((v) => v.istatCode === '801256');
    expect(version?.cadastralCode).toBe('M149');
    expect(version?.provinceId).toBe(entityAt(provinces, '801', '1921-06-01').id);
    expect(entityAt(provinces, '802', '1921-06-01').versions.map((v) => v.abbreviation)).toEqual(['TN']);
  });
});
