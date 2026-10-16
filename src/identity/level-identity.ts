/**
 * §6.7. UTS and region identity comes from the internal events; their public establishment and
 * suppression lists are only cross-checks. Territorial events never change identity.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import type { Level } from '../model/common.ts';
import { CodeResolver, municipalityAliases, type CodeAlias, type IntervalIndex } from '../resolve/index.ts';
import type { EventListPfunOf, EventRowByLevel, MunicipalityEventRow } from '../sources/situas-public/index.ts';
import { resolveEntities, type InternalDataCause, type InternalIdentity, type ResolvedEntity } from './entities.ts';
import {
  ENDING_EVENTS,
  matchTransitions,
  RENAMING_EVENTS,
  STARTING_EVENTS,
  subjectSide,
  type TransitionEvent,
  type TransitionResult,
  type TypeChange,
} from './transitions.ts';
import { compareDates } from '../dates/index.ts';

/** The full stored range (§6.3). */
export type LevelEventLists<L extends Level> = Partial<Record<EventListPfunOf<L>, readonly EventRowByLevel[L][]>>;

export interface LevelIdentityOptions<L extends Level> {
  level: L;
  index: IntervalIndex<L>;
  /** `null` when the level was not crawled or its list could not be obtained. */
  internal: InternalIdentity | null;
  internalCause?: InternalDataCause;
  eventLists: LevelEventLists<L>;
  anomalies: AnomalyCollector;
}

export interface LevelIdentity<L extends Level = Level> {
  transitions: TransitionResult<L>;
  entities: ResolvedEntity<L>[];
  resolver: CodeResolver;
}

export function resolveLevelIdentity<L extends Level>(options: LevelIdentityOptions<L>): LevelIdentity<L> {
  const { level, index, internal, anomalies } = options;
  const lists = options.eventLists as Partial<Record<number, readonly EventRowByLevel[L][]>>;
  const list = (pfun: number): readonly EventRowByLevel[L][] => lists[pfun] ?? [];
  const publicEvents = (pfuns: readonly number[]): TransitionEvent[] =>
    pfuns.flatMap((pfun) => list(pfun).flatMap((row) => publicTransitionEvent(row, `events:pfun-${pfun}`) ?? []));

  let aliases: readonly CodeAlias[];
  let events: TransitionEvent[];
  let crossCheck: TransitionEvent[] = [];
  let changes: TypeChange[] = [];
  /** The resolver also follows the type changes (§6.6); the matcher links them as `type-change`. */
  let resolverAliases: readonly CodeAlias[] | null = null;
  if (level === 'municipality') {
    aliases = municipalityAliases(list(105) as readonly MunicipalityEventRow[]);
    events = publicEvents([98, 100, 104, 105]);
  } else {
    const [ending, starting, renaming] = level === 'province' ? [112, 113, 114] : [106, 107, 108];
    changes = typeChanges(level, index, internal, [...list(ending), ...list(starting)], anomalies);
    aliases = internal?.aliases ?? [];
    resolverAliases = [
      ...aliases,
      ...changes
        .filter((c) => c.from !== c.to)
        .map((c) => ({ level, date: c.date, from: c.from, to: c.to, source: 'type-change' })),
    ];
    events = [...internalTransitionEvents(level, internal), ...publicEvents([renaming])];
    crossCheck = publicEvents([ending, starting]);
  }

  const resolver = new CodeResolver({ [level]: index }, resolverAliases ?? aliases);
  const transitions = matchTransitions({
    level,
    index,
    resolver,
    events,
    aliases,
    crossCheck,
    typeChanges: changes,
    anomalies,
  });
  const entities = resolveEntities({
    transitions,
    resolver,
    internal,
    ...(options.internalCause === undefined ? {} : { internalCause: options.internalCause }),
    anomalies,
  });
  return { transitions, entities, resolver };
}

/**
 * Suppressions identify the subject on `D − 1`, establishments on `D`, renames by the related code,
 * the state of `D` (§3.5 item 6). Code changes are aliases, not events of the matcher.
 */
function publicTransitionEvent(row: EventRowByLevel[Level], source: string): TransitionEvent | null {
  const cadastral = 'cadastralCode' in row ? row.cadastralCode : null;
  const base = { event: row.event, date: row.date, source };
  if (ENDING_EVENTS.includes(row.event) || STARTING_EVENTS.includes(row.event)) {
    return { ...base, code: row.code, side: subjectSide(row.event), cadastralCode: cadastral };
  }
  if (RENAMING_EVENTS.includes(row.event)) {
    const related = row.related;
    const relatedCadastral = related !== null && 'cadastralCode' in related ? related.cadastralCode : null;
    return {
      ...base,
      code: related?.code ?? row.code,
      side: 'successor',
      cadastralCode: relatedCadastral ?? cadastral,
    };
  }
  return null;
}

const LEVEL_IDENTITY_ANOMALIES = {
  typeChangeUnconfirmed: 'type-change-unconfirmed',
} as const;

/**
 * D35: a `CSCT` on `d` pairs with the component member whose interval ends on `d`, whatever its own
 * events (`ES` for the compartments of 1948, none for Venezia Tridentina `82` → Trentino-Alto Adige
 * `04`). Without an `ESCT` of the member or the public lists to confirm it, the pairing is a `warning`.
 */
function typeChanges<L extends Level>(
  level: L,
  index: IntervalIndex<L>,
  internal: InternalIdentity | null,
  publicRows: readonly EventRowByLevel[L][],
  anomalies: AnomalyCollector,
): TypeChange[] {
  const all = index.all();
  const changes: TypeChange[] = [];
  for (const component of internal?.components ?? []) {
    const members = new Set(component.events.map((e) => e.code));
    for (const e of component.events.filter((x) => x.event === 'CSCT')) {
      const closing = [...new Set(all.filter((i) => i.validTo === e.date && members.has(i.code)).map((i) => i.code))];
      const [from] = closing;
      if (closing.length !== 1 || from === undefined) continue;
      if (changes.some((c) => c.date === e.date && c.from === from && c.to === e.code)) continue;
      const change = { date: e.date, from, to: e.code };
      changes.push(change);
      // An `ESCT` of the member is the documented pairing (§6.6); only the inferred ones are checked.
      const documented = component.events.some((x) => x.event === 'ESCT' && x.date === e.date && x.code === from);
      const confirmed =
        documented ||
        publicRows.some(
          (row) =>
            row.date === e.date &&
            ((row.event === 'ESCT' && row.code === from && row.related?.code === e.code) ||
              (row.event === 'CSCT' && row.code === e.code && row.related?.code === from)),
        );
      if (confirmed) continue;
      anomalies.add({
        level: 'warning',
        code: LEVEL_IDENTITY_ANOMALIES.typeChangeUnconfirmed,
        message: `${level} type change ${from} → ${e.code} on ${e.date} (component ${component.root}) is not in the public lists`,
        context: { level, date: e.date, from, to: e.code, root: component.root },
      });
    }
  }
  return changes.sort((a, b) => compareDates(a.date, b.date) || compareCodes(a.from, b.from));
}

function compareCodes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function internalTransitionEvents(level: Level, internal: InternalIdentity | null): TransitionEvent[] {
  const source = level === 'province' ? 'r5:uts-events' : 'r4:region-events';
  return (internal?.components ?? []).flatMap((component) =>
    component.events.map((e) => ({
      event: e.event,
      date: e.date,
      code: e.code,
      side: subjectSide(e.event),
      cadastralCode: null,
      source,
    })),
  );
}
