/**
 * §10.4, by anomaly code, never by message. A run blocked only by unavailabilities exits 3;
 * `internal-data-required` counts as one only with cause `unavailable`.
 */
import { SNAPSHOT_ANOMALIES, type SnapshotFailureCause } from '../completeness/index.ts';
import { ENTITY_ANOMALIES } from '../identity/index.ts';
import type { Anomaly } from '../model/internal.ts';

export const EXIT_CODES = { success: 0, blocking: 1, retroactive: 2, unavailable: 3 } as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const SOURCE_FAILURE_PREFIXES = {
  eventList: 'event-list',
  count: 'count',
  internalList: 'internal-list',
} as const;
export type SourceFailurePrefix = (typeof SOURCE_FAILURE_PREFIXES)[keyof typeof SOURCE_FAILURE_PREFIXES];

const CAUSE_SUFFIX: Record<SnapshotFailureCause, string> = {
  unavailable: 'unavailable',
  rejected: 'request-rejected',
  'schema-violation': 'schema-violation',
};

export function sourceFailureCode(prefix: SourceFailurePrefix, cause: SnapshotFailureCause): string {
  return `${prefix}-${CAUSE_SUFFIX[cause]}`;
}

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  SNAPSHOT_ANOMALIES.unavailable,
  ...Object.values(SOURCE_FAILURE_PREFIXES).map((p) => sourceFailureCode(p, 'unavailable')),
]);

/** Blocking codes that follow from an unavailability and do not decide the exit code. */
const CONSEQUENCE_CODES: ReadonlySet<string> = new Set([SNAPSHOT_ANOMALIES.unverified]);

type ExitAnomaly = Pick<Anomaly, 'level' | 'code'> & { context?: Readonly<Record<string, unknown>> };

function isUnavailability(anomaly: ExitAnomaly): boolean {
  if (UNAVAILABLE_CODES.has(anomaly.code)) return true;
  return anomaly.code === ENTITY_ANOMALIES.internalDataRequired && anomaly.context?.cause === 'unavailable';
}

export function exitCodeOf(anomalies: readonly ExitAnomaly[], retroactive: boolean): ExitCode {
  const blocking = anomalies.filter((a) => a.level === 'blocking');
  if (blocking.some((a) => !isUnavailability(a) && !CONSEQUENCE_CODES.has(a.code))) {
    return EXIT_CODES.blocking;
  }
  if (blocking.some(isUnavailability)) return EXIT_CODES.unavailable;
  // `completeness-unverified` alone cannot happen without a failure; treat it as blocking.
  if (blocking.length > 0) return EXIT_CODES.blocking;
  return retroactive ? EXIT_CODES.retroactive : EXIT_CODES.success;
}
