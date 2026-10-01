import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertIsoDate,
  compareDates,
  currentDate,
  daysBetween,
  daysInMonth,
  formatIsoDate,
  fromDayNumber,
  fromItalianDate,
  fromUtcMidnightTimestamp,
  InvalidDateError,
  isAfter,
  isBefore,
  isBetweenInclusive,
  isInDatasetRange,
  isIsoDate,
  isLeapYear,
  maxDate,
  minDate,
  nextDay,
  parseIsoDate,
  previousDay,
  subtractDays,
  toDayNumber,
  toItalianDate,
  UNIFICATION_DATE,
} from '../../src/dates/index.ts';

/** Oracle for the tests only: UTC `Date` has no timezone ambiguity. */
function oracleIso(dayNumber: number): string {
  return new Date(dayNumber * 86_400_000).toISOString().slice(0, 10);
}

describe('validation', () => {
  it.each(['1861-03-17', '2000-02-29', '2024-02-29', '0001-01-01', '9999-12-31', '1900-02-28'])('accepts %s', (d) => {
    expect(isIsoDate(d)).toBe(true);
    expect(assertIsoDate(d)).toBe(d);
  });

  it.each([
    '1900-02-29', // century, not a leap year
    '2023-02-29',
    '2100-02-29',
    '2024-02-30',
    '2024-04-31',
    '2024-13-01',
    '2024-00-10',
    '2024-01-00',
    '2024-01-32',
    '0000-01-01',
    '2024-1-01',
    '24-01-01',
    '2024-01-01T00:00:00Z',
    ' 2024-01-01',
    '2024/01/01',
    '',
  ])('rejects %j', (d) => {
    expect(isIsoDate(d)).toBe(false);
    expect(() => parseIsoDate(d)).toThrow(InvalidDateError);
    expect(() => toDayNumber(d)).toThrow(InvalidDateError);
  });

  it('rejects non-strings', () => {
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(20240101)).toBe(false);
    expect(() => assertIsoDate(undefined)).toThrow(InvalidDateError);
  });
});

describe('leap years and month lengths', () => {
  it.each([
    [1600, true],
    [1700, false],
    [1800, false],
    [1860, true],
    [1861, false],
    [1900, false],
    [2000, true],
    [2024, true],
    [2026, false],
    [2100, false],
    [2400, true],
  ])('isLeapYear(%i) = %s', (year, leap) => {
    expect(isLeapYear(year)).toBe(leap);
    expect(daysInMonth(year, 2)).toBe(leap ? 29 : 28);
  });

  it('knows every month length', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2026, m))).toEqual([
      31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
  });
});

describe('day numbers', () => {
  it('anchors on the Unix epoch', () => {
    expect(toDayNumber('1970-01-01')).toBe(0);
    expect(fromDayNumber(0)).toBe('1970-01-01');
    expect(toDayNumber('1969-12-31')).toBe(-1);
  });

  it('round-trips every day from 1600 to 2400 and agrees with the UTC oracle', () => {
    const first = toDayNumber('1600-01-01');
    const last = toDayNumber('2400-12-31');
    expect(last - first + 1).toBe(801 * 365 + 195); // 195 leap days in 1600..2400
    // Plain comparisons in the loop: ~290k `expect` calls are too slow for CI runners.
    const mismatches: string[] = [];
    let previous: string | null = null;
    for (let n = first; n <= last; n++) {
      const iso = fromDayNumber(n);
      if (iso !== oracleIso(n)) mismatches.push(`fromDayNumber(${n}) = ${iso}, oracle ${oracleIso(n)}`);
      if (toDayNumber(iso) !== n) mismatches.push(`toDayNumber(${iso}) = ${toDayNumber(iso)}, expected ${n}`);
      if (previous !== null && compareDates(previous, iso) !== -1) mismatches.push(`${previous} !< ${iso}`);
      previous = iso;
    }
    expect(mismatches).toEqual([]);
  });

  it('covers the whole supported range', () => {
    for (const d of ['0001-01-01', '0004-02-29', '9999-12-31']) expect(fromDayNumber(toDayNumber(d))).toBe(d);
    expect(() => fromDayNumber(toDayNumber('9999-12-31') + 1)).toThrow(InvalidDateError);
    expect(() => fromDayNumber(toDayNumber('0001-01-01') - 1)).toThrow(InvalidDateError);
    expect(() => fromDayNumber(1.5)).toThrow(InvalidDateError);
  });

  it('formats and parses components', () => {
    expect(parseIsoDate('1861-03-17')).toEqual({ year: 1861, month: 3, day: 17 });
    expect(formatIsoDate({ year: 1861, month: 3, day: 17 })).toBe('1861-03-17');
    expect(formatIsoDate({ year: 1, month: 1, day: 1 })).toBe('0001-01-01');
    expect(() => formatIsoDate({ year: 2023, month: 2, day: 29 })).toThrow(InvalidDateError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts days across month, year and leap boundaries', () => {
    expect(nextDay('2024-02-28')).toBe('2024-02-29');
    expect(nextDay('2024-02-29')).toBe('2024-03-01');
    expect(nextDay('2023-02-28')).toBe('2023-03-01');
    expect(nextDay('1900-02-28')).toBe('1900-03-01');
    expect(nextDay('2000-02-28')).toBe('2000-02-29');
    expect(nextDay('2025-12-31')).toBe('2026-01-01');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
    expect(previousDay('2024-03-01')).toBe('2024-02-29');
    expect(previousDay('1927-01-12')).toBe('1927-01-11');
    expect(addDays('2024-01-21', 0)).toBe('2024-01-21');
    expect(addDays('2024-01-01', 366)).toBe('2025-01-01');
    expect(addDays('2023-01-01', 365)).toBe('2024-01-01');
    expect(subtractDays('2024-01-22', 365)).toBe('2023-01-22');
    expect(addDays('2024-03-10', -10)).toBe('2024-02-29');
  });

  it('computes signed distances', () => {
    expect(daysBetween('2024-01-21', '2024-01-22')).toBe(1);
    expect(daysBetween('2024-01-22', '2024-01-21')).toBe(-1);
    expect(daysBetween('1947-11-28', '1947-12-13')).toBe(15);
    expect(daysBetween('1861-03-17', '1861-03-17')).toBe(0);
    expect(daysBetween('2000-01-01', '2001-01-01')).toBe(366);
    expect(daysBetween('1900-01-01', '1901-01-01')).toBe(365);
  });

  it('rejects non-integer offsets', () => {
    expect(() => addDays('2024-01-01', 0.5)).toThrow(RangeError);
    expect(() => addDays('2024-01-01', Number.NaN)).toThrow(RangeError);
  });
});

describe('comparison', () => {
  it('orders dates', () => {
    expect(compareDates('1861-03-17', '1927-01-12')).toBe(-1);
    expect(compareDates('1948-01-01', '1948-01-01')).toBe(0);
    expect(compareDates('2026-01-01', '2025-12-31')).toBe(1);
    expect(isBefore('2025-12-31', '2026-01-01')).toBe(true);
    expect(isAfter('2025-12-31', '2026-01-01')).toBe(false);
    expect(['2026-01-01', '1861-03-17', '1948-01-01'].sort(compareDates)).toEqual([
      '1861-03-17',
      '1948-01-01',
      '2026-01-01',
    ]);
  });

  it('refuses to compare malformed dates', () => {
    expect(() => compareDates('2024-1-1', '2024-01-01')).toThrow(InvalidDateError);
    expect(() => compareDates('2024-01-01', '2024-02-30')).toThrow(InvalidDateError);
  });

  it('picks minimum and maximum', () => {
    expect(minDate('2024-01-22', '1861-03-17', '1948-01-01')).toBe('1861-03-17');
    expect(maxDate('2024-01-22', '1861-03-17', '2026-01-01')).toBe('2026-01-01');
    expect(minDate('1927-01-12')).toBe('1927-01-12');
  });

  it('checks inclusive ranges', () => {
    expect(isBetweenInclusive('1927-01-12', '1927-01-12', '1947-12-31')).toBe(true);
    expect(isBetweenInclusive('1947-12-31', '1927-01-12', '1947-12-31')).toBe(true);
    expect(isBetweenInclusive('1948-01-01', '1927-01-12', '1947-12-31')).toBe(false);
  });
});

describe('dataset lower bound (1861-03-17)', () => {
  const today = '2026-09-30';

  it('is the unification date', () => {
    expect(UNIFICATION_DATE).toBe('1861-03-17');
  });

  it('includes both bounds and excludes everything outside', () => {
    expect(isInDatasetRange('1861-03-17', today)).toBe(true);
    expect(isInDatasetRange('1861-03-16', today)).toBe(false);
    expect(isInDatasetRange(previousDay(UNIFICATION_DATE), today)).toBe(false);
    expect(isInDatasetRange(today, today)).toBe(true);
    expect(isInDatasetRange(nextDay(today), today)).toBe(false);
    expect(isInDatasetRange('9999-12-31', today)).toBe(false);
  });

  it('computes the day before the lower bound', () => {
    expect(previousDay(UNIFICATION_DATE)).toBe('1861-03-16');
  });
});

describe('source formats', () => {
  it('converts DD/MM/YYYY both ways', () => {
    expect(fromItalianDate('17/03/1861')).toBe('1861-03-17');
    expect(fromItalianDate('29/02/2024')).toBe('2024-02-29');
    expect(fromItalianDate('01/01/0001')).toBe('0001-01-01');
    expect(toItalianDate('1861-03-17')).toBe('17/03/1861');
    expect(toItalianDate('2026-09-30')).toBe('30/09/2026');
    expect(toItalianDate('0001-01-01')).toBe('01/01/0001');
  });

  it.each(['29/02/2023', '31/04/2024', '1/1/2024', '2024-01-01', '17-03-1861', '17/03/61', ''])(
    'rejects %j as DD/MM/YYYY',
    (value) => {
      expect(() => fromItalianDate(value)).toThrow(InvalidDateError);
    },
  );

  it('round-trips DD/MM/YYYY for every day since unification', () => {
    const last = toDayNumber('2030-12-31');
    for (let n = toDayNumber(UNIFICATION_DATE); n <= last; n++) {
      const iso = fromDayNumber(n);
      expect(fromItalianDate(toItalianDate(iso))).toBe(iso);
    }
  });

  it('converts UTC-midnight timestamps of the public event lists', () => {
    expect(fromUtcMidnightTimestamp('2024-01-22T00:00:00Z')).toBe('2024-01-22');
    expect(fromUtcMidnightTimestamp('1861-03-17T00:00:00.000Z')).toBe('1861-03-17');
  });

  it.each(['2024-01-22T01:00:00Z', '2024-01-22T00:00:00+01:00', '2024-01-22', '2023-02-29T00:00:00Z'])(
    'rejects %j as a UTC-midnight timestamp',
    (value) => {
      expect(() => fromUtcMidnightTimestamp(value)).toThrow(InvalidDateError);
    },
  );
});

describe('currentDate', () => {
  it('uses the Italian calendar day', () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Rome (CET, UTC+1).
    expect(currentDate(new Date('2025-12-31T23:30:00Z'))).toBe('2026-01-01');
    // 21:59 UTC on 30 Sep is 23:59 in Rome (CEST, UTC+2).
    expect(currentDate(new Date('2026-09-30T21:59:00Z'))).toBe('2026-09-30');
    expect(currentDate(new Date('2026-09-30T22:00:00Z'))).toBe('2026-10-01');
    expect(isIsoDate(currentDate())).toBe(true);
  });
});
