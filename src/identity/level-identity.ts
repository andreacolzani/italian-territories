/**
 * Identity resolution of one level (§6.7, Step 9): the inputs of the transition matcher built from
 * the sources of that level, then the entities with their ISTAT origin ids.
 *
 * - Municipalities: explanations and renames from the public lists 98 (`ES`, `AS`), 100 (`CS`,
 *   `AN`), 104 (`CD`) and the `CDAP` rows of 105; code changes from every pfun 105 row (§6.7
 *   rules 1–4). Internal ids (r6) are attached afterwards (§5.2).
 * - UTS and regions: explanations and code changes from the internal events of the identity graph
 *   (§6.7); public renames (114, 108) count for the name check; public establishment and
 *   suppression lists (112/113, 106/107) are cross-checks.
 *
 * Territorial events (pfun 103, `AQ`/`CE`/…) never change identity and are not read here.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import type { Level } from '../model/common.ts';
import { CodeResolver, municipalityAliases, type CodeAlias, type IntervalIndex } from '../resolve/index.ts';
import type { EventListPfunOf, EventRowByLevel, MunicipalityEventRow } from '../sources/situas-public/index.ts';
import { resolveEntities, type InternalIdentity, type ResolvedEntity } from './entities.ts';
import {
  ENDING_EVENTS,
  matchTransitions,
  RENAMING_EVENTS,
  STARTING_EVENTS,
  subjectSide,
  type TransitionEvent,
  type TransitionResult,
} from './transitions.ts';

/** Public event lists of one level by `pfun` (the full stored range, §6.3). */
export type LevelEventLists<L extends Level> = Partial<Record<EventListPfunOf<L>, readonly EventRowByLevel[L][]>>;

export interface LevelIdentityOptions<L extends Level> {
  level: L;
  index: IntervalIndex<L>;
  /** `null` when the level was not crawled or its list could not be obtained (Step 7). */
  internal: InternalIdentity | null;
  eventLists: LevelEventLists<L>;
  anomalies: AnomalyCollector;
}

export interface LevelIdentity<L extends Level = Level> {
  transitions: TransitionResult<L>;
  entities: ResolvedEntity<L>[];
  /** The resolver of the level, with its same-day aliases (§6.6). */
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
  if (level === 'municipality') {
    aliases = municipalityAliases(list(105) as readonly MunicipalityEventRow[]);
    events = publicEvents([98, 100, 104, 105]);
  } else {
    const [ending, starting, renaming] = level === 'province' ? [112, 113, 114] : [106, 107, 108];
    aliases = internal?.aliases ?? [];
    events = [...internalTransitionEvents(level, internal), ...publicEvents([renaming])];
    crossCheck = publicEvents([ending, starting]);
  }

  const resolver = new CodeResolver({ [level]: index }, aliases);
  const transitions = matchTransitions({ level, index, resolver, events, aliases, crossCheck, anomalies });
  const entities = resolveEntities({ transitions, resolver, internal, anomalies });
  return { transitions, entities, resolver };
}

/**
 * The matcher view of a public event row (§3.5 item 6): suppressions identify the subject by its
 * code on `D − 1`, establishments by its code on `D`; renames (`CD`, `CDAP`) by the related code,
 * which is the state of `D`. Other rows (code changes, territorial events) are not events of the
 * matcher: code changes are aliases.
 */
export function publicTransitionEvent(row: EventRowByLevel[Level], source: string): TransitionEvent | null {
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

/** Every internal event of the level, identified on the side of its event code. */
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
