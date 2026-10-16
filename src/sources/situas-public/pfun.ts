/** Requests are unencoded (§11.1): the HTTP client encodes them. */
import { compareDates, toItalianDate, type IsoDate } from '../../dates/index.ts';
import type { HttpRequest } from '../../http/index.ts';
import type { IstatEventCode, Level } from '../../model/common.ts';

/** SITUAS constants, not configuration: they select which `pfun` answers for a date. */
export const REGIME_1927_START: IsoDate = '1927-01-12';
export const REGIME_1948_START: IsoDate = '1948-01-01';

/** Snapshot `pfun` per level, indexed by regime: ≤1927-01-11, 1927-01-12…1947-12-31, ≥1948-01-01. */
export const SNAPSHOT_PFUNS = {
  region: [44, 46, 68],
  province: [48, 49, 64],
  municipality: [51, 50, 61],
} as const satisfies Record<Level, readonly [number, number, number]>;

export type SnapshotPfun = (typeof SNAPSHOT_PFUNS)[Level][number];

export function regimeOf(date: IsoDate): 0 | 1 | 2 {
  if (compareDates(date, REGIME_1927_START) < 0) return 0;
  if (compareDates(date, REGIME_1948_START) < 0) return 1;
  return 2;
}

export function snapshotPfun(level: Level, date: IsoDate): SnapshotPfun {
  return SNAPSHOT_PFUNS[level][regimeOf(date)];
}

export function describeSnapshotPfun(pfun: number): { level: Level; regime: 0 | 1 | 2 } | undefined {
  for (const [level, pfuns] of Object.entries(SNAPSHOT_PFUNS) as [Level, readonly number[]][]) {
    const regime = pfuns.indexOf(pfun);
    if (regime >= 0) return { level, regime: regime as 0 | 1 | 2 };
  }
  return undefined;
}

/** Any other event code in a row is a permanent validation error (D21). */
export const EVENT_LISTS = {
  106: { level: 'region', events: ['ES', 'ESCT', 'AS'] },
  107: { level: 'region', events: ['CS', 'CSCT', 'AN'] },
  108: { level: 'region', events: ['CD'] },
  112: { level: 'province', events: ['ES', 'ESCT', 'AS'] },
  113: { level: 'province', events: ['CS', 'CSCT', 'AN'] },
  114: { level: 'province', events: ['CD'] },
  98: { level: 'municipality', events: ['ES', 'AS'] },
  100: { level: 'municipality', events: ['CS', 'AN'] },
  103: { level: 'municipality', events: ['AQES', 'CE', 'AQ', 'CECS'] },
  104: { level: 'municipality', events: ['CD'] },
  105: { level: 'municipality', events: ['RN', 'AP', 'CDAP', 'RNAPUTS'] },
} as const satisfies Record<number, { level: Level; events: readonly IstatEventCode[] }>;

export type EventListPfun = keyof typeof EVENT_LISTS;
export type EventListPfunOf<L extends Level> = {
  [P in EventListPfun]: (typeof EVENT_LISTS)[P]['level'] extends L ? P : never;
}[EventListPfun];

export function isEventListPfun(pfun: number): pfun is EventListPfun {
  return Object.hasOwn(EVENT_LISTS, pfun);
}

export type CountParams = { date: IsoDate } | { from: IsoDate; to: IsoDate };

const LIST_PATH = 'reportspooljson';
const COUNT_PATH = 'reportspooljsoncount';

function publicUrl(baseUrl: string, path: string, query: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path}?${query}`;
}

function paramsQuery(pfun: number, params: CountParams): string {
  return 'date' in params
    ? `pfun=${pfun}&pdata=${toItalianDate(params.date)}`
    : `pfun=${pfun}&pdatada=${toItalianDate(params.from)}&pdataa=${toItalianDate(params.to)}`;
}

export function snapshotRequest(baseUrl: string, pfun: SnapshotPfun, date: IsoDate): HttpRequest {
  return { method: 'GET', url: publicUrl(baseUrl, LIST_PATH, paramsQuery(pfun, { date })) };
}

export function eventListRequest(baseUrl: string, pfun: EventListPfun, from: IsoDate, to: IsoDate): HttpRequest {
  return { method: 'GET', url: publicUrl(baseUrl, LIST_PATH, paramsQuery(pfun, { from, to })) };
}

export function countRequest(baseUrl: string, pfun: SnapshotPfun | EventListPfun, params: CountParams): HttpRequest {
  return { method: 'GET', url: publicUrl(baseUrl, COUNT_PATH, paramsQuery(pfun, params)) };
}
