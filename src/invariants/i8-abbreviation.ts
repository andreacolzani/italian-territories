/** After the overrides, which supply what ISTAT does not publish in that form (Venezia Giulia, §6.10). */
import { ABBREVIATION_PATTERN } from '../model/common.ts';
import type { Anomaly, Entity } from '../model/internal.ts';
import { violation } from './anomaly.ts';

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
