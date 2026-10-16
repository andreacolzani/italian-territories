/**
 * Same-day code aliases (§6.6, §3.5 item 7): a code assigned and dropped on the same day appears in
 * no snapshot (Finalborgo `010877` → `009813` on 1927-01-12). In pfun 105 `PRO_COM_T` is the code
 * of `D − 1` and `PRO_COM_T_REL` the code of `D`. An internal `RN` keeps the record id and carries
 * only the new code, so the old one comes from the record's last earlier event.
 */
import { compareDates, type IsoDate } from '../dates/index.ts';
import type { IstatEventCode, Level } from '../model/common.ts';
import type { IdentityGraph } from '../identity/index.ts';
import type { MunicipalityEventRow } from '../sources/situas-public/index.ts';

export interface CodeAlias {
  level: Level;
  date: IsoDate;
  /** Code on `date − 1`. */
  from: string;
  to: string;
  source: string;
}

export function municipalityAliases(rows: readonly MunicipalityEventRow[]): CodeAlias[] {
  return dedupe(
    rows.flatMap((row) =>
      row.related?.code == null || row.related.code === row.code
        ? []
        : [{ level: 'municipality', date: row.date, from: row.code, to: row.related.code, source: 'events:pfun-105' }],
    ),
  );
}

export interface InternalAliasEvent {
  event: IstatEventCode;
  date: IsoDate;
  code: string;
  /** `id_uts`; `id_regione_origine` for regions. */
  recordId: number;
}

export function internalAliases<E>(
  graph: IdentityGraph<E>,
  view: (event: E) => InternalAliasEvent,
  source: string,
): CodeAlias[] {
  const aliases: CodeAlias[] = [];
  const add = (date: IsoDate, from: string, to: string): void => {
    if (from !== to) aliases.push({ level: graph.level, date, from, to, source });
  };
  for (const component of graph.components) {
    const events = component.events.map(view);
    for (const e of events) {
      if (e.event === 'RN') {
        for (const code of codesBefore(events, e.recordId, e.date)) add(e.date, code, e.code);
      } else if (e.event === 'ESCT') {
        for (const next of events) if (next.event === 'CSCT' && next.date === e.date) add(e.date, e.code, next.code);
      }
    }
  }
  return dedupe(aliases);
}

function codesBefore(events: readonly InternalAliasEvent[], recordId: number, date: IsoDate): string[] {
  const earlier = events.filter((e) => e.recordId === recordId && compareDates(e.date, date) < 0);
  const last = earlier.reduce<IsoDate | undefined>(
    (max, e) => (max === undefined || compareDates(e.date, max) > 0 ? e.date : max),
    undefined,
  );
  return [...new Set(earlier.filter((e) => e.date === last).map((e) => e.code))];
}

function dedupe(aliases: readonly CodeAlias[]): CodeAlias[] {
  const unique = new Map(aliases.map((a) => [`${a.level}|${a.date}|${a.from}|${a.to}`, a]));
  return [...unique.values()];
}
