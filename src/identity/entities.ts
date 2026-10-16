/**
 * §5.2: ISTAT ids win over the public path, so a chain is cut where its root changes and chains with
 * one root are joined. A suppression followed by an establishment is a documented reconstitution
 * (Sassofeltrio `ES` 1929, `CS` 1947), not a disagreement. Without a root, regions and UTS always
 * block (their identity needs internal data, §3.1); a municipality blocks only with incomplete
 * internal data and an establishment after the first calendar date (a possible reconstitution).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, type IsoDate } from '../dates/index.ts';
import type { Level } from '../model/common.ts';
import {
  internalAliases,
  ResolutionError,
  type CodeAlias,
  type CodeResolver,
  type InternalAliasEvent,
  type SnapshotInterval,
} from '../resolve/index.ts';
import type { IdentityGraph } from './identity-graph.ts';
import { keyOf, subjectSide, type TransitionResult } from './transitions.ts';

/**
 * `unavailable`: a request of the level failed for unavailability (offline `NotInStoreError`
 * included), exit 3; `absent`: the data is not there, exit 1.
 */
export type InternalDataCause = 'unavailable' | 'absent';

export type IdentityEvent = InternalAliasEvent;

export interface InternalIdentity {
  complete: boolean;
  components: readonly { root: number; ids: readonly number[]; events: readonly IdentityEvent[] }[];
  aliases: readonly CodeAlias[];
}

/** Municipality aliases come from pfun 105, not from internal events. */
export function internalIdentity<E>(
  graph: IdentityGraph<E>,
  complete: boolean,
  view: (event: E) => IdentityEvent,
  source: string,
): InternalIdentity {
  return {
    complete,
    components: graph.components.map((c) => ({ root: c.root, ids: c.ids, events: c.events.map(view) })),
    aliases: graph.level === 'municipality' ? [] : internalAliases(graph, view, source),
  };
}

export interface ResolvedEntity<L extends Level = Level> {
  level: L;
  /** Natural key (§5.3): `istat:<root>`, or `fallbackKey` when there is no root. */
  key: string;
  /** `nk:<level>:<first istat_code>:<first valid_from>`, used to re-key an entity that gains a root. */
  fallbackKey: string;
  /** Registry assignment order (§5.3). */
  firstValidFrom: IsoDate;
  firstCode: string;
  istatOriginId: number | null;
  /** Empty without a root. */
  members: number[];
  intervals: SnapshotInterval<L>[];
}

export interface ResolveEntitiesOptions<L extends Level> {
  transitions: TransitionResult<L>;
  resolver: CodeResolver;
  /** `null` when the level was not crawled or its list could not be obtained. */
  internal: InternalIdentity | null;
  internalCause?: InternalDataCause;
  anomalies: AnomalyCollector;
}

export const ENTITY_ANOMALIES = {
  mismatch: 'identity-public-internal-mismatch',
  splitUndetermined: 'identity-split-undetermined',
  originConflict: 'identity-origin-conflict',
  overlap: 'identity-overlap',
  originMissing: 'identity-origin-missing',
  internalDataRequired: 'internal-data-required',
} as const;

export function resolveEntities<L extends Level>(options: ResolveEntitiesOptions<L>): ResolvedEntity<L>[] {
  const { transitions, internal, anomalies } = options;
  const { level } = transitions;
  const firstDate = [...transitions.intervals.values()].reduce<IsoDate | undefined>(
    (min, i) => (min === undefined || compareDates(i.validFrom, min) < 0 ? i.validFrom : min),
    undefined,
  );

  const roots = new Map<string, Set<number>>();
  const members = new Map<number, readonly number[]>();
  for (const component of internal?.components ?? []) {
    members.set(component.root, component.ids);
    for (const e of component.events) {
      const key = resolveKey(options.resolver, level, e);
      if (key === null) continue;
      const set = roots.get(key) ?? new Set<number>();
      set.add(component.root);
      roots.set(key, set);
    }
  }
  const rootOf = (interval: SnapshotInterval<L>): number | null => {
    const set = roots.get(keyOf(interval));
    if (set === undefined) return null;
    if (set.size === 1) return [...set][0] ?? null;
    return null;
  };
  for (const [key, set] of roots) {
    if (set.size < 2) continue;
    anomalies.add({
      level: 'blocking',
      code: ENTITY_ANOMALIES.originConflict,
      message: `${level} interval ${key}: events of the ISTAT entities ${[...set].sort(byNumber).join(', ')}`,
      context: { level, interval: key, roots: [...set].sort(byNumber) },
    });
  }

  const pieces = transitions.chains.flatMap((chain) => splitChain(level, chain, rootOf, anomalies));
  const byRoot = new Map<number, Piece<L>[]>();
  const rootless: Piece<L>[] = [];
  for (const piece of pieces) {
    if (piece.root === null) rootless.push(piece);
    else byRoot.set(piece.root, [...(byRoot.get(piece.root) ?? []), piece]);
  }

  const entities: ResolvedEntity<L>[] = [];
  for (const [root, group] of byRoot) {
    group.sort((a, b) => compareIntervals(first(a), first(b)));
    group.forEach((piece, i) => {
      const previous = group[i - 1];
      if (previous !== undefined) checkJoin(level, root, previous, piece, transitions, anomalies);
    });
    const intervals = group.flatMap((p) => p.intervals).sort(compareIntervals);
    entities.push({
      level,
      key: `istat:${root}`,
      fallbackKey: fallbackKey(level, intervals),
      ...firstFields(intervals),
      istatOriginId: root,
      members: [...(members.get(root) ?? [root])].sort(byNumber),
      intervals,
    });
  }
  for (const piece of rootless) {
    const key = fallbackKey(level, piece.intervals);
    entities.push({
      level,
      key,
      fallbackKey: key,
      ...firstFields(piece.intervals),
      istatOriginId: null,
      members: [],
      intervals: piece.intervals,
    });
    reportRootless(level, piece, internal, options.internalCause ?? 'absent', firstDate, transitions, anomalies);
  }
  return entities.sort((a, b) => compareIntervals(firstOf(a), firstOf(b)) || compareStrings(a.key, b.key));
}

interface Piece<L extends Level> {
  root: number | null;
  intervals: SnapshotInterval<L>[];
}

function splitChain<L extends Level>(
  level: Level,
  chain: readonly SnapshotInterval<L>[],
  rootOf: (interval: SnapshotInterval<L>) => number | null,
  anomalies: AnomalyCollector,
): Piece<L>[] {
  const pieces: Piece<L>[] = [];
  let current: Piece<L> = { root: null, intervals: [] };
  let pending: SnapshotInterval<L>[] = [];
  for (const interval of chain) {
    const root = rootOf(interval);
    if (root === null) {
      pending.push(interval);
      continue;
    }
    if (current.root === null || current.root === root) {
      current.root = root;
      current.intervals.push(...pending, interval);
    } else {
      const last = current.intervals[current.intervals.length - 1];
      const firstPending = pending[0];
      if (firstPending === undefined) {
        anomalies.add({
          level: 'warning',
          code: ENTITY_ANOMALIES.mismatch,
          message: `${level} ${interval.code} on ${interval.validFrom}: continuous in the snapshots, but ISTAT entity ${current.root} ends and ${root} begins`,
          context: {
            level,
            date: interval.validFrom,
            from: last === undefined ? null : keyOf(last),
            to: keyOf(interval),
            roots: [current.root, root],
          },
        });
      } else {
        anomalies.add({
          level: 'blocking',
          code: ENTITY_ANOMALIES.splitUndetermined,
          message: `${level} ${interval.code}: ISTAT entity ${current.root} becomes ${root} somewhere in ${pending.map(keyOf).join(', ')}`,
          context: { level, roots: [current.root, root], undetermined: pending.map(keyOf), to: keyOf(interval) },
        });
        current.intervals.push(...pending);
      }
      pieces.push(current);
      current = { root, intervals: [interval] };
    }
    pending = [];
  }
  current.intervals.push(...pending);
  pieces.push(current);
  return pieces;
}

function checkJoin<L extends Level>(
  level: Level,
  root: number,
  earlier: Piece<L>,
  later: Piece<L>,
  transitions: TransitionResult<L>,
  anomalies: AnomalyCollector,
): void {
  const end = earlier.intervals[earlier.intervals.length - 1];
  const start = first(later);
  if (end === undefined) return;
  const context = { level, root, earlier: keyOf(end), later: keyOf(start) };
  if (end.validTo === null || compareDates(end.validTo, start.validFrom) > 0) {
    anomalies.add({
      level: 'blocking',
      code: ENTITY_ANOMALIES.overlap,
      message: `${level} ISTAT entity ${root}: ${keyOf(end)} overlaps ${keyOf(start)}`,
      context,
    });
    return;
  }
  if (transitions.ends.has(keyOf(end)) && transitions.starts.has(keyOf(start))) return;
  anomalies.add({
    level: 'warning',
    code: ENTITY_ANOMALIES.mismatch,
    message: `${level} ISTAT entity ${root}: ${keyOf(end)} and ${keyOf(start)} are separate in the snapshots without a suppression and a reconstitution`,
    context,
  });
}

function reportRootless<L extends Level>(
  level: Level,
  piece: Piece<L>,
  internal: InternalIdentity | null,
  cause: InternalDataCause,
  firstDate: IsoDate | undefined,
  transitions: TransitionResult<L>,
  anomalies: AnomalyCollector,
): void {
  const start = first(piece);
  const context = { level, intervals: piece.intervals.map(keyOf), row: start.row };
  const complete = internal?.complete === true;
  const establishment = start.validFrom !== firstDate && transitions.starts.has(keyOf(start));
  if (complete) {
    anomalies.add({
      level: level === 'municipality' ? 'warning' : 'blocking',
      code: ENTITY_ANOMALIES.originMissing,
      message: `${level} ${start.code} from ${start.validFrom}: no internal event identifies it`,
      context,
    });
  } else if (level !== 'municipality' || establishment) {
    anomalies.add({
      level: 'blocking',
      code: ENTITY_ANOMALIES.internalDataRequired,
      message: `${level} ${start.code} from ${start.validFrom}: its identity needs internal data that could not be obtained`,
      context: { ...context, cause },
    });
  }
}

function resolveKey(resolver: CodeResolver, level: Level, e: IdentityEvent): string | null {
  try {
    return resolver.resolve({ level, code: e.code, date: e.date, side: subjectSide(e.event) }).intervalKey;
  } catch (error) {
    // Events reaching no interval (e.g. the code of a same-day state) identify nothing.
    if (error instanceof ResolutionError) return null;
    throw error;
  }
}

function fallbackKey(level: Level, intervals: readonly SnapshotInterval[]): string {
  const start = intervals[0];
  if (start === undefined) throw new Error('an entity has at least one interval');
  return `nk:${level}:${start.code}:${start.validFrom}`;
}

function firstFields(intervals: readonly SnapshotInterval[]): { firstValidFrom: IsoDate; firstCode: string } {
  const start = intervals[0];
  if (start === undefined) throw new Error('an entity has at least one interval');
  return { firstValidFrom: start.validFrom, firstCode: start.code };
}

function first<L extends Level>(piece: Piece<L>): SnapshotInterval<L> {
  const interval = piece.intervals[0];
  if (interval === undefined) throw new Error('a chain piece has at least one interval');
  return interval;
}

function firstOf<L extends Level>(entity: ResolvedEntity<L>): SnapshotInterval<L> {
  return first({ root: entity.istatOriginId, intervals: entity.intervals });
}

function compareIntervals(a: SnapshotInterval, b: SnapshotInterval): number {
  return compareDates(a.validFrom, b.validFrom) || compareStrings(a.code, b.code);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byNumber(a: number, b: number): number {
  return a - b;
}
