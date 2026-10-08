/**
 * Invariant I8 (§8.1): every UTS version has an `abbreviation` matching `^[A-Z]{2}$`. Checked after
 * the overrides (§6.10), which supply the values ISTAT does not publish in that form (Venezia
 * Giulia). A null abbreviation (left undetermined by the version builder, §6.9) is a violation too.
 *
 * One `blocking` anomaly per offending version.
 */
import { ABBREVIATION_PATTERN } from '../model/common.ts';
import type { Anomaly, Entity } from '../model/internal.ts';
import { violation } from './anomaly.ts';

export const I8_ANOMALY = 'invariant-i8';

export function checkI8(provinces: readonly Entity<'province'>[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const entity of provinces) {
    for (const version of entity.versions) {
      const { abbreviation } = version;
      if (abbreviation !== null && ABBREVIATION_PATTERN.test(abbreviation)) continue;
      anomalies.push(
        violation(
          'I8',
          abbreviation === null
            ? `province entity ${entity.id}, version from ${version.validFrom} (code ${version.istatCode}) has no abbreviation`
            : `province entity ${entity.id}, version from ${version.validFrom} (code ${version.istatCode}) has abbreviation ` +
                `${JSON.stringify(abbreviation)}, not two uppercase letters`,
          {
            entityId: entity.id,
            istatCode: version.istatCode,
            validFrom: version.validFrom,
            validTo: version.validTo,
            abbreviation,
          },
        ),
      );
    }
  }
  return anomalies;
}
