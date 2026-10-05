/**
 * Invariant I7 (§8.1, §3.5 items 9, 16 and 17, D29, D30): the first three digits of a municipality
 * `istat_code` equal the historical code (`COD_PROV_STORICO`, §5.5) of its UTS on the same dates;
 * before 1948 that is the UTS code. This is what verifies the `COD_PROV_STORICO ?? COD_UTS`
 * fallback of the snapshot projection.
 *
 * - Suffix < 800: the prefix must equal the historical code at any date: `blocking`.
 * - Suffix >= 800 (codes assigned retroactively to suppressed municipalities): the prefix must be
 *   the code of a UTS that existed at some time in the dataset, otherwise `blocking`; a prefix
 *   different from the historical code of the UTS of membership is `info`, one per version.
 *
 * Versions with an undetermined province (null `provinceId`) are skipped (I4 reports them), as are
 * the dates a UTS has no historical code for. {@link checkActive8xxCodes} is the D30 `warning`.
 */
import { cover } from '../build/timeline.ts';
import type { Anomaly, Entity } from '../model/internal.ts';
import { describeRange, range, violation } from './anomaly.ts';
import type { HistoricalCodes, InvariantEntities } from './world.ts';

/** Stable anomaly codes of I7 besides the invariant's own (§8.2). */
export const I7_ANOMALIES = {
  /** An 8xx code whose prefix is a UTS code of some time but not the UTS of membership (`info`). */
  prefixOfAnotherUts: 'municipality-8xx-prefix-of-another-uts',
  /** An active municipality whose current version has an 8xx code (`warning`, D30). */
  activeWith8xxCode: 'active-municipality-8xx-code',
} as const;

const CODE = /^(\d{3})(\d{3})$/;

/**
 * `extraUtsCodes` is for tests only: a test world covering a few dates does not contain the UTS
 * created later, which the whole dataset does. Production passes nothing, so the UTS codes "of some
 * time" are exclusively those of the checked world: the codes and historical codes of its UTS.
 */
export function checkI7(
  entities: InvariantEntities,
  historicalCodes: HistoricalCodes,
  extraUtsCodes: ReadonlySet<string> = new Set(),
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const utsCodes = new Set<string>(extraUtsCodes);
  for (const entity of entities.province) {
    for (const version of entity.versions) utsCodes.add(version.istatCode);
    for (const piece of historicalCodes.get(entity.id) ?? []) utsCodes.add(piece.value);
  }

  for (const entity of entities.municipality) {
    for (const version of entity.versions) {
      const match = CODE.exec(version.istatCode);
      const context = {
        level: 'municipality',
        entityId: entity.id,
        versionId: version.id,
        istatCode: version.istatCode,
        validFrom: version.validFrom,
        validTo: version.validTo,
        provinceId: version.provinceId,
      };
      if (match === null) {
        anomalies.push(
          violation(
            'I7',
            `municipality entity ${entity.id}, version ${version.id}: ${JSON.stringify(version.istatCode)} is not a 6-digit code`,
            context,
          ),
        );
        continue;
      }
      const prefix = match[1] ?? '';
      const high = Number(match[2]) >= 800;
      if (high && !utsCodes.has(prefix)) {
        anomalies.push(
          violation(
            'I7',
            `municipality entity ${entity.id}, version ${version.id}: code ${version.istatCode} has prefix ${prefix}, which was never the code of a UTS`,
            { ...context, prefix },
          ),
        );
        continue;
      }
      if (version.provinceId === null) continue;
      const different = cover<string | null>(range(version), [...(historicalCodes.get(version.provinceId) ?? [])], null)
        .filter((piece) => piece.value !== null && piece.value !== prefix)
        .map((piece) => ({ validFrom: piece.validFrom, validTo: piece.validTo, historicalCode: piece.value }));
      if (different.length === 0) continue;
      const where = different.map((d) => `${describeRange(d)} (${d.historicalCode})`).join(', ');
      if (high) {
        anomalies.push({
          level: 'info',
          code: I7_ANOMALIES.prefixOfAnotherUts,
          message: `municipality entity ${entity.id}, version ${version.id}: code ${version.istatCode} has the prefix ${prefix} of another UTS than its own over ${where}`,
          context: { ...context, prefix, different },
        });
      } else {
        anomalies.push(
          violation(
            'I7',
            `municipality entity ${entity.id}, version ${version.id}: code ${version.istatCode} has prefix ${prefix}, the historical code of its UTS ${version.provinceId} is different over ${where}`,
            { ...context, prefix, different },
          ),
        );
      }
    }
  }
  return anomalies;
}

/** D30: an active municipality whose current version has a code with suffix >= 800 (`warning`). */
export function checkActive8xxCodes(entities: InvariantEntities): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const entity of entities.municipality as readonly Entity<'municipality'>[]) {
    const current = entity.versions.at(-1);
    if (current?.validTo !== null) continue;
    const match = CODE.exec(current.istatCode);
    if (match === null || Number(match[2]) < 800) continue;
    anomalies.push({
      level: 'warning',
      code: I7_ANOMALIES.activeWith8xxCode,
      message: `active municipality ${entity.id} has the current code ${current.istatCode}, with suffix >= 800`,
      context: { level: 'municipality', entityId: entity.id, versionId: current.id, istatCode: current.istatCode },
    });
  }
  return anomalies;
}
