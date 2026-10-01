import { compareDates, daysBetween, type IsoDate, nextDay, parseIsoDate, previousDay } from './calendar-date.ts';

/**
 * Internal validity interval `[validFrom, validTo)` (§4.1): `validTo` is the first day the
 * version is no longer valid, `null` while current. Zero-length intervals cannot exist.
 */
export interface HalfOpenInterval {
  validFrom: IsoDate;
  validTo: IsoDate | null;
}

/**
 * Public validity interval with inclusive end (§4.1): `valid_until` is the last valid day,
 * `null` while current. One-day intervals have `valid_from == valid_until`.
 */
export interface InclusiveInterval {
  valid_from: IsoDate;
  valid_until: IsoDate | null;
}

export class InvalidIntervalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIntervalError';
  }
}

/** Throws unless `validFrom < validTo` (or `validTo` is open). */
export function assertHalfOpenInterval(interval: HalfOpenInterval): HalfOpenInterval {
  parseIsoDate(interval.validFrom);
  if (interval.validTo !== null && compareDates(interval.validFrom, interval.validTo) >= 0) {
    throw new InvalidIntervalError(
      `empty interval [${interval.validFrom}, ${interval.validTo}): validTo must be after validFrom`,
    );
  }
  return interval;
}

/** Throws unless `valid_from <= valid_until` (or `valid_until` is open). */
export function assertInclusiveInterval(interval: InclusiveInterval): InclusiveInterval {
  parseIsoDate(interval.valid_from);
  if (interval.valid_until !== null && compareDates(interval.valid_from, interval.valid_until) > 0) {
    throw new InvalidIntervalError(
      `inverted interval [${interval.valid_from}, ${interval.valid_until}]: valid_until precedes valid_from`,
    );
  }
  return interval;
}

/** Exclusive end → inclusive end (`validTo − 1 day`). Used only by the emitter. */
export function toInclusiveEnd(validTo: IsoDate | null): IsoDate | null {
  return validTo === null ? null : previousDay(validTo);
}

/** Inclusive end → exclusive end (`valid_until + 1 day`). Used when reading public data or ANPR. */
export function toExclusiveEnd(validUntil: IsoDate | null): IsoDate | null {
  return validUntil === null ? null : nextDay(validUntil);
}

export function toInclusive(interval: HalfOpenInterval): InclusiveInterval {
  assertHalfOpenInterval(interval);
  return { valid_from: interval.validFrom, valid_until: toInclusiveEnd(interval.validTo) };
}

export function toHalfOpen(interval: InclusiveInterval): HalfOpenInterval {
  assertInclusiveInterval(interval);
  return { validFrom: interval.valid_from, validTo: toExclusiveEnd(interval.valid_until) };
}

/** True iff `date` lies in `[validFrom, validTo)`. */
export function containsDate(interval: HalfOpenInterval, date: IsoDate): boolean {
  return (
    compareDates(interval.validFrom, date) <= 0 &&
    (interval.validTo === null || compareDates(date, interval.validTo) < 0)
  );
}

/** Public query semantics (§4.1): `valid_from <= D AND (valid_until IS NULL OR valid_until >= D)`. */
export function containsDateInclusive(interval: InclusiveInterval, date: IsoDate): boolean {
  return (
    compareDates(interval.valid_from, date) <= 0 &&
    (interval.valid_until === null || compareDates(date, interval.valid_until) <= 0)
  );
}

/** True iff the two half-open intervals share at least one day. */
export function overlaps(a: HalfOpenInterval, b: HalfOpenInterval): boolean {
  return (
    (a.validTo === null || compareDates(b.validFrom, a.validTo) < 0) &&
    (b.validTo === null || compareDates(a.validFrom, b.validTo) < 0)
  );
}

/** True iff `inner` lies entirely within `outer` (used by the parent-coverage invariant I4). */
export function covers(outer: HalfOpenInterval, inner: HalfOpenInterval): boolean {
  if (compareDates(outer.validFrom, inner.validFrom) > 0) return false;
  if (outer.validTo === null) return true;
  return inner.validTo !== null && compareDates(inner.validTo, outer.validTo) <= 0;
}

/** True iff `next` starts exactly where `prev` ends (no gap, no overlap). */
export function isContiguous(prev: HalfOpenInterval, next: HalfOpenInterval): boolean {
  return prev.validTo !== null && compareDates(prev.validTo, next.validFrom) === 0;
}

/** Number of days in a closed-ended interval; `null` for an open one. */
export function lengthInDays(interval: HalfOpenInterval): number | null {
  assertHalfOpenInterval(interval);
  return interval.validTo === null ? null : daysBetween(interval.validFrom, interval.validTo);
}
