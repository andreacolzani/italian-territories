/**
 * §8.1, §3.5 items 9, 16 and 17. This is what verifies the `COD_PROV_STORICO ?? COD_UTS` fallback of
 * the snapshot projection. Suffixes >= 800 were assigned retroactively to suppressed municipalities,
 * so their prefix need only be a UTS code of some time. A null province is I4's.
 */
import { cover } from '../build/timeline.ts';
import type { Anomaly, Entity } from '../model/internal.ts';
import { describeRange, range, violation } from './anomaly.ts';
import type { HistoricalCodes, InvariantEntities } from './world.ts';

const I7_ANOMALIES = {
  prefixOfAnotherUts: 'municipality-8xx-prefix-of-another-uts',
  activeWith8xxCode: 'active-municipality-8xx-code',
} as const;

const CODE = /^(\d{3})(\d{3})$/;

/** `extraUtsCodes` is test-only: a partial world lacks the UTS created later. */
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
        versionFrom: version.validFrom,
        istatCode: version.istatCode,
        validFrom: version.validFrom,
        validTo: version.validTo,
        provinceId: version.provinceId,
      };
      if (match === null) {
        anomalies.push(
          violation(
            'I7',
            `municipality entity ${entity.id}, version from ${version.validFrom}: ${JSON.stringify(version.istatCode)} is not a 6-digit code`,
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
            `municipality entity ${entity.id}, version from ${version.validFrom}: code ${version.istatCode} has prefix ${prefix}, which was never the code of a UTS`,
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
          message: `municipality entity ${entity.id}, version from ${version.validFrom}: code ${version.istatCode} has the prefix ${prefix} of another UTS than its own over ${where}`,
          context: { ...context, prefix, different },
        });
      } else {
        anomalies.push(
          violation(
            'I7',
            `municipality entity ${entity.id}, version from ${version.validFrom}: code ${version.istatCode} has prefix ${prefix}, the historical code of its UTS ${version.provinceId} is different over ${where}`,
            { ...context, prefix, different },
          ),
        );
      }
    }
  }
  return anomalies;
}

/** D30. */
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
      context: {
        level: 'municipality',
        entityId: entity.id,
        versionFrom: current.validFrom,
        istatCode: current.istatCode,
      },
    });
  }
  return anomalies;
}
