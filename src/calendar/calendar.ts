/**
 * Breakpoint calendar (§6.4): the union of
 * - event dates of the public lists and of the internal event reports (r4–r6);
 * - ANPR `DATAISTITUZIONE` and `DATACESSAZIONE + 1` (hints only);
 * - the regime boundaries `1861-03-17`, `1927-01-12`, `1948-01-01`;
 * - today.
 * Dates outside `[start, today]` are discarded. One calendar serves all three levels. Each date
 * keeps the sources that contributed it (`calendar.json` in the store).
 *
 * The builder never reads the clock: `today` is passed in (§12 Determinism).
 */
import { join } from 'node:path';
import { z } from 'zod';
import { compareDates, isAfter, isBetweenInclusive, UNIFICATION_DATE, type IsoDate } from '../dates/index.ts';
import { isoDateSchema } from '../model/public.ts';
import type { AnprRecord } from '../sources/anpr/index.ts';
import { INTERNAL_REPORTS } from '../sources/situas-internal/index.ts';
import {
  EVENT_LISTS,
  REGIME_1927_START,
  REGIME_1948_START,
  type EventListPfun,
} from '../sources/situas-public/index.ts';
import { readTextIfExists, toJsonDocument, writeFileAtomic } from '../store/fs.ts';

/** First days of the three snapshot regimes (§2 Regime). */
export const REGIME_BOUNDARIES: readonly IsoDate[] = [UNIFICATION_DATE, REGIME_1927_START, REGIME_1948_START];

/** Internal reports listing the events of one record (§3.3). */
export type InternalEventReport = 4 | 5 | 6;

const EVENT_LIST_SOURCES = (Object.keys(EVENT_LISTS).map(Number) as EventListPfun[]).map(
  (pfun) => `events:pfun-${pfun}` as const,
);
const INTERNAL_EVENT_SOURCES = [
  INTERNAL_REPORTS[4].endpoint,
  INTERNAL_REPORTS[5].endpoint,
  INTERNAL_REPORTS[6].endpoint,
];

/**
 * Provenance of a calendar date: an event list or internal event report (by endpoint id), an
 * ANPR boundary, a regime boundary, today, or a breakpoint found by completeness bisection
 * (`inferred`, §6.5).
 */
export const CALENDAR_SOURCES = [
  ...EVENT_LIST_SOURCES,
  ...INTERNAL_EVENT_SOURCES,
  'anpr:start',
  'anpr:end',
  'regime',
  'today',
  'inferred',
] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

export interface CalendarContribution {
  source: CalendarSource;
  dates: Iterable<IsoDate>;
}

export interface Calendar {
  start: IsoDate;
  today: IsoDate;
  /** Ascending dates, each with its sources (sorted, unique). */
  dates: Map<IsoDate, CalendarSource[]>;
}

export interface CalendarOptions {
  /** Lower bound of the dataset (`dates.start`). */
  start: IsoDate;
  /** Reference date (`dates.today`, resolved at the CLI boundary). */
  today: IsoDate;
  contributions: Iterable<CalendarContribution>;
}

export function buildCalendar(options: CalendarOptions): Calendar {
  const { start, today } = options;
  if (isAfter(start, today)) throw new RangeError(`today (${today}) is before the dataset start (${start})`);
  const bySource = new Map<IsoDate, Set<CalendarSource>>();
  const add = (source: CalendarSource, date: IsoDate): void => {
    if (!isBetweenInclusive(date, start, today)) return;
    let sources = bySource.get(date);
    if (sources === undefined) bySource.set(date, (sources = new Set()));
    sources.add(source);
  };
  for (const date of REGIME_BOUNDARIES) add('regime', date);
  add('today', today);
  for (const { source, dates } of options.contributions) for (const date of dates) add(source, date);

  const dates = new Map<IsoDate, CalendarSource[]>();
  for (const date of [...bySource.keys()].sort(compareDates)) {
    const sources = [...(bySource.get(date) ?? [])].sort();
    // A published event explains the change: the date is no longer inferred.
    const explained = sources.some((s) => EVENT_SOURCES.has(s));
    dates.set(date, explained ? sources.filter((s) => s !== 'inferred') : sources);
  }
  return { start, today, dates };
}

/** Sources that are published events (public lists and internal event reports). */
const EVENT_SOURCES: ReadonlySet<CalendarSource> = new Set([...EVENT_LIST_SOURCES, ...INTERNAL_EVENT_SOURCES]);

/** Ascending calendar dates. */
export function calendarDates(calendar: Calendar): IsoDate[] {
  return [...calendar.dates.keys()];
}

/** A copy of `calendar` with `contributions` added (same bounds). */
export function extendCalendar(calendar: Calendar, contributions: Iterable<CalendarContribution>): Calendar {
  const existing = [...calendar.dates].flatMap(([date, sources]) =>
    sources.map((source) => ({ source, dates: [date] })),
  );
  return buildCalendar({
    start: calendar.start,
    today: calendar.today,
    contributions: [...existing, ...contributions],
  });
}

/**
 * A copy of `calendar` without `source` on `dates`; a date left without sources leaves the
 * calendar (e.g. an inferred breakpoint a refetch no longer confirms).
 */
export function removeCalendarSource(calendar: Calendar, source: CalendarSource, dates: Iterable<IsoDate>): Calendar {
  const targets = new Set(dates);
  const kept = new Map<IsoDate, CalendarSource[]>();
  for (const [date, sources] of calendar.dates) {
    const rest = targets.has(date) ? sources.filter((s) => s !== source) : sources;
    if (rest.length > 0) kept.set(date, rest);
  }
  return { start: calendar.start, today: calendar.today, dates: kept };
}

export function eventListContribution(pfun: EventListPfun, rows: readonly { date: IsoDate }[]): CalendarContribution {
  return { source: `events:pfun-${pfun}`, dates: rows.map((r) => r.date) };
}

export function internalEventsContribution(
  report: InternalEventReport,
  rows: readonly { date: IsoDate }[],
): CalendarContribution {
  return { source: INTERNAL_REPORTS[report].endpoint, dates: rows.map((r) => r.date) };
}

/** `DATAISTITUZIONE` and `DATACESSAZIONE + 1` (the adapter's half-open `validTo`), as hints. */
export function anprContributions(rows: readonly AnprRecord[]): CalendarContribution[] {
  return [
    { source: 'anpr:start', dates: rows.map((r) => r.validFrom) },
    { source: 'anpr:end', dates: rows.flatMap((r) => (r.validTo === null ? [] : [r.validTo])) },
  ];
}

// ---------------------------------------------------------------------------------------------
// calendar.json
// ---------------------------------------------------------------------------------------------

export const CALENDAR_FILE = 'calendar.json';

const calendarFileSchema = z.strictObject({
  start: isoDateSchema,
  today: isoDateSchema,
  dates: z.record(isoDateSchema, z.array(z.enum(CALENDAR_SOURCES)).nonempty()),
});

export function calendarPath(storeDir: string): string {
  return join(storeDir, CALENDAR_FILE);
}

export function serializeCalendar(calendar: Calendar): string {
  return toJsonDocument({ start: calendar.start, today: calendar.today, dates: Object.fromEntries(calendar.dates) });
}

export function parseCalendar(text: string): Calendar {
  const file = calendarFileSchema.parse(JSON.parse(text));
  const contributions = Object.entries(file.dates).flatMap(([date, sources]) =>
    sources.map((source) => ({ source, dates: [date] })),
  );
  return buildCalendar({ start: file.start, today: file.today, contributions });
}

export async function saveCalendar(storeDir: string, calendar: Calendar): Promise<void> {
  await writeFileAtomic(calendarPath(storeDir), serializeCalendar(calendar));
}

/** The stored calendar, or `undefined` if none was saved. */
export async function loadCalendar(storeDir: string): Promise<Calendar | undefined> {
  const text = await readTextIfExists(calendarPath(storeDir));
  return text === undefined ? undefined : parseCalendar(text);
}
