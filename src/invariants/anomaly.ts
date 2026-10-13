/** Shared plumbing of the invariants (§8.1): ids, anomaly construction, small helpers. */
import { compareDates, type HalfOpenInterval } from '../dates/index.ts';
import type { Anomaly } from '../model/internal.ts';

export const INVARIANT_IDS = [
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
  'I6',
  'I7',
  'I8',
  'I9',
  'I10',
  'I11',
  'I12',
  'I13',
  'I14',
  'I15',
] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

/** Stable anomaly code of an invariant: `invariant-i<n>`. */
function invariantCode(id: InvariantId): string {
  return `invariant-${id.toLowerCase()}`;
}

/** A violation of invariant `id`: `blocking`, with `context.invariant`. */
export function violation(id: InvariantId, message: string, context: Record<string, unknown>): Anomaly {
  return {
    level: 'blocking',
    code: invariantCode(id),
    message: `${id}: ${message}`,
    context: { invariant: id, ...context },
  };
}

/** The part of `a` that is also in `b`, `null` when they do not overlap. */
export function intersection(a: HalfOpenInterval, b: HalfOpenInterval): HalfOpenInterval | null {
  const validFrom = compareDates(a.validFrom, b.validFrom) >= 0 ? a.validFrom : b.validFrom;
  const validTo =
    a.validTo === null
      ? b.validTo
      : b.validTo === null
        ? a.validTo
        : compareDates(a.validTo, b.validTo) <= 0
          ? a.validTo
          : b.validTo;
  return validTo !== null && compareDates(validFrom, validTo) >= 0 ? null : { validFrom, validTo };
}

export function range(interval: HalfOpenInterval): HalfOpenInterval {
  return { validFrom: interval.validFrom, validTo: interval.validTo };
}

export function describeRange(interval: HalfOpenInterval): string {
  return `[${interval.validFrom}, ${interval.validTo ?? 'open'})`;
}
