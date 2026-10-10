/**
 * ANPR cross-check on real fixtures (§6.11, Step 14).
 *
 * - golden-3, Siamanna: the world of the golden-3 version test (Siamanna-Siapiccia 1947 → Siamanna →
 *   115064 in 2026); the ANPR archive is reduced to the cadastral codes of that entity (I719, I718),
 *   so that the rest of the archive does not show up as unmatched periods of a reduced world.
 * - Sardinia 2026: every municipality on 2025-12-31 and 2026-01-01, with the ANPR rows valid on those
 *   days; only the attribute comparisons are asserted (the dates of a two-day world are not
 *   significant).
 */
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { ANPR_ANOMALIES, crossCheckAnpr } from '../../src/crosscheck/index.ts';
import { overlaps, type IsoDate } from '../../src/dates/index.ts';
import { deriveFields } from '../../src/derive/index.ts';
import { municipalityGraph, utsGraph } from '../helpers/identity.ts';
import { withSources } from '../helpers/sources.ts';
import { fixtureWorld } from '../helpers/variations.ts';
import { entityAt } from '../helpers/versions.ts';

describe('golden-3: Siamanna', async () => {
  const built = await fixtureWorld(
    ['1947-11-27', '1947-11-28', '1974-08-20', '1974-09-13', '2025-12-31', '2026-01-01'],
    {
      codes: { region: ['20'], province: ['092', '095', '115'], municipality: ['092128', '095057', '115064'] },
      municipalities: await municipalityGraph(['115064_siamanna.json']),
      provinces: {
        graph: await utsGraph([
          ['092', 'province', '092_1_cagliari.json'],
          ['115', 'province', '115_1_oristano.json'],
        ]),
      },
    },
  );
  const derivationAnomalies = new AnomalyCollector();
  const municipalities = deriveFields({
    level: 'municipality',
    entities: built.entities.municipality,
    variations: built.variations,
    anomalies: derivationAnomalies,
  });
  const anpr = await withSources(async ({ anpr }) => (await anpr.fetchAnpr()).data);
  const rows = anpr.rows.filter((r) => r.cadastralCode === 'I719' || r.cadastralCode === 'I718');
  const anomalies = new AnomalyCollector();
  crossCheckAnpr({
    anpr: { rows },
    municipalities,
    provinces: built.entities.province,
    anomalies,
  });
  const siamanna = entityAt(built.entities.municipality, '115064', '2026-01-01');
  const [first, , , renumbered] = siamanna.versions;

  it('the SITUAS start (1947-11-28) wins over ANPR (1947-12-13): ANPR covers less, info, never blocking', () => {
    expect(siamanna.versions.map((v) => [v.validFrom, v.istatCode, v.cadastralCode])).toEqual([
      ['1947-11-28', '092128', 'I719'],
      ['1974-08-20', '095057', 'I719'],
      ['1974-09-13', '095057', 'I718'],
      ['2026-01-01', '115064', 'I718'],
    ]);
    expect(anomalies.has('blocking')).toBe(false);
    const missing = anomalies.list().filter((a) => a.code === ANPR_ANOMALIES.missingPeriod);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      level: 'info',
      context: { count: 1 },
    });
    expect((missing[0]?.context as { items: unknown[] }).items).toMatchObject([
      {
        entityId: siamanna.id,
        versionsFrom: [first?.validFrom],
        matchedBy: ['cadastral'],
        validFrom: '1947-11-28',
        validTo: '1947-12-13',
        side: 'situas-only',
        edge: 'start',
        anprRows: [{ istatCode: '092128', cadastralCode: 'I719', validFrom: '1947-12-13' }, { istatCode: '095057' }],
      },
    ]);
  });

  it('ANPR has not applied the 2026 renumbering: the code and province of before are a lag (info)', () => {
    const item = (code: string) =>
      anomalies.list().find((a) => a.code === code)?.context as { count: number; items: Record<string, unknown>[] };
    expect(item(ANPR_ANOMALIES.laggingIstatCode)).toMatchObject({
      count: 1,
      items: [{ versionFrom: renumbered?.validFrom, validFrom: '2026-01-01', situas: '115064', anpr: '095057' }],
    });
    expect(item(ANPR_ANOMALIES.laggingProvince)).toMatchObject({
      count: 1,
      items: [{ versionFrom: renumbered?.validFrom, validFrom: '2026-01-01', anpr: '095' }],
    });
  });

  it('nothing else diverges: names, provinces before 2026, end dates, former Italian flag', () => {
    expect(anomalies.list().map((a) => [a.level, a.code])).toEqual([
      ['info', ANPR_ANOMALIES.missingPeriod],
      ['info', ANPR_ANOMALIES.laggingIstatCode],
      ['info', ANPR_ANOMALIES.laggingProvince],
    ]);
  });
});

describe('Sardinia 2026: ANPR lags behind the renumbering (golden-4)', async () => {
  const dates: IsoDate[] = ['2025-12-31', '2026-01-01'];
  const built = await fixtureWorld(dates);
  const municipalities = deriveFields({
    level: 'municipality',
    entities: built.entities.municipality,
    variations: built.variations,
    anomalies: new AnomalyCollector(),
  });
  const window = { validFrom: '2025-12-31', validTo: '2026-01-02' };
  const anpr = await withSources(async ({ anpr }) => (await anpr.fetchAnpr()).data);
  const anomalies = new AnomalyCollector();
  crossCheckAnpr({
    anpr: { rows: anpr.rows.filter((r) => overlaps(r, window)) },
    municipalities,
    provinces: built.entities.province,
    anomalies,
  });
  const count = (code: string) =>
    anomalies
      .list()
      .filter((a) => a.code === code)
      .reduce((n, a) => n + (a.level === 'info' ? (a.context.count as number) : 1), 0);

  it('the 377 municipalities with a new code and province from 2026-01-01 are lags, not warnings', () => {
    expect(count(ANPR_ANOMALIES.laggingIstatCode)).toBe(377);
    expect(count(ANPR_ANOMALIES.laggingProvince)).toBe(377);
    expect(count(ANPR_ANOMALIES.divergentIstatCode)).toBe(0);
    expect(count(ANPR_ANOMALIES.divergentProvince)).toBe(0);
    expect(anomalies.has('blocking')).toBe(false);
  });

  it('Alghero 112001 is still 090003 in the province 090 for ANPR', () => {
    const lagging = anomalies.list().find((a) => a.code === ANPR_ANOMALIES.laggingIstatCode)?.context.items as {
      situas: string;
      anpr: string;
      validFrom: string;
    }[];
    expect(lagging).toContainEqual(
      expect.objectContaining({ situas: '112001', anpr: '090003', validFrom: '2026-01-01' }),
    );
  });
});
