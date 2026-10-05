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
import { AnomalyCollector } from '../../src/anomalies.ts';
import { registerVersions } from '../../src/build/index.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { checkI8 } from '../../src/invariants/index.ts';
import { applyOverrides, loadOverrides } from '../../src/overrides/index.ts';
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
  const built = await buildWorld({
    region: { index: indexes.region },
    province: { index: indexes.province },
    municipality: { index: indexes.municipality },
  });
  const registered = registerVersions(built.registry, 'province', built.province, {
    recordedOn: '2026-10-05',
    anomalies: new AnomalyCollector(),
  });
  const overrides = await loadOverrides(OVERRIDES_DIR);
  const anomalies = new AnomalyCollector();
  const { provinces, applied } = applyOverrides({ overrides, provinces: registered.entities, anomalies });

  it('fails I8 before the override, on UTS 801 only', () => {
    expect(built.anomalies.list()).toEqual([]);
    const violations = checkI8(registered.entities);
    expect(violations.map((a) => [a.code, a.context.istatCode, a.context.abbreviation])).toEqual([
      ['invariant-i8', '801', 'Venezia Giulia'],
    ]);
  });

  it('publishes VG for UTS 801 through the override, and I8 passes', () => {
    const veneziaGiulia = entityAt(provinces, '801', '1921-06-01');
    expect(veneziaGiulia.versions.map((v) => [v.validFrom, v.validTo, v.abbreviation])).toEqual([
      ['1921-06-01', '1923-02-08', 'VG'],
    ]);
    expect(applied).toEqual([
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
    expect(anomalies.list()).toEqual([]);
    expect(checkI8(provinces)).toEqual([]);
  });

  it('keeps version ids and every other UTS unchanged', () => {
    expect(provinces.map((e) => e.versions.map((v) => v.id))).toEqual(
      registered.entities.map((e) => e.versions.map((v) => v.id)),
    );
    const changed = provinces.filter((e, i) => e !== registered.entities[i]).map((e) => e.id);
    expect(changed).toEqual([entityAt(provinces, '801', '1921-06-01').id]);
  });

  it('has Zara (801256, M149) in UTS 801 in 1921 and Venezia Tridentina (802) as TN', () => {
    const zara = entityAt(built.municipality, '801256', '1921-06-01');
    const version = zara.versions.find((v) => v.istatCode === '801256');
    expect(version?.cadastralCode).toBe('M149');
    expect(version?.provinceId).toBe(entityAt(provinces, '801', '1921-06-01').id);
    expect(entityAt(provinces, '802', '1921-06-01').versions.map((v) => v.abbreviation)).toEqual(['TN']);
  });
});
