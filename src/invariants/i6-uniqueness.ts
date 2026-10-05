/**
 * Invariant I6 (§8.1): per-date uniqueness within a level of the `istat_code`, of the non-null
 * `cadastral_code` among municipalities and of the `abbreviation` among UTS. One anomaly per pair of
 * versions of two different entities that share a value over a common period; the versions of one
 * entity are I1's. A null abbreviation is I8's.
 */
import { compareDates } from '../dates/index.ts';
import { LEVELS, type Level } from '../model/common.ts';
import type { Anomaly, Entity } from '../model/internal.ts';
import { describeRange, intersection, range, violation } from './anomaly.ts';
import type { InvariantEntities } from './world.ts';

interface Holder {
  entityId: number;
  versionId: number;
  validFrom: string;
  validTo: string | null;
}

export function checkI6(entities: InvariantEntities): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const check = (level: Level, field: string, values: Map<string, Holder[]>): void => {
    for (const [value, holders] of [...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (holders.length < 2) continue;
      holders.sort((a, b) => compareDates(a.validFrom, b.validFrom) || a.entityId - b.entityId);
      holders.forEach((a, i) => {
        for (const b of holders.slice(i + 1)) {
          if (a.entityId === b.entityId) continue;
          const common = intersection(range(a), range(b));
          if (common === null) continue;
          anomalies.push(
            violation(
              'I6',
              `${level} ${field} ${JSON.stringify(value)} is held by entities ${a.entityId} (version ${a.versionId}) and ${b.entityId} (version ${b.versionId}) over ${describeRange(common)}`,
              { level, field, value, overlap: common, first: a, second: b },
            ),
          );
        }
      });
    }
  };

  for (const level of LEVELS) {
    const codes = new Map<string, Holder[]>();
    const cadastral = new Map<string, Holder[]>();
    const abbreviations = new Map<string, Holder[]>();
    for (const entity of entities[level] as readonly Entity[]) {
      for (const version of entity.versions) {
        const holder: Holder = {
          entityId: entity.id,
          versionId: version.id,
          validFrom: version.validFrom,
          validTo: version.validTo,
        };
        add(codes, version.istatCode, holder);
        if ('cadastralCode' in version && version.cadastralCode !== null) add(cadastral, version.cadastralCode, holder);
        if ('abbreviation' in version && version.abbreviation !== null)
          add(abbreviations, version.abbreviation, holder);
      }
    }
    check(level, 'istat_code', codes);
    check(level, 'cadastral_code', cadastral);
    check(level, 'abbreviation', abbreviations);
  }
  return anomalies;
}

function add(map: Map<string, Holder[]>, key: string, holder: Holder): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [holder]);
  else list.push(holder);
}
