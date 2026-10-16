/**
 * Overrides apply to every day before the merge (D36), so they can remove version boundaries
 * (Littoria `LT` in 1934) but must never create one. An override whose days already hold its value
 * is obsolete: ISTAT fixed it.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, overlaps, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import type { Dated } from '../model/internal.ts';
import type { EntityId } from '../model/common.ts';
import type { Override } from './loader.ts';

const OVERRIDE_ANOMALIES = {
  obsolete: 'override-obsolete',
  createsBoundary: 'override-creates-boundary',
} as const;

export interface AppliedOverride {
  key: string;
  entityId: EntityId;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  field: Override['field'];
  before: string | null;
  after: string;
}

export class OverrideRun {
  readonly overrides: readonly Override[];
  readonly #applied: AppliedOverride[] = [];
  readonly #matched = new Set<string>();
  readonly #changed = new Set<string>();

  constructor(overrides: readonly Override[]) {
    this.overrides = overrides;
  }

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

function minEnd(a: IsoDate | null, b: IsoDate | null): IsoDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareDates(a, b) <= 0 ? a : b;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
