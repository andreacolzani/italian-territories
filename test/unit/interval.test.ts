import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertHalfOpenInterval,
  assertInclusiveInterval,
  containsDate,
  containsDateInclusive,
  covers,
  fromDayNumber,
  type HalfOpenInterval,
  InvalidDateError,
  InvalidIntervalError,
  isContiguous,
  lengthInDays,
  overlaps,
  toDayNumber,
  toExclusiveEnd,
  toHalfOpen,
  toInclusive,
  toInclusiveEnd,
} from '../../src/dates/index.ts';

const interval = (validFrom: string, validTo: string | null): HalfOpenInterval => ({ validFrom, validTo });

describe('half-open ↔ inclusive conversion (§4.1)', () => {
  it('converts the Siamanna versions of §4.4', () => {
    expect(toInclusive(interval('1947-11-28', '1974-08-20'))).toEqual({
      valid_from: '1947-11-28',
      valid_until: '1974-08-19',
    });
    expect(toInclusive(interval('1974-09-13', '2026-01-01'))).toEqual({
      valid_from: '1974-09-13',
      valid_until: '2025-12-31',
    });
    expect(toInclusive(interval('2026-01-01', null))).toEqual({ valid_from: '2026-01-01', valid_until: null });
  });

  it('handles one-day versions and leap days', () => {
    expect(toInclusive(interval('2024-02-29', '2024-03-01'))).toEqual({
      valid_from: '2024-02-29',
      valid_until: '2024-02-29',
    });
    expect(toHalfOpen({ valid_from: '1861-03-17', valid_until: '1861-03-17' })).toEqual(
      interval('1861-03-17', '1861-03-18'),
    );
    expect(toInclusiveEnd('1900-03-01')).toBe('1900-02-28');
    expect(toInclusiveEnd('2000-03-01')).toBe('2000-02-29');
    expect(toExclusiveEnd('2024-02-28')).toBe('2024-02-29');
    expect(toExclusiveEnd(null)).toBeNull();
    expect(toInclusiveEnd(null)).toBeNull();
  });

  it('round-trips every one-day and multi-day interval starting in 1861–1870 and around leap days', () => {
    const starts = [toDayNumber('1861-03-17'), toDayNumber('1899-12-01'), toDayNumber('2023-12-01')];
    for (const start of starts) {
      for (let n = start; n < start + 3700; n += 1) {
        const from = fromDayNumber(n);
        for (const length of [1, 2, 28, 29, 365, 366]) {
          const halfOpen = interval(from, addDays(from, length));
          const inclusive = toInclusive(halfOpen);
          expect(toHalfOpen(inclusive)).toEqual(halfOpen);
          expect(toInclusive(toHalfOpen(inclusive))).toEqual(inclusive);
        }
      }
    }
    expect(toHalfOpen(toInclusive(interval('1861-03-17', null)))).toEqual(interval('1861-03-17', null));
  });

  it('keeps variation dates coherent: date = valid_until + 1 of the closed version (§4.1)', () => {
    const closed = toInclusive(interval('2013-02-20', '2024-01-22'));
    expect(toExclusiveEnd(closed.valid_until)).toBe('2024-01-22');
  });

  it('rejects zero-length and inverted intervals', () => {
    expect(() => toInclusive(interval('2024-01-22', '2024-01-22'))).toThrow(InvalidIntervalError);
    expect(() => toInclusive(interval('2024-01-22', '2024-01-21'))).toThrow(InvalidIntervalError);
    expect(() => toHalfOpen({ valid_from: '2024-01-22', valid_until: '2024-01-21' })).toThrow(InvalidIntervalError);
    expect(() => assertHalfOpenInterval(interval('2024-02-30', null))).toThrow(InvalidDateError);
    expect(() => assertInclusiveInterval({ valid_from: '2024-01-22', valid_until: '2024-01-22' })).not.toThrow();
  });
});

describe('interval predicates', () => {
  const quero = interval('1866-10-04', '2013-02-20');

  it('tests membership with half-open and inclusive semantics', () => {
    expect(containsDate(quero, '1866-10-04')).toBe(true);
    expect(containsDate(quero, '2013-02-19')).toBe(true);
    expect(containsDate(quero, '2013-02-20')).toBe(false);
    expect(containsDate(quero, '1866-10-03')).toBe(false);
    expect(containsDate(interval('2024-01-22', null), '9999-12-31')).toBe(true);

    const pub = toInclusive(quero);
    for (const d of ['1866-10-03', '1866-10-04', '2013-02-19', '2013-02-20']) {
      expect(containsDateInclusive(pub, d)).toBe(containsDate(quero, d));
    }
  });

  it('detects overlaps', () => {
    expect(overlaps(interval('2020-01-01', '2020-01-02'), interval('2020-01-02', '2020-01-03'))).toBe(false);
    expect(overlaps(interval('2020-01-01', '2020-01-03'), interval('2020-01-02', '2020-01-03'))).toBe(true);
    expect(overlaps(interval('2020-01-01', null), interval('1861-03-17', '2020-01-02'))).toBe(true);
    expect(overlaps(interval('2020-01-01', null), interval('1861-03-17', '2020-01-01'))).toBe(false);
    expect(overlaps(interval('2020-01-01', null), interval('2021-01-01', null))).toBe(true);
  });

  it('detects coverage (I4)', () => {
    const province = interval('1927-01-12', null);
    expect(covers(province, interval('1927-01-12', '1948-01-01'))).toBe(true);
    expect(covers(province, interval('1930-01-01', null))).toBe(true);
    expect(covers(province, interval('1927-01-11', '1948-01-01'))).toBe(false);
    const closed = interval('1927-01-12', '2026-01-01');
    expect(covers(closed, interval('2000-01-01', '2026-01-01'))).toBe(true);
    expect(covers(closed, interval('2000-01-01', '2026-01-02'))).toBe(false);
    expect(covers(closed, interval('2000-01-01', null))).toBe(false);
  });

  it('detects contiguity (I2) and lengths', () => {
    expect(isContiguous(interval('1861-03-17', '1929-05-14'), interval('1929-05-14', null))).toBe(true);
    expect(isContiguous(interval('1861-03-17', '1929-05-14'), interval('1947-11-25', null))).toBe(false);
    expect(isContiguous(interval('1861-03-17', null), interval('1947-11-25', null))).toBe(false);
    expect(lengthInDays(interval('2024-02-29', '2024-03-01'))).toBe(1);
    expect(lengthInDays(interval('2024-01-01', '2025-01-01'))).toBe(366);
    expect(lengthInDays(interval('2024-01-01', null))).toBeNull();
  });
});
