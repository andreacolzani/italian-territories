/**
 * Internal → public model (§4, §6.12): inclusive `valid_until` (the only place the conversion
 * happens, §4.1), internal-only fields dropped (`historicalCodes`, §5.5), participations without
 * effect (`role: null`) dropped, keys in the published order, deterministic sorting:
 * entities by `id`, versions by `valid_from`, participants by `(level, territory_id)`, links by
 * `(level, from, to)` (levels in the order of `LEVELS`), `istat_events` alphabetically.
 *
 * A field the public model does not admit as null but the builder left null (Step 10) stops the
 * emitter with an `EmitError`, whatever the anomalies; so does a variation left without
 * participations and a blocking anomaly (a blocking run never publishes, §8.2).
 */
import { compareDates, toInclusive } from '../dates/index.ts';
import { canonicalJson } from '../http/index.ts';
import { ANOMALY_LEVELS, LEVELS, type Level } from '../model/common.ts';
import type {
  Anomaly,
  DerivedFields,
  Entity,
  EntityLink,
  MunicipalityVersion,
  ProvinceVersion,
  RegionVersion,
  Variation,
} from '../model/internal.ts';
import type * as Public from '../model/public.ts';
import { EmitError } from './errors.ts';

/** The world to publish: the derived entities of every level (after overrides) and the variations. */
export interface EmitWorld {
  entities: { [L in Level]: readonly (Entity<L> & DerivedFields)[] };
  variations: readonly Variation[];
}

/** The four data files (§9). */
export interface PublicData {
  regions: Public.Region[];
  provinces: Public.Province[];
  municipalities: Public.Municipality[];
  variations: Public.Variation[];
}

/** Data file name (without extension) of each level. */
export const LEVEL_FILES = {
  region: 'regions',
  province: 'provinces',
  municipality: 'municipalities',
} as const satisfies Record<Level, keyof PublicData>;

export function toPublicData(world: EmitWorld): PublicData {
  return {
    regions: entities(world.entities.region, regionVersion),
    provinces: entities(world.entities.province, provinceVersion),
    municipalities: entities(world.entities.municipality, municipalityVersion),
    variations: [...world.variations].sort((a, b) => a.id - b.id).map(variation),
  };
}

// ---------------------------------------------------------------------------------------------

function entities<L extends Level, V>(
  list: readonly (Entity<L> & DerivedFields)[],
  version: (v: Entity<L>['versions'][number], entity: Entity<L>) => V,
): (Omit<Public.Region, 'versions'> & { versions: V[] })[] {
  return [...list]
    .sort((a, b) => a.id - b.id)
    .map((e) => ({
      id: e.id,
      istat_origin_id: e.istatOriginId,
      status: e.status,
      is_former_italian: e.isFormerItalian,
      predecessors: e.predecessors.map(link),
      successors: e.successors.map(link),
      current_successors: [...e.currentSuccessors],
      versions: [...e.versions].sort((a, b) => compareDates(a.validFrom, b.validFrom)).map((v) => version(v, e)),
    }));
}

function link(l: EntityLink): Public.EntityLink {
  return { id: l.id, kind: l.kind, date: l.date, variation_id: l.variationId };
}

function common(v: RegionVersion | ProvinceVersion | MunicipalityVersion) {
  const { valid_from, valid_until } = toInclusive(v);
  return { id: v.id, valid_from, valid_until, istat_code: v.istatCode };
}

function names(v: RegionVersion | ProvinceVersion | MunicipalityVersion) {
  return { official_name: v.officialName, italian_name: v.italianName, foreign_name: v.foreignName };
}

function regionVersion(v: RegionVersion): Public.RegionVersion {
  return { ...common(v), ...names(v), type: v.type };
}

function provinceVersion(v: ProvinceVersion, e: Entity<'province'>): Public.ProvinceVersion {
  return {
    ...common(v),
    ...names(v),
    type: v.type,
    abbreviation: required(v.abbreviation, 'abbreviation', 'province', e, v),
    region_id: required(v.regionId, 'region_id', 'province', e, v),
  };
}

function municipalityVersion(v: MunicipalityVersion, e: Entity<'municipality'>): Public.MunicipalityVersion {
  return {
    ...common(v),
    cadastral_code: v.cadastralCode,
    ...names(v),
    province_id: required(v.provinceId, 'province_id', 'municipality', e, v),
    region_id: required(v.regionId, 'region_id', 'municipality', e, v),
  };
}

function required<T>(value: T | null, field: string, level: Level, e: Entity, v: { id: number }): T {
  if (value === null) {
    throw new EmitError(`${level} ${e.id} version ${v.id}: ${field} is undetermined and cannot be published`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------

const levelRank = (level: Level) => LEVELS.indexOf(level);

function variation(v: Variation): Public.Variation {
  const participants = [...v.participants]
    .sort((a, b) => levelRank(a.level) - levelRank(b.level) || a.entityId - b.entityId)
    .flatMap((p): Public.Participant[] =>
      p.role === null
        ? []
        : [
            {
              level: p.level,
              territory_id: p.entityId,
              istat_events: [...p.istatEvents].sort() as Public.Participant['istat_events'],
              abroad: p.abroad,
              role: p.role,
              version_before_id: p.versionBeforeId,
              version_after_id: p.versionAfterId,
            },
          ],
    );
  if (participants.length === 0) throw new EmitError(`variation ${v.id} (${v.date}) has no participation with effect`);
  const links = [...v.links]
    .sort((a, b) => levelRank(a.level) - levelRank(b.level) || a.from - b.from || a.to - b.to)
    .map((l): Public.VariationLink => ({ level: l.level, from: l.from, to: l.to, kind: l.kind }));
  return {
    id: v.id,
    date: v.date,
    istat_act_id: v.istatActId,
    origin: v.origin,
    description: v.description,
    participants,
    links,
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * The anomalies of `anomalies.json` (§8.2): warnings, then infos, by code, then by the canonical
 * JSON of message and context, so that the order never depends on the order stages ran in.
 * Contexts are reduced to plain JSON (`undefined` properties dropped).
 */
export function toPublicAnomalies(anomalies: readonly Anomaly[]): Public.Anomaly[] {
  const blocking = anomalies.filter((a) => a.level === 'blocking');
  if (blocking.length > 0) {
    throw new EmitError(`${blocking.length} blocking anomalies: a blocking run never publishes`);
  }
  return anomalies
    .map((a) => ({
      level: a.level,
      code: a.code,
      message: a.message,
      context: JSON.parse(JSON.stringify(a.context)) as Record<string, unknown>,
    }))
    .map((a) => ({ a, key: canonicalJson([a.message, a.context]) }))
    .sort(
      (x, y) =>
        ANOMALY_LEVELS.indexOf(x.a.level) - ANOMALY_LEVELS.indexOf(y.a.level) ||
        compareStrings(x.a.code, y.a.code) ||
        compareStrings(x.key, y.key),
    )
    .map(({ a }) => a);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
