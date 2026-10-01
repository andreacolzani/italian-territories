import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  anprContributions,
  buildCalendar,
  calendarDates,
  calendarPath,
  eventListContribution,
  internalEventsContribution,
  loadCalendar,
  parseCalendar,
  REGIME_BOUNDARIES,
  saveCalendar,
  serializeCalendar,
  type CalendarContribution,
} from '../../src/calendar/index.ts';
import { EVENT_LISTS, type EventListPfun } from '../../src/sources/situas-public/index.ts';
import { withTempDir } from '../helpers/http.ts';
import { withSources, type SourcesHarness } from '../helpers/sources.ts';

const START = '1861-03-17';
const TODAY = '2026-10-01';

/** `pdataa` of the full-range event list fixtures (§11.2), which were downloaded on two days. */
const FIXTURE_TO: Record<EventListPfun, string> = {
  98: '2026-09-30',
  100: '2026-10-01',
  103: '2026-10-01',
  104: '2026-09-30',
  105: '2026-09-30',
  106: '2026-10-01',
  107: '2026-10-01',
  108: '2026-10-01',
  112: '2026-10-01',
  113: '2026-10-01',
  114: '2026-10-01',
};

const UTS_RECORDS = [
  { code: '090', name: 'Sassari', type: 'province' },
  { code: '111', name: 'Sud Sardegna', type: 'province' },
  { code: '312', name: 'Sassari', type: 'metropolitan_city' },
] as const;

async function fixtureContributions(sources: SourcesHarness): Promise<CalendarContribution[]> {
  const contributions: CalendarContribution[] = [];
  for (const pfun of Object.keys(EVENT_LISTS).map(Number) as EventListPfun[]) {
    const level = EVENT_LISTS[pfun].level;
    const rows = await sources.situasPublic.fetchEventList(level, pfun, START, FIXTURE_TO[pfun]);
    contributions.push(eventListContribution(pfun, rows.data));
  }
  for (const record of UTS_RECORDS) {
    contributions.push(internalEventsContribution(5, (await sources.situasInternal.utsEvents(record)).data));
  }
  const region = await sources.situasInternal.regionEvents({ code: '01', name: 'Piemonte', type: 'region' });
  contributions.push(internalEventsContribution(4, region.data));
  const sassofeltrio = await sources.situasInternal.municipalityEvents({ code: '099031', name: 'Sassofeltrio' });
  contributions.push(internalEventsContribution(6, sassofeltrio.data));
  contributions.push(...anprContributions((await sources.anpr.fetchAnpr()).data.rows));
  return contributions;
}

describe('buildCalendar', () => {
  it('always contains the regime boundaries and today', () => {
    const calendar = buildCalendar({ start: START, today: TODAY, contributions: [] });
    expect(REGIME_BOUNDARIES).toEqual(['1861-03-17', '1927-01-12', '1948-01-01']);
    expect(calendarDates(calendar)).toEqual(['1861-03-17', '1927-01-12', '1948-01-01', TODAY]);
    expect(calendar.dates.get('1927-01-12')).toEqual(['regime']);
    expect(calendar.dates.get(TODAY)).toEqual(['today']);
  });

  it('merges sources per date and discards dates outside [start, today]', () => {
    const calendar = buildCalendar({
      start: START,
      today: TODAY,
      contributions: [
        { source: 'events:pfun-98', dates: ['1927-01-12', '1800-01-01', '2026-10-02', '1950-05-05'] },
        { source: 'r5:uts-events', dates: ['1950-05-05', '1950-05-05'] },
        { source: 'anpr:end', dates: ['1861-03-16', TODAY] },
      ],
    });
    expect(calendarDates(calendar)).toEqual(['1861-03-17', '1927-01-12', '1948-01-01', '1950-05-05', TODAY]);
    expect(calendar.dates.get('1927-01-12')).toEqual(['events:pfun-98', 'regime']);
    expect(calendar.dates.get('1950-05-05')).toEqual(['events:pfun-98', 'r5:uts-events']);
    expect(calendar.dates.get(TODAY)).toEqual(['anpr:end', 'today']);
  });

  it('uses the given today and never a later date', () => {
    const calendar = buildCalendar({
      start: START,
      today: '1930-01-01',
      contributions: [{ source: 'events:pfun-100', dates: ['1929-12-31', '1930-01-02'] }],
    });
    expect(calendarDates(calendar)).toEqual(['1861-03-17', '1927-01-12', '1929-12-31', '1930-01-01']);
    expect(() => buildCalendar({ start: START, today: '1861-03-16', contributions: [] })).toThrow(RangeError);
  });

  it('collects the dates of the real event lists, internal events and ANPR', async () => {
    await withSources(async (sources) => {
      const calendar = buildCalendar({
        start: START,
        today: TODAY,
        contributions: await fixtureContributions(sources),
      });
      const dates = calendarDates(calendar);
      expect(dates).toEqual([...new Set(dates)].sort());
      expect(dates[0]).toBe(START);
      expect(dates.at(-1)).toBe(TODAY);
      for (const boundary of REGIME_BOUNDARIES) expect(calendar.dates.get(boundary)).toContain('regime');

      // golden-1: Setteville established, Quero Vas and Alano di Piave suppressed.
      expect(calendar.dates.get('2024-01-22')).toEqual(expect.arrayContaining(['events:pfun-100', 'events:pfun-98']));
      // golden-4: Sardinia 2026, in the public UTS lists and in the internal events.
      expect(calendar.dates.get('2026-01-01')).toEqual(
        expect.arrayContaining(['events:pfun-112', 'events:pfun-113', 'r5:uts-events']),
      );
      // golden-9: cessions abroad and partial cessions (golden-18).
      expect(calendar.dates.get('1947-09-16')).toEqual(expect.arrayContaining(['events:pfun-98', 'events:pfun-103']));
      // golden-2: Sassofeltrio suppressed and reconstituted (internal r6).
      expect(calendar.dates.get('1929-05-14')).toContain('r6:municipality-events');
      expect(calendar.dates.get('1947-11-25')).toContain('r6:municipality-events');
      // golden-15: Piemonte (internal r4).
      expect([...calendar.dates.values()].some((s) => s.includes('r4:region-events'))).toBe(true);

      // ANPR boundaries are hints: DATAISTITUZIONE as such, DATACESSAZIONE + 1 (half-open end).
      const anpr = (await sources.anpr.fetchAnpr()).data.rows;
      const ceased = anpr.filter((r) => r.validTo !== null && r.validTo > START && r.validTo <= TODAY);
      expect(ceased.length).toBeGreaterThan(0);
      for (const row of ceased) expect(calendar.dates.get(row.validTo ?? '')).toContain('anpr:end');
      for (const row of anpr.filter((r) => r.validFrom >= START)) {
        expect(calendar.dates.get(row.validFrom)).toContain('anpr:start');
      }
      const anprOnly = [...calendar.dates].filter(([, s]) => s.every((x) => x.startsWith('anpr:'))).map(([d]) => d);
      for (const date of anprOnly) {
        expect(anpr.some((r) => r.validFrom === date || r.validTo === date)).toBe(true);
      }
    });
  });
});

describe('calendar.json', () => {
  it('round-trips through the store directory', async () => {
    await withTempDir(async (dir) => {
      const calendar = buildCalendar({
        start: START,
        today: TODAY,
        contributions: [{ source: 'events:pfun-104', dates: ['2009-01-29'] }],
      });
      await saveCalendar(dir, calendar);
      const text = await readFile(calendarPath(dir), 'utf8');
      expect(JSON.parse(text)).toEqual({
        start: START,
        today: TODAY,
        dates: {
          '1861-03-17': ['regime'],
          '1927-01-12': ['regime'],
          '1948-01-01': ['regime'],
          '2009-01-29': ['events:pfun-104'],
          [TODAY]: ['today'],
        },
      });
      expect(text.endsWith('}\n')).toBe(true);
      expect(await loadCalendar(dir)).toEqual(calendar);
      expect(serializeCalendar(parseCalendar(text))).toBe(text);
    });
    await withTempDir(async (dir) => {
      expect(await loadCalendar(dir)).toBeUndefined();
    });
  });

  it('rejects unknown sources', () => {
    const text = JSON.stringify({ start: START, today: TODAY, dates: { [TODAY]: ['guess'] } });
    expect(() => parseCalendar(text)).toThrow();
  });
});
