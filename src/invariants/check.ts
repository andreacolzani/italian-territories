/**
 * The overall invariant check (§8.1): runs I1–I15 on an {@link InvariantWorld}, adds every anomaly to
 * the collector and reports the outcome of each invariant.
 *
 * An invariant whose data is missing from the world (I2: `existence`; I7: `historicalCodes`; I12:
 * `snapshots`, `historicalCodes` and `overrides`; I13: `counts`; I14: `accounts` and
 * `variationIdOf`) is `skipped` with the reason, never `passed`: `validate` on `dist/` (§10.1) has
 * no unpublished data, and must not claim what it did not check.
 *
 * Besides the violations, the check adds the non-blocking anomalies of I7 (`info` for 8xx prefixes
 * of another UTS) and the D30 `warning` for active municipalities with an 8xx code.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import type { Anomaly } from '../model/internal.ts';
import { INVARIANT_IDS, type InvariantId } from './anomaly.ts';
import { InvariantViolation } from './errors.ts';
import { checkI1, checkI2, checkI3 } from './i1-i3-versions.ts';
import { checkI4, checkI5 } from './i4-i5-parents.ts';
import { checkI6 } from './i6-uniqueness.ts';
import { checkActive8xxCodes, checkI7 } from './i7-code-prefix.ts';
import { checkI8 } from './i8-abbreviation.ts';
import { checkI9, checkI10 } from './i9-i10-variations.ts';
import { checkI11 } from './i11-derived.ts';
import { checkI12Detailed, type I12Uncompared } from './i12-reconstruction.ts';
import { checkI13, checkI14, checkI15 } from './i13-i15.ts';
import type { InvariantWorld } from './world.ts';

export type InvariantStatus = 'passed' | 'failed' | 'skipped';

export interface InvariantResult {
  id: InvariantId;
  status: InvariantStatus;
  /** Number of violations (`blocking` anomalies of the invariant). */
  violations: number;
  /** Why the invariant was not checked, when `skipped`. */
  reason?: string;
  /** I12 only, when something was left out of the comparison: how much. */
  uncompared?: I12Uncompared;
  /** Time the check took, when the caller passed a clock (`now`); never for skipped ones. */
  durationMs?: number;
}

export interface CheckInvariantsOptions {
  /**
   * Monotonic milliseconds, read only to time each check (run summary, §10.4). The invariants
   * never read the clock themselves (§12).
   */
  now?: () => number;
}

export interface InvariantReport {
  /** One entry per invariant, I1 to I15. */
  results: InvariantResult[];
  /** Every anomaly the check produced: the violations and the non-blocking ones. */
  anomalies: Anomaly[];
}

export async function checkInvariants(
  world: InvariantWorld,
  anomalies?: AnomalyCollector,
  options: CheckInvariantsOptions = {},
): Promise<InvariantReport> {
  const { entities, variations } = world;
  const { now } = options;
  const all: Anomaly[] = [];
  const results: InvariantResult[] = [];
  let started = now?.() ?? 0;
  const record = (id: InvariantId, found: Anomaly[], extra: Partial<InvariantResult> = {}): void => {
    const violations = found.filter((a) => a.level === 'blocking').length;
    all.push(...found);
    const timing = now === undefined ? {} : { durationMs: now() - started };
    results.push({ id, status: violations === 0 ? 'passed' : 'failed', violations, ...extra, ...timing });
    started = now?.() ?? 0;
  };
  const skip = (id: InvariantId, reason: string): void => {
    results.push({ id, status: 'skipped', violations: 0, reason });
    started = now?.() ?? 0;
  };
  const missing = (...fields: string[]): string => `the world has no ${fields.join(', ')}`;

  record('I1', checkI1(entities));
  if (world.existence === undefined) skip('I2', missing('existence'));
  else record('I2', checkI2(entities, world.existence));
  record('I3', checkI3(entities));
  record('I4', checkI4(entities));
  record('I5', checkI5(entities));
  record('I6', checkI6(entities));
  const { historicalCodes } = world;
  if (historicalCodes === undefined) skip('I7', missing('historicalCodes'));
  else record('I7', checkI7(entities, historicalCodes, world.extraUtsCodes));
  record('I8', checkI8(entities.province));
  record('I9', checkI9({ entities, variations, start: world.start }));
  record('I10', checkI10({ entities, variations }));
  record('I11', checkI11({ entities, variations }));
  const { snapshots, overrides } = world;
  if (snapshots === undefined || historicalCodes === undefined || overrides === undefined) {
    skip(
      'I12',
      missing(
        ...[
          ...(snapshots === undefined ? ['snapshots'] : []),
          ...(historicalCodes === undefined ? ['historicalCodes'] : []),
          ...(overrides === undefined ? ['overrides'] : []),
        ],
      ),
    );
  } else {
    const { anomalies: found, uncompared } = await checkI12Detailed({
      entities,
      historicalCodes,
      overrides,
      snapshots,
    });
    const left = uncompared.abbreviation.versions > 0;
    record('I12', found, left ? { uncompared } : {});
  }
  if (world.counts === undefined) skip('I13', missing('counts'));
  else record('I13', checkI13({ entities, today: world.today, counts: world.counts }));
  if (world.accounts === undefined || world.variationIdOf === undefined) {
    skip(
      'I14',
      missing(
        ...[
          ...(world.accounts === undefined ? ['accounts'] : []),
          ...(world.variationIdOf === undefined ? ['variationIdOf'] : []),
        ],
      ),
    );
  } else {
    record('I14', checkI14({ accounts: world.accounts, variations, variationIdOf: world.variationIdOf }));
  }
  record('I15', checkI15(variations));
  all.push(...checkActive8xxCodes(entities));

  results.sort((a, b) => INVARIANT_IDS.indexOf(a.id) - INVARIANT_IDS.indexOf(b.id));
  for (const anomaly of all) anomalies?.add(anomaly);
  return { results, anomalies: all };
}

/** Throws {@link InvariantViolation} if any invariant of `report` failed. */
export function assertInvariants(report: InvariantReport): void {
  const failed = report.results.filter((r) => r.status === 'failed');
  if (failed.length > 0)
    throw new InvariantViolation(
      failed.map((r) => r.id),
      report.anomalies,
    );
}
