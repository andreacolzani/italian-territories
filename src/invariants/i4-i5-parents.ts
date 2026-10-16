/** §8.1. I5 skips null parents and the parts a province does not cover: they are I4's. */
import { compareEnds, cover } from '../build/timeline.ts';
import { compareDates, type HalfOpenInterval } from '../dates/index.ts';
import type { EntityId } from '../model/common.ts';
import type { Anomaly, Entity } from '../model/internal.ts';
import { describeRange, intersection, range, violation } from './anomaly.ts';
import type { InvariantEntities } from './world.ts';

type Referencing = HalfOpenInterval;

function uncovered(interval: HalfOpenInterval, parent: Entity | undefined): HalfOpenInterval[] {
  if (parent === undefined) return [range(interval)];
  const versions = [...parent.versions].sort((a, b) => compareDates(a.validFrom, b.validFrom));
  return cover<boolean>(
    interval,
    versions.map((v) => ({ validFrom: v.validFrom, validTo: v.validTo, value: true })),
    false,
  )
    .filter((piece) => !piece.value)
    .map(range);
}

export function checkI4(entities: InvariantEntities): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const regions = new Map<EntityId, Entity>(entities.region.map((e) => [e.id, e]));
  const provinces = new Map<EntityId, Entity>(entities.province.map((e) => [e.id, e]));
  const check = (
    level: 'province' | 'municipality',
    entity: Entity,
    version: Referencing,
    field: 'regionId' | 'provinceId',
    target: EntityId | null,
  ): void => {
    const parentLevel = field === 'regionId' ? 'region' : 'province';
    const context = { level, entityId: entity.id, versionFrom: version.validFrom, field, parentLevel };
    if (target === null) {
      anomalies.push(
        violation('I4', `${level} entity ${entity.id}, version from ${version.validFrom}: ${field} is undetermined`, {
          ...context,
          target,
        }),
      );
      return;
    }
    const parent = (field === 'regionId' ? regions : provinces).get(target);
    const missing = uncovered(version, parent);
    if (missing.length === 0) return;
    anomalies.push(
      violation(
        'I4',
        parent === undefined
          ? `${level} entity ${entity.id}, version from ${version.validFrom}: ${field} ${target} references no ${parentLevel} entity`
          : `${level} entity ${entity.id}, version from ${version.validFrom}: ${parentLevel} entity ${target} has no version over ${missing.map(describeRange).join(', ')}`,
        { ...context, target, validFrom: version.validFrom, validTo: version.validTo, uncovered: missing },
      ),
    );
  };

  for (const entity of entities.province) {
    for (const version of entity.versions) check('province', entity, version, 'regionId', version.regionId);
  }
  for (const entity of entities.municipality) {
    for (const version of entity.versions) {
      check('municipality', entity, version, 'provinceId', version.provinceId);
      check('municipality', entity, version, 'regionId', version.regionId);
    }
  }
  return anomalies;
}

export function checkI5(entities: InvariantEntities): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const provinces = new Map(entities.province.map((e) => [e.id, e]));
  for (const entity of entities.municipality) {
    for (const version of entity.versions) {
      const { provinceId, regionId } = version;
      if (provinceId === null || regionId === null) continue;
      const province = provinces.get(provinceId);
      if (province === undefined) continue;
      const conflicts = province.versions
        .filter((p) => p.regionId !== null && p.regionId !== regionId)
        .flatMap((p) => {
          const common = intersection(version, p);
          return common === null ? [] : [{ ...common, provinceVersionFrom: p.validFrom, provinceRegionId: p.regionId }];
        })
        .sort((a, b) => compareDates(a.validFrom, b.validFrom) || compareEnds(a.validTo, b.validTo));
      if (conflicts.length === 0) continue;
      anomalies.push(
        violation(
          'I5',
          `municipality entity ${entity.id}, version from ${version.validFrom}: regionId ${regionId} differs from the region of its province ${provinceId} over ${conflicts.map(describeRange).join(', ')}`,
          {
            level: 'municipality',
            entityId: entity.id,
            versionFrom: version.validFrom,
            provinceId,
            regionId,
            conflicts,
          },
        ),
      );
    }
  }
  return anomalies;
}
