/**
 * §6.7, from public data and event rows only. An explicit code change is stronger evidence than code
 * equality (two codes swapped on the same day). A name change without `CD`/`CDAP` is only a
 * `warning`: ISTAT has known inconsistencies. Origin ids are attached afterwards (§5.2).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import type { IsoDate } from '../dates/index.ts';
import type { IstatEventCode, Level } from '../model/common.ts';
import {
  ResolutionError,
  type CodeAlias,
  type CodeResolver,
  type IntervalIndex,
  type ResolutionSide,
  type SnapshotInterval,
} from '../resolve/index.ts';

export interface TransitionEvent {
  event: IstatEventCode;
  /** First day of the new state. */
  date: IsoDate;
  /** Code identifying the territory on its side: `date − 1` for a predecessor, `date` otherwise. */
  code: string;
  side: ResolutionSide;
  cadastralCode: string | null;
  source: string;
}

export const ENDING_EVENTS: readonly IstatEventCode[] = ['ES', 'ESCT', 'AS'];
export const STARTING_EVENTS: readonly IstatEventCode[] = ['CS', 'CSCT', 'AN'];
export const RENAMING_EVENTS: readonly IstatEventCode[] = ['CD', 'CDAP'];

/** Side of the subject of an event: suppressions identify it on `D − 1` (§3.5 item 6). */
export function subjectSide(event: IstatEventCode): ResolutionSide {
  return ENDING_EVENTS.includes(event) ? 'predecessor' : 'successor';
}

export type TransitionRule = 'code-change' | 'type-change' | 'same-code' | 'cadastral';

/** `from` may equal `to`. */
export interface TypeChange {
  date: IsoDate;
  from: string;
  to: string;
}

export interface IntervalLink {
  date: IsoDate;
  /** Interval keys (`<code>@<validFrom>`). */
  from: string;
  to: string;
  rule: TransitionRule;
}

export interface TransitionResult<L extends Level = Level> {
  level: L;
  intervals: ReadonlyMap<string, SnapshotInterval<L>>;
  links: IntervalLink[];
  ends: ReadonlyMap<string, IstatEventCode[]>;
  starts: ReadonlyMap<string, IstatEventCode[]>;
  chains: SnapshotInterval<L>[][];
  renamesWithoutEvent: IntervalLink[];
}

export interface MatchTransitionsOptions<L extends Level> {
  level: L;
  index: IntervalIndex<L>;
  /** Built with the same aliases. */
  resolver: CodeResolver;
  events: readonly TransitionEvent[];
  aliases: readonly CodeAlias[];
  crossCheck?: readonly TransitionEvent[];
  typeChanges?: readonly TypeChange[];
  anomalies: AnomalyCollector;
}

export const TRANSITION_ANOMALIES = {
  unexplained: 'transition-unexplained',
  conflict: 'identity-transition-conflict',
  cadastral: 'identity-cadastral-continuity',
  nameChange: 'name-change-without-event',
  publicEventUnmatched: 'identity-public-event-unmatched',
} as const;

export function matchTransitions<L extends Level>(options: MatchTransitionsOptions<L>): TransitionResult<L> {
  const { level, resolver, anomalies } = options;
  const all = options.index.all();
  const intervals = new Map(all.map((i) => [keyOf(i), i]));
  const closing = groupBy(
    all.filter((i) => i.validTo !== null),
    (i) => i.validTo ?? '',
  );
  const opening = groupBy(all, (i) => i.validFrom);

  const resolve = (code: string, date: IsoDate, side: ResolutionSide, cadastralCode: string | null = null) => {
    try {
      return resolver.resolve({ level, code, date, side, cadastralCode });
    } catch (error) {
      // Unresolved rows have no effect on continuity; every row is accounted for by the
      // variation builder (I14).
      if (error instanceof ResolutionError) return null;
      throw error;
    }
  };

  // An event explains or renames something only on a date where intervals open or close.
  const boundaries = new Set([...closing.keys(), ...opening.keys()]);
  const ends = new Map<string, IstatEventCode[]>();
  const starts = new Map<string, IstatEventCode[]>();
  const renamed = new Set<string>();
  for (const e of options.events.filter((e) => boundaries.has(e.date))) {
    const resolution = resolve(e.code, e.date, e.side, e.cadastralCode);
    if (resolution === null) continue;
    const { interval, intervalKey } = resolution;
    if (ENDING_EVENTS.includes(e.event) && interval.validTo === e.date) addCode(ends, intervalKey, e.event);
    else if (STARTING_EVENTS.includes(e.event) && interval.validFrom === e.date) addCode(starts, intervalKey, e.event);
    else if (RENAMING_EVENTS.includes(e.event) && interval.validFrom === e.date) renamed.add(intervalKey);
  }

  const links: IntervalLink[] = [];
  const linked = new Set<string>();
  for (const alias of options.aliases.filter((a) => boundaries.has(a.date))) {
    const from = resolve(alias.from, alias.date, 'predecessor');
    const to = resolve(alias.to, alias.date, 'successor');
    if (from === null || to === null) continue;
    if (from.interval.validTo !== alias.date || to.interval.validFrom !== alias.date) continue;
    const key = `${from.intervalKey}|${to.intervalKey}`;
    if (linked.has(key)) continue;
    linked.add(key);
    links.push({ date: alias.date, from: from.intervalKey, to: to.intervalKey, rule: 'code-change' });
  }
  // A type change links its two intervals even when the internal events are `ES` and `CSCT`.
  for (const change of (options.typeChanges ?? []).filter((c) => boundaries.has(c.date))) {
    const from = resolve(change.from, change.date, 'predecessor');
    const to = resolve(change.to, change.date, 'successor');
    if (from === null || to === null) continue;
    if (from.interval.validTo !== change.date || to.interval.validFrom !== change.date) continue;
    const key = `${from.intervalKey}|${to.intervalKey}`;
    if (linked.has(key)) continue;
    linked.add(key);
    links.push({ date: change.date, from: from.intervalKey, to: to.intervalKey, rule: 'type-change' });
  }
  const changedFrom = new Set(links.map((l) => l.from));
  const changedTo = new Set(links.map((l) => l.to));
  for (const [date, closed] of closing) {
    const openedByCode = new Map((opening.get(date) ?? []).map((i) => [i.code, i]));
    for (const x of closed) {
      const y = openedByCode.get(x.code);
      if (y === undefined) continue;
      const from = keyOf(x);
      const to = keyOf(y);
      const reused = ends.has(from) && starts.has(to);
      if (!reused && !changedFrom.has(from) && !changedTo.has(to)) links.push({ date, from, to, rule: 'same-code' });
    }
  }

  const kept = dropConflicts(level, links, anomalies);
  const linkedFrom = new Set(kept.map((l) => l.from));
  const linkedTo = new Set(kept.map((l) => l.to));
  for (const date of [...boundaries].sort()) {
    const closed = (closing.get(date) ?? []).filter((i) => !linkedFrom.has(keyOf(i)) && !ends.has(keyOf(i)));
    const opened = (opening.get(date) ?? []).filter(
      (i) => i.validFrom !== all[0]?.validFrom && !linkedTo.has(keyOf(i)) && !starts.has(keyOf(i)),
    );
    const inferred = level === 'municipality' ? cadastralPairs(closed, opened) : [];
    for (const [x, y] of inferred) {
      kept.push({ date, from: keyOf(x), to: keyOf(y), rule: 'cadastral' });
      anomalies.add({
        level: 'warning',
        code: TRANSITION_ANOMALIES.cadastral,
        message: `${level} ${x.code} → ${y.code} on ${date}: same cadastral code, no events; treated as the same territory`,
        context: { level, date, from: keyOf(x), to: keyOf(y), cadastral_code: cadastralOf(x) },
      });
    }
    const paired = new Set(inferred.flat());
    for (const [interval, side] of [
      ...closed.map((i) => [i, 'closed'] as const),
      ...opened.map((i) => [i, 'opened'] as const),
    ]) {
      if (paired.has(interval)) continue;
      anomalies.add({
        level: 'blocking',
        code: TRANSITION_ANOMALIES.unexplained,
        message: `${level} ${interval.code} ${nameOf(interval)} ${side === 'closed' ? 'disappears' : 'appears'} on ${date} without continuity or events`,
        context: { level, date, interval: keyOf(interval), side, row: interval.row },
      });
    }
  }

  // A type change (ESCT/CSCT or an inferred pairing) brings the name of the new typed record: it
  // explains a change of name along its link (§6.7; e.g. Emilia → Emilia-Romagna in 1948).
  const typeChange = (link: IntervalLink, from: SnapshotInterval<L>, to: SnapshotInterval<L>): boolean =>
    link.rule === 'type-change' ||
    (options.typeChanges ?? []).some((c) => c.date === link.date && c.from === from.code && c.to === to.code);
  const renamesWithoutEvent: IntervalLink[] = [];
  for (const link of kept) {
    const from = intervals.get(link.from);
    const to = intervals.get(link.to);
    if (from === undefined || to === undefined || nameOf(from) === nameOf(to) || renamed.has(link.to)) continue;
    if (typeChange(link, from, to)) continue;
    renamesWithoutEvent.push(link);
    anomalies.add({
      level: 'warning',
      code: TRANSITION_ANOMALIES.nameChange,
      message: `${level} ${from.code} renamed ${nameOf(from)} → ${nameOf(to)} on ${link.date} without a CD/CDAP event`,
      context: { level, date: link.date, from: link.from, to: link.to, names: [nameOf(from), nameOf(to)] },
    });
  }

  const typeChanged = (e: TransitionEvent): boolean =>
    (options.typeChanges ?? []).some(
      (c) => c.date === e.date && (e.event === 'ESCT' ? c.from === e.code : e.event === 'CSCT' && c.to === e.code),
    );
  for (const e of options.crossCheck ?? []) {
    const explained = ENDING_EVENTS.includes(e.event) ? ends : STARTING_EVENTS.includes(e.event) ? starts : null;
    if (explained === null || typeChanged(e)) continue;
    const resolution = resolve(e.code, e.date, e.side, e.cadastralCode);
    const boundary = explained === ends ? resolution?.interval.validTo : resolution?.interval.validFrom;
    if (resolution !== null && boundary === e.date && explained.get(resolution.intervalKey)?.includes(e.event)) {
      continue;
    }
    anomalies.add({
      level: 'warning',
      code: TRANSITION_ANOMALIES.publicEventUnmatched,
      message: `${level} ${e.event} of ${e.code} on ${e.date} (${e.source}) is not explained by an internal event`,
      context: { level, event: e.event, date: e.date, code: e.code, source: e.source },
    });
  }

  const byDate = (a: IntervalLink, b: IntervalLink): number =>
    compareStrings(a.date, b.date) || compareStrings(a.from, b.from);
  kept.sort(byDate);
  renamesWithoutEvent.sort(byDate);
  return {
    level,
    intervals,
    links: kept,
    ends,
    starts,
    chains: chainsOf(all, kept, intervals),
    renamesWithoutEvent,
  };
}

export function keyOf(interval: SnapshotInterval): string {
  return `${interval.code}@${interval.validFrom}`;
}

/** The published name of a snapshot row: `COMUNE` for municipalities, the denomination otherwise. */
function nameOf(interval: SnapshotInterval): string {
  const row = interval.row;
  return 'officialName' in row ? row.officialName : row.name;
}

function cadastralOf(interval: SnapshotInterval): string | null {
  return 'cadastralCode' in interval.row ? interval.row.cadastralCode : null;
}

function cadastralPairs<L extends Level>(
  closed: readonly SnapshotInterval<L>[],
  opened: readonly SnapshotInterval<L>[],
): [SnapshotInterval<L>, SnapshotInterval<L>][] {
  const pairs: [SnapshotInterval<L>, SnapshotInterval<L>][] = [];
  for (const x of closed) {
    const cadastral = cadastralOf(x);
    if (cadastral === null) continue;
    const xs = closed.filter((i) => cadastralOf(i) === cadastral);
    const ys = opened.filter((i) => cadastralOf(i) === cadastral);
    if (xs.length === 1 && ys.length === 1 && ys[0] !== undefined) pairs.push([x, ys[0]]);
  }
  return pairs;
}

/** A conflict keeps none of its links. */
function dropConflicts(level: Level, links: readonly IntervalLink[], anomalies: AnomalyCollector): IntervalLink[] {
  const outgoing = groupBy(links, (l) => l.from);
  const incoming = groupBy(links, (l) => l.to);
  const conflicting = new Set<IntervalLink>();
  for (const [direction, groups] of [
    ['successors', outgoing],
    ['predecessors', incoming],
  ] as const) {
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      for (const link of group) conflicting.add(link);
      anomalies.add({
        level: 'blocking',
        code: TRANSITION_ANOMALIES.conflict,
        message: `${level} interval ${key} has ${group.length} ${direction}`,
        context: { level, interval: key, links: group },
      });
    }
  }
  return links.filter((l) => !conflicting.has(l));
}

function chainsOf<L extends Level>(
  all: readonly SnapshotInterval<L>[],
  links: readonly IntervalLink[],
  intervals: ReadonlyMap<string, SnapshotInterval<L>>,
): SnapshotInterval<L>[][] {
  const next = new Map(links.map((l) => [l.from, l.to]));
  const hasPrevious = new Set(links.map((l) => l.to));
  const chains: SnapshotInterval<L>[][] = [];
  for (const first of all) {
    if (hasPrevious.has(keyOf(first))) continue;
    const chain = [first];
    for (let key = next.get(keyOf(first)); key !== undefined; key = next.get(key)) {
      const interval = intervals.get(key);
      if (interval === undefined) break;
      chain.push(interval);
    }
    chains.push(chain);
  }
  return chains;
}

function addCode(map: Map<string, IstatEventCode[]>, key: string, code: IstatEventCode): void {
  const codes = map.get(key);
  if (codes === undefined) map.set(key, [code]);
  else if (!codes.includes(code)) codes.push(code);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [item]);
    else group.push(item);
  }
  return groups;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
