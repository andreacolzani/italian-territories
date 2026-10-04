/**
 * Piecewise-constant values over half-open intervals (§4.1), used to build versions (§6.9): which
 * entity a code identifies over time, which abbreviations the municipalities of a UTS report.
 */
import { compareDates, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import type { Level } from '../model/common.ts';
import type { Dated } from '../model/internal.ts';
import type { SnapshotInterval } from '../resolve/index.ts';

/** An entity of the identity stage (Step 9) with its registry id. */
export interface IdentifiedEntity<L extends Level = Level> {
  id: number;
  istatOriginId: number | null;
  /** Snapshot intervals of the entity, sorted, non-overlapping. */
  intervals: readonly SnapshotInterval<L>[];
}

/** Compares two interval ends; `null`, the open end, comes after every date. */
export function compareEnds(a: IsoDate | null, b: IsoDate | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return compareDates(a, b);
}

/**
 * The pieces of `dated` (sorted, non-overlapping) inside `range`, clipped to it, with `gap`
 * where none covers it: the result covers `range` exactly.
 */
export function cover<T>(range: HalfOpenInterval, dated: readonly Dated<T>[], gap: T): Dated<T>[] {
  const pieces: Dated<T>[] = [];
  let cursor: IsoDate | null = range.validFrom;
  for (const piece of dated) {
    if (cursor === null || compareEnds(range.validTo, piece.validFrom) <= 0) break;
    if (compareEnds(piece.validTo, cursor) <= 0) continue;
    if (compareDates(cursor, piece.validFrom) < 0) {
      pieces.push({ validFrom: cursor, validTo: piece.validFrom, value: gap });
      cursor = piece.validFrom;
    }
    const validTo = compareEnds(piece.validTo, range.validTo) < 0 ? piece.validTo : range.validTo;
    pieces.push({ validFrom: cursor, validTo, value: piece.value });
    cursor = validTo;
  }
  if (cursor !== null && compareEnds(cursor, range.validTo) < 0) {
    pieces.push({ validFrom: cursor, validTo: range.validTo, value: gap });
  }
  return pieces;
}

/** The value of `pieces` (covering the date) on `date`. */
export function valueAt<T>(pieces: readonly Dated<T>[], date: IsoDate): T {
  const piece = pieces.find((p) => compareDates(p.validFrom, date) <= 0 && compareEnds(date, p.validTo) < 0);
  if (piece === undefined) throw new Error(`no piece covers ${date}`);
  return piece.value;
}

/** The sub-ranges of `range` where every timeline (each covering `range`) is constant. */
export function splitRange(
  range: HalfOpenInterval,
  timelines: readonly (readonly Dated<unknown>[])[],
): HalfOpenInterval[] {
  const starts = new Set<IsoDate>([range.validFrom]);
  for (const timeline of timelines) for (const piece of timeline) starts.add(piece.validFrom);
  const sorted = [...starts].sort(compareDates);
  return sorted.map((validFrom, i) => ({ validFrom, validTo: sorted[i + 1] ?? range.validTo }));
}

/** Consecutive contiguous pieces with equal values (by `key`) merged into one. */
export function mergeDated<T>(pieces: readonly Dated<T>[], key: (value: T) => string): Dated<T>[] {
  const merged: Dated<T>[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last?.validTo === piece.validFrom && key(last.value) === key(piece.value)) {
      last.validTo = piece.validTo;
    } else {
      merged.push({ ...piece });
    }
  }
  return merged;
}

/** Which entity of one level each ISTAT code identifies over time. */
export class EntityTimeline {
  readonly level: Level;
  readonly #byCode: ReadonlyMap<string, readonly Dated<number>[]>;

  private constructor(level: Level, byCode: ReadonlyMap<string, readonly Dated<number>[]>) {
    this.level = level;
    this.#byCode = byCode;
  }

  static of<L extends Level>(level: L, entities: readonly IdentifiedEntity<L>[]): EntityTimeline {
    const byCode = new Map<string, Dated<number>[]>();
    for (const entity of entities) {
      for (const { code, validFrom, validTo } of entity.intervals) {
        const pieces = byCode.get(code) ?? [];
        pieces.push({ validFrom, validTo, value: entity.id });
        byCode.set(code, pieces);
      }
    }
    for (const pieces of byCode.values()) pieces.sort((a, b) => compareDates(a.validFrom, b.validFrom));
    return new EntityTimeline(level, byCode);
  }

  /** The entity of `code` over `range`, `null` where the code identifies none. */
  over(code: string, range: HalfOpenInterval): Dated<number | null>[] {
    return cover<number | null>(range, this.#byCode.get(code) ?? [], null);
  }
}

/**
 * The distinct non-null abbreviations (`SIGLA_UTS`) that the municipalities of each UTS code
 * report over time, sorted; times without any are left out. Built with a sweep over the
 * municipality intervals, so each UTS costs `O(n log n)` in its municipality intervals.
 */
export function municipalityAbbreviations(
  municipalities: Iterable<SnapshotInterval<'municipality'>>,
): Map<string, Dated<string[]>[]> {
  const changes = new Map<string, Map<IsoDate, { value: string; delta: 1 | -1 }[]>>();
  const add = (utsCode: string, date: IsoDate, value: string, delta: 1 | -1): void => {
    const byDate = changes.get(utsCode) ?? new Map<IsoDate, { value: string; delta: 1 | -1 }[]>();
    const list = byDate.get(date) ?? [];
    list.push({ value, delta });
    byDate.set(date, list);
    changes.set(utsCode, byDate);
  };
  for (const { row, validFrom, validTo } of municipalities) {
    const value = row.utsAbbreviation;
    if (value === null) continue;
    add(row.utsCode, validFrom, value, 1);
    if (validTo !== null) add(row.utsCode, validTo, value, -1);
  }
  const result = new Map<string, Dated<string[]>[]>();
  for (const [utsCode, byDate] of changes) {
    const counts = new Map<string, number>();
    const pieces: Dated<string[]>[] = [];
    let open: Dated<string[]> | null = null;
    for (const date of [...byDate.keys()].sort(compareDates)) {
      for (const { value, delta } of byDate.get(date) ?? []) counts.set(value, (counts.get(value) ?? 0) + delta);
      if (open !== null) open.validTo = date;
      const values = [...counts]
        .filter(([, n]) => n > 0)
        .map(([v]) => v)
        .sort();
      open = values.length > 0 ? { validFrom: date, validTo: null, value: values } : null;
      if (open !== null) pieces.push(open);
    }
    result.set(
      utsCode,
      mergeDated(pieces, (v) => v.join('\u0000')),
    );
  }
  return result;
}
