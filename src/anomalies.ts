/**
 * Anomalies (§8.2) are data, not exceptions: every stage adds them to the `AnomalyCollector`
 * passed through the pipeline, which decides nothing on its own.
 */
import type { AnomalyLevel } from './model/common.ts';
import type { Anomaly } from './model/internal.ts';

export class AnomalyCollector {
  readonly #anomalies: Anomaly[] = [];

  add(anomaly: Anomaly): void {
    this.#anomalies.push(anomaly);
  }

  /** Anomalies in insertion order, optionally of one level. */
  list(level?: AnomalyLevel): Anomaly[] {
    return this.#anomalies.filter((a) => level === undefined || a.level === level);
  }

  has(level: AnomalyLevel): boolean {
    return this.#anomalies.some((a) => a.level === level);
  }
}
