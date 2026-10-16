import { compareDates, daysBetween, type IsoDate, nextDay, parseIsoDate, previousDay } from './calendar-date.ts';

/** `validTo` is the first day no longer valid, `null` while current (§4.1). */
export interface HalfOpenInterval {
  validFrom: IsoDate;
  validTo: IsoDate | null;
}

/** `valid_until` is the last valid day, `null` while current (§4.1). */
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

export function assertHalfOpenInterval(interval: HalfOpenInterval): HalfOpenInterval {
  parseIsoDate(interval.validFrom);
  if (interval.validTo !== null && compareDates(interval.validFrom, interval.validTo) >= 0) {
    throw new InvalidIntervalError(
      `empty interval [${interval.validFrom}, ${interval.validTo}): validTo must be after validFrom`,
    );
  }
  return interval;
}

export function assertInclusiveInterval(interval: InclusiveInterval): InclusiveInterval {
  parseIsoDate(interval.valid_from);
  if (interval.valid_until !== null && compareDates(interval.valid_from, interval.valid_until) > 0) {
    throw new InvalidIntervalError(
      `inverted interval [${interval.valid_from}, ${interval.valid_until}]: valid_until precedes valid_from`,
    );
  }
  return interval;
}

export function toInclusiveEnd(validTo: IsoDate | null): IsoDate | null {
  return validTo === null ? null : previousDay(validTo);
}

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

export function containsDate(interval: HalfOpenInterval, date: IsoDate): boolean {
  return (
    compareDates(interval.validFrom, date) <= 0 &&
    (interval.validTo === null || compareDates(date, interval.validTo) < 0)
  );
}

export function containsDateInclusive(interval: InclusiveInterval, date: IsoDate): boolean {
  return (
    compareDates(interval.valid_from, date) <= 0 &&
    (interval.valid_until === null || compareDates(date, interval.valid_until) <= 0)
  );
}

export function overlaps(a: HalfOpenInterval, b: HalfOpenInterval): boolean {
  return (
    (a.validTo === null || compareDates(b.validFrom, a.validTo) < 0) &&
    (b.validTo === null || compareDates(a.validFrom, b.validTo) < 0)
  );
}

export function covers(outer: HalfOpenInterval, inner: HalfOpenInterval): boolean {
  if (compareDates(outer.validFrom, inner.validFrom) > 0) return false;
  if (outer.validTo === null) return true;
  return inner.validTo !== null && compareDates(inner.validTo, outer.validTo) <= 0;
}

export function isContiguous(prev: HalfOpenInterval, next: HalfOpenInterval): boolean {
  return prev.validTo !== null && compareDates(prev.validTo, next.validFrom) === 0;
}

export function lengthInDays(interval: HalfOpenInterval): number | null {
  assertHalfOpenInterval(interval);
  return interval.validTo === null ? null : daysBetween(interval.validFrom, interval.validTo);
}
