/**
 * Worlds for version tests: identity resolution of each level, registry ids for the
 * entities, then the version builder, from the regions down to the municipalities.
 */
import { AnomalyCollector } from '../../src/anomalies.ts';
import {
  buildMunicipalityVersions,
  buildProvinceVersions,
  buildRegionVersions,
  EntityTimeline,
  type IdentifiedEntity,
} from '../../src/build/index.ts';
import type { HalfOpenInterval, IsoDate } from '../../src/dates/index.ts';
import {
  Registry,
  resolveLevelIdentity,
  type InternalIdentity,
  type LevelEventLists,
  type LevelIdentity,
} from '../../src/identity/index.ts';
import type { EntityId, Level } from '../../src/model/common.ts';
import type { EntityByLevel } from '../../src/model/internal.ts';
import { OverrideRun, type AppliedOverride, type Override } from '../../src/overrides/index.ts';
import { IntervalIndex } from '../../src/resolve/index.ts';
import { withTempDir } from './http.ts';

export interface LevelWorld<L extends Level> {
  index: IntervalIndex<L>;
  internal?: InternalIdentity | null;
  eventLists?: LevelEventLists<L>;
}

export interface VersionWorld {
  region: LevelWorld<'region'>;
  province: LevelWorld<'province'>;
  /** Without municipalities, pre-1948 UTS abbreviations cannot be derived. */
  municipality?: LevelWorld<'municipality'>;
  /** Overrides applied by the UTS version builder (§6.10). */
  overrides?: readonly Override[];
}

export interface BuiltWorld {
  region: EntityByLevel['region'][];
  province: EntityByLevel['province'][];
  municipality: EntityByLevel['municipality'][];
  identity: { [L in Level]?: LevelIdentity<L> };
  /** Snapshot intervals of each entity id, per level. */
  intervals: Record<Level, Map<EntityId, readonly HalfOpenInterval[]>>;
  /** The entities of identity resolution with their registry ids, per level. */
  identified: { [L in Level]: IdentifiedEntity<L>[] };
  /** The registry of the build (in memory: its directory is removed). */
  registry: Registry;
  /** Anomalies of identity resolution. */
  identityAnomalies: AnomalyCollector;
  /** Anomalies of the version builder only (overrides included). */
  anomalies: AnomalyCollector;
  /** The values the overrides replaced. */
  appliedOverrides: AppliedOverride[];
}

export async function buildWorld(world: VersionWorld): Promise<BuiltWorld> {
  return withTempDir(async (dir) => {
    const registry = await Registry.load(dir);
    const identityAnomalies = new AnomalyCollector();
    const anomalies = new AnomalyCollector();
    const identify = <L extends Level>(level: L, levelWorld: LevelWorld<L>) => {
      const identity = resolveLevelIdentity({
        level,
        index: levelWorld.index,
        internal: levelWorld.internal ?? null,
        eventLists: levelWorld.eventLists ?? {},
        anomalies: identityAnomalies,
      });
      const { ids } = registry.assignEntities(level, identity.entities, {
        recordedOn: '2026-10-04',
        anomalies: identityAnomalies,
      });
      const entities: IdentifiedEntity<L>[] = identity.entities.map((e) => {
        const id = ids.get(e.key);
        if (id === undefined) throw new Error(`no id for ${level} ${e.key}`);
        return { ...e, id };
      });
      return { identity, entities };
    };

    const regions = identify('region', world.region);
    const provinces = identify('province', world.province);
    const municipalities = world.municipality === undefined ? null : identify('municipality', world.municipality);
    const regionTimeline = EntityTimeline.of('region', regions.entities);
    const provinceTimeline = EntityTimeline.of('province', provinces.entities);
    const overrides = new OverrideRun(world.overrides ?? []);
    const provinceDrafts = buildProvinceVersions({
      entities: provinces.entities,
      regions: regionTimeline,
      municipalities: world.municipality?.index ?? new IntervalIndex('municipality', new Map()),
      overrides,
      anomalies,
    });
    const appliedOverrides = overrides.finish(anomalies);
    return {
      region: buildRegionVersions({ entities: regions.entities, anomalies }),
      province: provinceDrafts,
      municipality:
        municipalities === null
          ? []
          : buildMunicipalityVersions({
              entities: municipalities.entities,
              provinces: provinceTimeline,
              regions: regionTimeline,
              anomalies,
            }),
      identity: {
        region: regions.identity,
        province: provinces.identity,
        ...(municipalities === null ? {} : { municipality: municipalities.identity }),
      },
      identified: {
        region: regions.entities,
        province: provinces.entities,
        municipality: municipalities?.entities ?? [],
      },
      registry,
      intervals: {
        region: intervalsById(regions.entities),
        province: intervalsById(provinces.entities),
        municipality: intervalsById(municipalities?.entities ?? []),
      },
      identityAnomalies,
      anomalies,
      appliedOverrides,
    };
  });
}

function intervalsById(entities: readonly IdentifiedEntity[]): Map<EntityId, readonly HalfOpenInterval[]> {
  return new Map(entities.map((e) => [e.id, e.intervals]));
}

/** The entity with a version of `code` on `date`. */
export function entityAt<E extends { versions: readonly (HalfOpenInterval & { istatCode: string })[] }>(
  entities: readonly E[],
  code: string,
  date: IsoDate,
): E {
  const entity = entities.find((e) => e.versions.some((v) => v.istatCode === code && within(v, date)));
  if (entity === undefined) throw new Error(`no entity with ${code} on ${date}`);
  return entity;
}

function within(interval: HalfOpenInterval, date: IsoDate): boolean {
  return interval.validFrom <= date && (interval.validTo === null || date < interval.validTo);
}

/**
 * I1–I3 as properties of built versions: sorted, non-empty, non-overlapping (I1); consecutive
 * versions contiguous or separated by a gap in the entity's snapshot intervals (I2); contiguous
 * versions differ in a published field (I3). Returns the violations.
 */
export function versionPropertyViolations(
  entities: readonly EntityByLevel[Level][],
  intervalsOf: (entityId: EntityId) => readonly HalfOpenInterval[],
): string[] {
  const violations: string[] = [];
  for (const entity of entities) {
    const { versions } = entity;
    versions.forEach((v, i) => {
      if (v.validTo !== null && v.validFrom >= v.validTo) violations.push(`${entity.id}: empty version ${v.validFrom}`);
      const previous = versions[i - 1];
      if (previous === undefined) return;
      if (previous.validTo === null || previous.validTo > v.validFrom) {
        violations.push(`${entity.id}: ${previous.validFrom} overlaps or follows ${v.validFrom}`);
        return;
      }
      if (previous.validTo === v.validFrom) {
        const fields = (version: object): string =>
          JSON.stringify({ ...version, validFrom: undefined, validTo: undefined });
        if (fields(previous) === fields(v)) {
          violations.push(`${entity.id}: ${previous.validFrom} and ${v.validFrom} are not maximal`);
        }
      } else {
        const gap = { validFrom: previous.validTo, validTo: v.validFrom };
        if (
          intervalsOf(entity.id).some(
            (i) => (i.validTo === null || i.validTo > gap.validFrom) && i.validFrom < gap.validTo,
          )
        ) {
          violations.push(`${entity.id}: gap ${gap.validFrom}…${gap.validTo} while the entity exists`);
        }
      }
    });
  }
  return violations;
}
