import { describe, expect, it } from 'vitest';
import { exitCodeOf, sampleDates } from '../../src/commands/index.ts';
import { toInternalData, toPublicData } from '../../src/emit/index.ts';
import { checkInvariants } from '../../src/invariants/index.ts';
import { baseline } from '../helpers/invariants.ts';

const blocking = (code: string) => ({ level: 'blocking' as const, code });

describe('exit codes (Step 17)', () => {
  it('maps anomaly codes, never messages', () => {
    expect(exitCodeOf([], false)).toBe(0);
    expect(exitCodeOf([{ level: 'warning', code: 'inferred-breakpoint' }], false)).toBe(0);
    expect(exitCodeOf([], true)).toBe(2);
    expect(exitCodeOf([blocking('snapshot-unavailable'), blocking('completeness-unverified')], false)).toBe(3);
    for (const code of ['event-list-unavailable', 'count-unavailable', 'internal-list-unavailable']) {
      expect(exitCodeOf([blocking(code)], true)).toBe(3);
    }
    for (const code of [
      'snapshot-request-rejected',
      'snapshot-schema-violation',
      'event-list-request-rejected',
      'count-schema-violation',
      'refresh-too-large',
      'invariant-i12',
    ]) {
      expect(exitCodeOf([blocking(code)], false)).toBe(1);
    }
  });

  it('gives 1 when a blocking anomaly other than an unavailability is present', () => {
    expect(exitCodeOf([blocking('snapshot-unavailable'), blocking('snapshot-schema-violation')], false)).toBe(1);
    expect(exitCodeOf([blocking('completeness-unverified')], false)).toBe(1);
  });
});

describe('audit samples', () => {
  it('are distinct dates of [start, today), ascending, and depend only on today', () => {
    const a = sampleDates('2000-01-01', '2026-10-08', 50);
    expect(a).toHaveLength(50);
    expect(new Set(a).size).toBe(50);
    expect([...a].sort()).toEqual(a);
    expect(a.every((d) => d >= '2000-01-01' && d < '2026-10-08')).toBe(true);
    expect(sampleDates('2000-01-01', '2026-10-08', 50)).toEqual(a);
    expect(sampleDates('2000-01-01', '2026-10-15', 50)).not.toEqual(a);
  });

  it('take every date of a range shorter than the request', () => {
    expect(sampleDates('2026-10-01', '2026-10-04', 10)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(sampleDates('2026-10-01', '2026-10-01', 10)).toEqual([]);
    expect(sampleDates('2000-01-01', '2026-10-01', 0)).toEqual([]);
  });
});

describe('public → internal model (validate)', () => {
  it('round-trips the published files', () => {
    const world = baseline();
    const data = toPublicData(world);
    const internal = toInternalData(data);
    expect(toPublicData({ entities: internal.entities, variations: internal.variations })).toEqual(data);
    // Half-open ends come back from the inclusive ones.
    expect(internal.entities.municipality[0]?.versions[0]).toMatchObject({
      validFrom: '1861-03-17',
      validTo: '1950-01-01',
    });
  });

  it('passes the invariants that need no unpublished data, and skips the others', async () => {
    const world = baseline();
    const { entities, variations } = toInternalData(toPublicData(world));
    const report = await checkInvariants({ start: world.start, today: world.today, entities, variations });
    expect(report.results.filter((r) => r.status === 'skipped').map((r) => r.id)).toEqual([
      'I2',
      'I7',
      'I12',
      'I13',
      'I14',
    ]);
    expect(report.results.filter((r) => r.status === 'failed')).toEqual([]);
  });
});
