/**
 * Same-day code aliases (§6.6 step 2, §3.5 item 7): code changes on a date `D`, mapping the code
 * of `D − 1` to the code of `D`. They let the resolver reach a territory through a code that
 * never appears in any snapshot because it was assigned and dropped on the same day (e.g.
 * Finalborgo `010877` → `009813` on 1927-01-12, suppressed the same day under `009813`).
 *
 * - Municipalities: every pfun 105 row (`RN`, `AP`, `CDAP`, `RNAPUTS`): `PRO_COM_T` is the code
 *   of `D − 1` and `PRO_COM_T_REL` the code of `D` (verified: Finalborgo `010877` (Genova) →
 *   `009813` (Savona)).
 * - UTS and regions, from the internal events of one identity component (§5.1):
 *   - `RN` keeps the record id and carries only the new code (Nuoro `114` in 2026): the old code
 *     is the one of the record's last event before `D` (Nuoro `091`);
 *   - a type change pairs the `ESCT` codes with the `CSCT` codes of the same component on `D`
 *     (Sassari `090` → `312` in 2026; Cagliari `092` → `292` in 2016).
 */
import { compareDates, type IsoDate } from '../dates/index.ts';
import type { IstatEventCode, Level } from '../model/common.ts';
import type { IdentityGraph } from '../identity/index.ts';
import type { MunicipalityEventRow } from '../sources/situas-public/index.ts';

export interface CodeAlias {
  level: Level;
  /** Day of the code change. */
  date: IsoDate;
  /** Code on `date − 1`. */
  from: string;
  /** Code on `date`. */
  to: string;
  /** Endpoint id of the source rows (`events:pfun-105`, `r5:uts-events`, `r4:region-events`). */
  source: string;
}

/** Aliases of the pfun 105 rows. Rows without a related code or without a code change add none. */
export function municipalityAliases(rows: readonly MunicipalityEventRow[]): CodeAlias[] {
  return dedupe(
    rows.flatMap((row) =>
      row.related?.code == null || row.related.code === row.code
        ? []
        : [{ level: 'municipality', date: row.date, from: row.code, to: row.related.code, source: 'events:pfun-105' }],
    ),
  );
}

/** What the alias builder needs of an internal event. */
export interface InternalAliasEvent {
  event: IstatEventCode;
  date: IsoDate;
  /** Code at the time of the event (§3.3). */
  code: string;
  /** The typed ISTAT record of the event (`id_uts`; `id_regione_origine` for regions). */
  recordId: number;
}

/** Aliases of the `RN` and type change events of every component of an identity graph. */
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

/** Codes of the last events of `recordId` dated before `date`. */
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
