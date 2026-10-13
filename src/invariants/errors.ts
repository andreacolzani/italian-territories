import type { Anomaly } from '../model/internal.ts';
import type { InvariantId } from './anomaly.ts';

/** One or more blocking invariants failed (§8.1, §12): the build must not publish. */
export class InvariantViolation extends Error {
  readonly failed: readonly InvariantId[];
  /** Every anomaly of the check that failed, the violations among them. */
  readonly anomalies: readonly Anomaly[];

  constructor(failed: readonly InvariantId[], anomalies: readonly Anomaly[]) {
    super(`invariant violation: ${failed.join(', ')}`);
    this.name = 'InvariantViolation';
    this.failed = failed;
    this.anomalies = anomalies;
  }
}
