/** §8.1, in the half-open convention: the zero-length case `validFrom == validTo` is I10's. */
import { compareDates, overlaps } from '../dates/index.ts';
import { LEVELS, type Level } from '../model/common.ts';
import type { Anomaly, Entity } from '../model/internal.ts';
import { violation } from './anomaly.ts';
import { publishedFields } from './fields.ts';
import type { Existence, InvariantEntities } from './world.ts';

function* eachLevel(entities: InvariantEntities): Generator<[Level, readonly Entity[]]> {
  for (const level of LEVELS) yield [level, entities[level]];
}

export function checkI1(entities: InvariantEntities): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const [level, list] of eachLevel(entities)) {
    for (const entity of list) {
      const { versions } = entity;
      if (versions.length === 0) {
        anomalies.push(violation('I1', `${level} entity ${entity.id} has no versions`, { level, entityId: entity.id }));
      }
      versions.forEach((version, i) => {
        const context = { level, entityId: entity.id, versionFrom: version.validFrom };
        if (version.validTo !== null && compareDates(version.validTo, version.validFrom) < 0) {
          anomalies.push(
            violation(
              'I1',
              `${level} entity ${entity.id}, version from ${version.validFrom}: validTo ${version.validTo} precedes validFrom ${version.validFrom}`,
              { ...context, validFrom: version.validFrom, validTo: version.validTo },
            ),
          );
        }
        const previous = versions[i - 1];
        if (previous === undefined) return;
        const pair = {
          ...context,
          previousVersionFrom: previous.validFrom,
          previous: { validFrom: previous.validFrom, validTo: previous.validTo },
          validFrom: version.validFrom,
          validTo: version.validTo,
        };
        if (compareDates(previous.validFrom, version.validFrom) >= 0) {
          anomalies.push(
            violation(
              'I1',
              `${level} entity ${entity.id}: version from ${version.validFrom} (from ${version.validFrom}) does not follow version from ${previous.validFrom} (from ${previous.validFrom})`,
              { ...pair, problem: 'unsorted' },
            ),
          );
        } else if (previous.validTo === null || compareDates(previous.validTo, version.validFrom) > 0) {
          anomalies.push(
            violation(
              'I1',
              `${level} entity ${entity.id}: version from ${previous.validFrom} (until ${previous.validTo ?? 'open'}) overlaps version from ${version.validFrom} (from ${version.validFrom})`,
              { ...pair, problem: 'overlap' },
            ),
          );
        }
      });
    }
  }
  return anomalies;
}

export function checkI2(entities: InvariantEntities, existence: Existence): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const [level, list] of eachLevel(entities)) {
    for (const entity of list) {
      entity.versions.forEach((version, i) => {
        const previous = entity.versions[i - 1];
        // Unsorted or overlapping neighbours are I1's.
        if (previous?.validTo == null || compareDates(previous.validTo, version.validFrom) >= 0) return;
        const gap = { validFrom: previous.validTo, validTo: version.validFrom };
        const known = existence[level].get(entity.id);
        const inside = known?.filter((interval) => overlaps(interval, gap)) ?? [];
        if (known !== undefined && inside.length === 0) return;
        anomalies.push(
          violation(
            'I2',
            known === undefined
              ? `${level} entity ${entity.id}: gap [${gap.validFrom}, ${gap.validTo}) between versions from ${previous.validFrom} and ${version.validFrom} cannot be checked, the entity has no snapshot intervals`
              : `${level} entity ${entity.id}: gap [${gap.validFrom}, ${gap.validTo}) between versions from ${previous.validFrom} and ${version.validFrom} while the entity exists in the snapshots`,
            {
              level,
              entityId: entity.id,
              previousVersionFrom: previous.validFrom,
              versionFrom: version.validFrom,
              gap,
              existsDuringGap: inside.map((i) => ({ validFrom: i.validFrom, validTo: i.validTo })),
            },
          ),
        );
      });
    }
  }
  return anomalies;
}

export function checkI3(entities: InvariantEntities): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const [level, list] of eachLevel(entities)) {
    for (const entity of list) {
      entity.versions.forEach((version, i) => {
        const previous = entity.versions[i - 1];
        if (previous?.validTo !== version.validFrom) return;
        if (JSON.stringify(publishedFields(level, previous)) !== JSON.stringify(publishedFields(level, version)))
          return;
        anomalies.push(
          violation(
            'I3',
            `${level} entity ${entity.id}: contiguous versions from ${previous.validFrom} and ${version.validFrom} (boundary ${version.validFrom}) have the same published fields`,
            {
              level,
              entityId: entity.id,
              previousVersionFrom: previous.validFrom,
              versionFrom: version.validFrom,
              date: version.validFrom,
            },
          ),
        );
      });
    }
  }
  return anomalies;
}
