import type { Anomaly } from '../model/internal.ts';
import type { InvariantId } from './anomaly.ts';

export class InvariantViolation extends Error {
  readonly failed: readonly InvariantId[];
  readonly anomalies: readonly Anomaly[];

  constructor(failed: readonly InvariantId[], anomalies: readonly Anomaly[]) {
    super(`invariant violation: ${failed.join(', ')}`);
    this.name = 'InvariantViolation';
    this.failed = failed;
    this.anomalies = anomalies;
  }
}
