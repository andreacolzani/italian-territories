/**
 * Override applier (§6.10): applied by the version builder (Step 10) to the values of every day,
 * **before** contiguous pieces with equal fields are merged into versions.
 *
 * An override replaces its field on the days of its target period on which the UTS has its target
 * code. Since the merge comes afterwards, an override can remove version boundaries (a value it
 * makes equal to the neighbouring days merges with them, e.g. Littoria `LT` in 1934), but it must
 * never create one: a version boundary that exists only because of an override is `blocking`
 * (`override-creates-boundary`), checked by the builder against the versions it would build
 * without overrides.
 *
 * Obsolescence: an override that matches no day, or whose matched days all hold its value already
 * (ISTAT fixed it), is a `warning` (`override-obsolete`).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, overlaps, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import type { Dated } from '../model/internal.ts';
import type { EntityId } from '../model/common.ts';
import type { Override } from './loader.ts';

/** Stable anomaly codes of the override applier (§8.2). */
export const OVERRIDE_ANOMALIES = {
  /** The override matches nothing, or every day it targets already has its value. */
  obsolete: 'override-obsolete',
  /** A version boundary that exists only because of an override (overrides may only remove them). */
  createsBoundary: 'override-creates-boundary',
} as const;

/** The days on which an override replaced a value (contiguous days of one entity, one value before). */
export interface AppliedOverride {
  key: string;
  entityId: EntityId;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  field: Override['field'];
  before: string | null;
  after: string;
}

/** The overrides of one build, and what they did. */
export class OverrideRun {
  readonly overrides: readonly Override[];
  readonly #applied: AppliedOverride[] = [];
  readonly #matched = new Set<string>();
  readonly #changed = new Set<string>();

  constructor(overrides: readonly Override[]) {
    this.overrides = overrides;
  }

  /**
   * `range` (days of one UTS with code `istatCode`) cut at the bounds of the abbreviation overrides
   * of that code: each piece with the override that applies to it, or `null`.
   */
  abbreviationOverrides(istatCode: string, range: HalfOpenInterval): Dated<Override | null>[] {
    const targets = this.overrides
      .filter((o) => o.istatCode === istatCode && overlaps(o.target, range)) // `abbreviation`: the only field (§6.10)
      .sort((a, b) => compareDates(a.target.validFrom, b.target.validFrom));
    const pieces: Dated<Override | null>[] = [];
    let from = range.validFrom;
    for (const override of targets) {
      const start = maxDate(from, override.target.validFrom);
      const end = minEnd(range.validTo, override.target.validTo);
      if (compareDates(from, start) < 0) pieces.push({ validFrom: from, validTo: start, value: null });
      pieces.push({ validFrom: start, validTo: end, value: override });
      if (end === null) return pieces;
      from = end;
    }
    if (range.validTo === null || compareDates(from, range.validTo) < 0) {
      pieces.push({ validFrom: from, validTo: range.validTo, value: null });
    }
    return pieces;
  }

  /** Records that `override` set its value on `range` of `entityId`, where the source had `before`. */
  record(override: Override, entityId: EntityId, range: HalfOpenInterval, before: string | null): void {
    this.#matched.add(override.key);
    if (before !== override.value) this.#changed.add(override.key);
    const last = this.#applied.at(-1);
    if (
      last?.key === override.key &&
      last.entityId === entityId &&
      last.before === before &&
      last.validTo === range.validFrom
    ) {
      last.validTo = range.validTo;
      return;
    }
    this.#applied.push({
      key: override.key,
      entityId,
      validFrom: range.validFrom,
      validTo: range.validTo,
      field: override.field,
      before,
      after: override.value,
    });
  }

  /** Reports the obsolete overrides; the replaced values sorted by key, entity and date. */
  finish(anomalies: AnomalyCollector): AppliedOverride[] {
    for (const override of this.overrides) {
      if (!this.#matched.has(override.key)) anomalies.add(obsolete(override, 'no-match'));
      else if (!this.#changed.has(override.key)) anomalies.add(obsolete(override, 'already-applied'));
    }
    return [...this.#applied].sort(
      (a, b) =>
        compareCodeUnits(a.key, b.key) ||
        compareCodeUnits(a.entityId, b.entityId) ||
        compareDates(a.validFrom, b.validFrom),
    );
  }
}

/** One `blocking` anomaly for a version boundary that only an override creates. */
export function boundaryCreated(
  entityId: EntityId,
  istatCode: string,
  date: IsoDate,
  overrides: readonly Override[],
): Parameters<AnomalyCollector['add']>[0] {
  const keys = overrides
    .filter((o) => o.target.validFrom === date || o.target.validTo === date)
    .map((o) => o.key)
    .sort();
  return {
    level: 'blocking',
    code: OVERRIDE_ANOMALIES.createsBoundary,
    message: `province entity ${entityId} (code ${istatCode}): override ${keys.join(', ')} creates a version boundary on ${date}`,
    context: { entityId, istatCode, date, keys },
  };
}

function obsolete(override: Override, reason: 'no-match' | 'already-applied') {
  const why =
    reason === 'no-match'
      ? `no ${override.level} has code ${override.istatCode} in the target period`
      : `every targeted day already has ${override.field} ${JSON.stringify(override.value)}`;
  return {
    level: 'warning' as const,
    code: OVERRIDE_ANOMALIES.obsolete,
    message: `override ${override.key} is obsolete: ${why}`,
    context: {
      key: override.key,
      file: override.file,
      reason,
      level: override.level,
      field: override.field,
      istatCode: override.istatCode,
      target: override.target,
      value: override.value,
    },
  };
}

function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return compareDates(a, b) >= 0 ? a : b;
}

/** The earlier of two half-open ends (`null` = open). */
function minEnd(a: IsoDate | null, b: IsoDate | null): IsoDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareDates(a, b) <= 0 ? a : b;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
