/**
 * Override applier (§6.10): applied after building versions and variations, before derived fields
 * and invariants.
 *
 * An override targets the versions of a level whose ISTAT code is its `istatCode` and which lie
 * **entirely** inside its target period; it replaces their field with its value. Versions are never
 * split, so an override creates no version boundary and no variation, and the version ids already
 * assigned stay valid. A version with that code that overlaps the target period only in part is a
 * `blocking` anomaly (`override-partial-overlap`) and keeps its value.
 *
 * Obsolescence: an override that matches no version, or whose fully covered versions all hold its
 * value already (ISTAT fixed it) without partial overlaps, is a `warning` (`override-obsolete`).
 *
 * The result is not re-collapsed: if an override made two contiguous versions equal, I3 reports it.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { covers, overlaps, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import type { Override } from './loader.ts';

/** Stable anomaly codes of the override applier (§8.2). */
export const OVERRIDE_ANOMALIES = {
  /** The override matches nothing, or every version it targets already has its value. */
  obsolete: 'override-obsolete',
  /** A version with the target code overlaps the target period without lying inside it. */
  partialOverlap: 'override-partial-overlap',
} as const;

/** The fields of a UTS version an override may read and replace. */
export type OverridableProvinceVersion = HalfOpenInterval & { istatCode: string; abbreviation: string | null };

export interface AppliedOverride {
  key: string;
  entityId: number;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  field: Override['field'];
  before: string | null;
  after: string;
}

/**
 * The UTS entities with the overrides applied (unchanged entities are returned as they are), and
 * the list of replaced values sorted by key, entity and date.
 */
export function applyOverrides<E extends { id: number; versions: readonly OverridableProvinceVersion[] }>(options: {
  overrides: readonly Override[];
  provinces: readonly E[];
  anomalies: AnomalyCollector;
}): { provinces: E[]; applied: AppliedOverride[] } {
  const { overrides, anomalies } = options;
  const replacements = new Map<E, Map<number, string>>();
  const applied: AppliedOverride[] = [];

  for (const override of overrides) {
    let matched = 0;
    let partial = 0;
    let pending = 0;
    for (const entity of options.provinces) {
      entity.versions.forEach((version, index) => {
        if (version.istatCode !== override.istatCode || !overlaps(version, override.target)) return;
        matched += 1;
        if (!covers(override.target, version)) {
          partial += 1;
          anomalies.add(partialOverlap(override, entity.id, version));
          return;
        }
        if (version.abbreviation === override.value) return;
        pending += 1;
        const byIndex = replacements.get(entity) ?? new Map<number, string>();
        byIndex.set(index, override.value);
        replacements.set(entity, byIndex);
        applied.push({
          key: override.key,
          entityId: entity.id,
          validFrom: version.validFrom,
          validTo: version.validTo,
          field: override.field,
          before: version.abbreviation,
          after: override.value,
        });
      });
    }
    if (matched === 0) anomalies.add(obsolete(override, 'no-match'));
    else if (pending === 0 && partial === 0) anomalies.add(obsolete(override, 'already-applied'));
  }

  const provinces = options.provinces.map((entity) => {
    const byIndex = replacements.get(entity);
    if (byIndex === undefined) return entity;
    const versions = entity.versions.map((version, index) => {
      const value = byIndex.get(index);
      return value === undefined ? version : { ...version, abbreviation: value };
    });
    return { ...entity, versions };
  });
  applied.sort(
    (a, b) => compareCodeUnits(a.key, b.key) || a.entityId - b.entityId || compareCodeUnits(a.validFrom, b.validFrom),
  );
  return { provinces, applied };
}

function partialOverlap(override: Override, entityId: number, version: OverridableProvinceVersion) {
  return {
    level: 'blocking' as const,
    code: OVERRIDE_ANOMALIES.partialOverlap,
    message:
      `override ${override.key}: ${override.level} entity ${entityId}, version from ${version.validFrom} ` +
      `(code ${version.istatCode}) is only partly inside the target period, ${override.field} not replaced`,
    context: {
      key: override.key,
      file: override.file,
      level: override.level,
      field: override.field,
      entityId,
      istatCode: version.istatCode,
      validFrom: version.validFrom,
      validTo: version.validTo,
      target: override.target,
    },
  };
}

function obsolete(override: Override, reason: 'no-match' | 'already-applied') {
  const why =
    reason === 'no-match'
      ? `no ${override.level} version has code ${override.istatCode} in the target period`
      : `every targeted version already has ${override.field} ${JSON.stringify(override.value)}`;
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

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
