/**
 * Pure calendar-date arithmetic on ISO `YYYY-MM-DD` strings (§4.1).
 *
 * Dates are converted to a day number (days since 1970-01-01 in the proleptic Gregorian calendar)
 * with integer arithmetic only, so no `Date` object and no timezone is ever involved.
 * Supported years: 0001–9999 (the ISO string always has four year digits).
 */

/** ISO calendar date `YYYY-MM-DD`. */
export type IsoDate = string;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Unification of Italy: lower bound of the dataset (§1.2). */
export const UNIFICATION_DATE: IsoDate = '1861-03-17';

const MIN_YEAR = 1;
const MAX_YEAR = 9999;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ITALIAN_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
/** SITUAS public event lists: `YYYY-MM-DDT00:00:00Z` (optionally with zero milliseconds). */
const UTC_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0{1,3})?Z$/;

export class InvalidDateError extends Error {
  constructor(value: unknown, expected: string) {
    super(`invalid date ${JSON.stringify(value)}: expected ${expected}`);
    this.name = 'InvalidDateError';
  }
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function isValidCalendarDate({ year, month, day }: CalendarDate): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= MIN_YEAR &&
    year <= MAX_YEAR &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

function matchIsoDate(value: string): CalendarDate | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isValidCalendarDate(date) ? date : null;
}

/** True iff `value` is a well-formed, existing calendar date (e.g. rejects `1900-02-29`). */
export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === 'string' && matchIsoDate(value) !== null;
}

/** Throws unless `value` is a valid ISO date; returns it narrowed. */
export function assertIsoDate(value: unknown): IsoDate {
  if (!isIsoDate(value)) throw new InvalidDateError(value, 'YYYY-MM-DD');
  return value;
}

export function parseIsoDate(value: string): CalendarDate {
  const date = matchIsoDate(value);
  if (date === null) throw new InvalidDateError(value, 'YYYY-MM-DD');
  return date;
}

export function formatIsoDate(date: CalendarDate): IsoDate {
  if (!isValidCalendarDate(date)) throw new InvalidDateError(date, 'a valid calendar date');
  const { year, month, day } = date;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Days since 1970-01-01 (negative before). Algorithm "days_from_civil" by Howard Hinnant,
 * exact for the whole proleptic Gregorian calendar.
 */
export function toDayNumber(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Inverse of {@link toDayNumber} ("civil_from_days"). */
export function fromDayNumber(dayNumber: number): IsoDate {
  if (!Number.isSafeInteger(dayNumber)) throw new InvalidDateError(dayNumber, 'an integer day number');
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return formatIsoDate({ year, month, day });
}

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isSafeInteger(days)) throw new RangeError(`days must be an integer, got ${days}`);
  return fromDayNumber(toDayNumber(date) + days);
}

export function subtractDays(date: IsoDate, days: number): IsoDate {
  return addDays(date, -days);
}

export function nextDay(date: IsoDate): IsoDate {
  return addDays(date, 1);
}

export function previousDay(date: IsoDate): IsoDate {
  return addDays(date, -1);
}

/** Signed number of days from `from` to `to` (`to − from`). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toDayNumber(to) - toDayNumber(from);
}

/**
 * Three-way comparison usable with `Array.prototype.sort`. Both operands are validated,
 * so malformed strings never compare "successfully" by accident.
 */
export function compareDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  parseIsoDate(a);
  parseIsoDate(b);
  // Validated fixed-width ISO strings order lexicographically like the dates they denote.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isBefore(a: IsoDate, b: IsoDate): boolean {
  return compareDates(a, b) < 0;
}

export function isAfter(a: IsoDate, b: IsoDate): boolean {
  return compareDates(a, b) > 0;
}

export function minDate(first: IsoDate, ...rest: IsoDate[]): IsoDate {
  return rest.reduce((min, d) => (isBefore(d, min) ? d : min), assertIsoDate(first));
}

export function maxDate(first: IsoDate, ...rest: IsoDate[]): IsoDate {
  return rest.reduce((max, d) => (isAfter(d, max) ? d : max), assertIsoDate(first));
}

/** True iff `from <= date <= to` (inclusive on both sides). */
export function isBetweenInclusive(date: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return compareDates(from, date) <= 0 && compareDates(date, to) <= 0;
}

/** True iff `date` lies within the dataset period `[1861-03-17, today]` (§6.4). */
export function isInDatasetRange(date: IsoDate, today: IsoDate): boolean {
  return isBetweenInclusive(date, UNIFICATION_DATE, today);
}

/** `DD/MM/YYYY` (SITUAS internal API responses, public API parameters) → ISO. */
export function fromItalianDate(value: string): IsoDate {
  const match = ITALIAN_DATE.exec(value);
  if (!match) throw new InvalidDateError(value, 'DD/MM/YYYY');
  const date = { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) };
  if (!isValidCalendarDate(date)) throw new InvalidDateError(value, 'DD/MM/YYYY');
  return formatIsoDate(date);
}

/** ISO → `DD/MM/YYYY` (SITUAS public API `pdata`, `pdatada`, `pdataa` parameters). */
export function toItalianDate(date: IsoDate): string {
  const { year, month, day } = parseIsoDate(date);
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(year).padStart(4, '0')}`;
}

/**
 * `YYYY-MM-DDT00:00:00Z` (SITUAS public event lists, `DATA_INIZIO_AMMINISTRATIVA`) → ISO.
 * Any time other than midnight UTC is rejected: it would mean the source changed semantics.
 */
export function fromUtcMidnightTimestamp(value: string): IsoDate {
  const match = UTC_MIDNIGHT.exec(value);
  if (!match?.[1] || !isIsoDate(match[1])) throw new InvalidDateError(value, 'YYYY-MM-DDT00:00:00Z');
  return match[1];
}

/**
 * Current calendar date in Italy. The only place where a `Date` is read; everything else is
 * pure arithmetic on ISO strings.
 */
export function currentDate(now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  return formatIsoDate({ year: part('year'), month: part('month'), day: part('day') });
}
