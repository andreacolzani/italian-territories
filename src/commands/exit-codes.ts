/**
 * Exit codes of the data commands (§10.4), mapped from anomaly codes, never from messages:
 * `0` success; `1` blocking anomalies; `2` retroactive changes (a PR is required); `3` a source is
 * unavailable (timeouts, connection errors, 5xx or 429 after exhausted retries, open circuit).
 *
 * A run whose only blocking anomalies are unavailabilities (and the completeness checks they left
 * unverified) exits with 3; any other blocking anomaly makes it 1. `internal-data-required` is an
 * unavailability when its `context.cause` is `unavailable` (a request failed), not when it is
 * `absent` (every request succeeded and the data is not there).
 */
import { SNAPSHOT_ANOMALIES, type SnapshotFailureCause } from '../completeness/index.ts';
import { ENTITY_ANOMALIES } from '../identity/index.ts';
import type { Anomaly } from '../model/internal.ts';

export const EXIT_CODES = { success: 0, blocking: 1, retroactive: 2, unavailable: 3 } as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Source families whose failures the commands report by cause (besides the snapshots, §6.5). */
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

/** The anomaly code of a source failure: `<prefix>-unavailable`, `-request-rejected`, `-schema-violation`. */
export function sourceFailureCode(prefix: SourceFailurePrefix, cause: SnapshotFailureCause): string {
  return `${prefix}-${CAUSE_SUFFIX[cause]}`;
}

/** Blocking codes that mean "unavailable": with nothing else blocking, the exit code is 3. */
export const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  SNAPSHOT_ANOMALIES.unavailable,
  ...Object.values(SOURCE_FAILURE_PREFIXES).map((p) => sourceFailureCode(p, 'unavailable')),
]);

/** Blocking codes that follow from an unavailability and do not decide the exit code. */
const CONSEQUENCE_CODES: ReadonlySet<string> = new Set([SNAPSHOT_ANOMALIES.unverified]);

type ExitAnomaly = Pick<Anomaly, 'level' | 'code'> & { context?: Readonly<Record<string, unknown>> };

/** A blocking anomaly that means "unavailable" (by code, or by the cause of `internal-data-required`). */
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
