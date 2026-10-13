/**
 * Internal → release model (§4, §6.12): the public entity files and the internal reports.
 *
 * Public files (D39): inclusive `valid_until` (the only place the conversion happens, §4.1),
 * internal-only fields dropped (`istatOriginId`, `historicalCodes`, §5.5), versions without id
 * (D40), keys in the published order, entities in {@link comparePublicOrder}, versions by
 * `valid_from`.
 *
 * Variation report: participations without effect (`role: null`) dropped, participants by
 * `(level, territory_id)`, links by `(level, from, to)` (levels in the order of `LEVELS`),
 * `istat_events` alphabetically, versions referenced by `valid_from`.
 *
 * A field the public model does not admit as null but the builder left null (§6.9, §4.2 names)
 * stops the emitter with an `EmitError`, whatever the anomalies; so does a variation left without
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
import type * as Reports from '../model/reports.ts';
import { EmitError } from './errors.ts';

/** The world to publish: the derived entities of every level (after overrides) and the variations. */
export interface EmitWorld {
  entities: { [L in Level]: readonly (Entity<L> & DerivedFields)[] };
  variations: readonly Variation[];
}

/** The three published data files (§9). */
export interface PublicData {
  regions: Public.Region[];
  provinces: Public.Province[];
  municipalities: Public.Municipality[];
}

export function toPublicData(world: Pick<EmitWorld, 'entities'>): PublicData {
  return {
    regions: entities(world.entities.region, regionVersion),
    provinces: entities(world.entities.province, provinceVersion),
    municipalities: entities(world.entities.municipality, municipalityVersion) as Public.Municipality[],
  };
}

/** The variation report (`reports/variations.json`), by id. */
export function toReportVariations(variations: readonly Variation[]): Reports.Variation[] {
  return [...variations].sort((a, b) => a.id - b.id).map(variation);
}

// ---------------------------------------------------------------------------------------------

/**
 * The order of the entities in the public files (§6.12): by internal ISTAT id (the root of the
 * identity component, §5.1), numerically; entities without one (`nk:` keys) last, by the start of
 * their first version, then by id. Stable when ISTAT codes change; presentation only.
 */
function comparePublicOrder(
  a: { id: string; istatOriginId: number | null; versions: readonly { validFrom: string }[] },
  b: { id: string; istatOriginId: number | null; versions: readonly { validFrom: string }[] },
): number {
  if (a.istatOriginId !== null && b.istatOriginId !== null) {
    return a.istatOriginId - b.istatOriginId || compareStrings(a.id, b.id);
  }
  if (a.istatOriginId !== null) return -1;
  if (b.istatOriginId !== null) return 1;
  const first = (e: typeof a): string =>
    e.versions.reduce((min, v) => (min === '' || compareDates(v.validFrom, min) < 0 ? v.validFrom : min), '');
  return compareStrings(first(a), first(b)) || compareStrings(a.id, b.id);
}

/**
 * The entities of a level in the published order and key order; `current_successors` only for
 * municipalities (D46), between `successors` and `versions`.
 */
function entities<L extends Level, V>(
  list: readonly (Entity<L> & DerivedFields)[],
  version: (v: Entity<L>['versions'][number], entity: Entity<L>) => V,
): (Omit<Public.Region, 'versions'> & { current_successors?: string[]; versions: V[] })[] {
  return [...list].sort(comparePublicOrder).map((e) => ({
    id: e.id,
    status: e.status,
    is_former_italian: e.isFormerItalian,
    predecessors: e.predecessors.map(link),
    successors: e.successors.map(link),
    ...(e.level === 'municipality' ? { current_successors: [...(e.currentSuccessors ?? [])] } : {}),
    versions: [...e.versions].sort((a, b) => compareDates(a.validFrom, b.validFrom)).map((v) => version(v, e)),
  }));
}

function link(l: EntityLink): Public.EntityLink {
  return { id: l.id, kind: l.kind, date: l.date };
}

function common(v: RegionVersion | ProvinceVersion | MunicipalityVersion) {
  const { valid_from, valid_until } = toInclusive(v);
  return { valid_from, valid_until, istat_code: v.istatCode };
}

function names(v: RegionVersion | ProvinceVersion | MunicipalityVersion, level: Level, e: Entity) {
  return {
    official_name: v.officialName,
    italian_name: required(v.italianName, 'italian_name', level, e, v),
    foreign_name: v.foreignName,
  };
}

function regionVersion(v: RegionVersion, e: Entity<'region'>): Public.RegionVersion {
  return { ...common(v), ...names(v, 'region', e), type: v.type };
}

function provinceVersion(v: ProvinceVersion, e: Entity<'province'>): Public.ProvinceVersion {
  return {
    ...common(v),
    ...names(v, 'province', e),
    type: v.type,
    abbreviation: required(v.abbreviation, 'abbreviation', 'province', e, v),
    region_id: required(v.regionId, 'region_id', 'province', e, v),
  };
}

function municipalityVersion(v: MunicipalityVersion, e: Entity<'municipality'>): Public.MunicipalityVersion {
  return {
    ...common(v),
    cadastral_code: v.cadastralCode,
    ...names(v, 'municipality', e),
    province_id: required(v.provinceId, 'province_id', 'municipality', e, v),
    region_id: required(v.regionId, 'region_id', 'municipality', e, v),
  };
}

function required<T>(value: T | null, field: string, level: Level, e: Entity, v: { validFrom: string }): T {
  if (value === null) {
    throw new EmitError(
      `${level} ${e.id} version from ${v.validFrom}: ${field} is undetermined and cannot be published`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------------------------

const levelRank = (level: Level) => LEVELS.indexOf(level);

function variation(v: Variation): Reports.Variation {
  const participants = [...v.participants]
    .sort((a, b) => levelRank(a.level) - levelRank(b.level) || compareStrings(a.entityId, b.entityId))
    .flatMap((p): Reports.Participant[] =>
      p.role === null
        ? []
        : [
            {
              level: p.level,
              territory_id: p.entityId,
              istat_events: [...p.istatEvents].sort() as Reports.Participant['istat_events'],
              abroad: p.abroad,
              role: p.role,
              version_before: p.versionBefore,
              version_after: p.versionAfter,
            },
          ],
    );
  if (participants.length === 0) throw new EmitError(`variation ${v.id} (${v.date}) has no participation with effect`);
  const links = [...v.links]
    .sort(
      (a, b) => levelRank(a.level) - levelRank(b.level) || compareStrings(a.from, b.from) || compareStrings(a.to, b.to),
    )
    .map((l): Reports.VariationLink => ({ level: l.level, from: l.from, to: l.to, kind: l.kind }));
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
 * The anomalies of `reports/anomalies.json` (§8.2): warnings, then infos, by code, then by the
 * canonical JSON of message and context, so that the order never depends on the order stages ran
 * in. Contexts are reduced to plain JSON (`undefined` properties dropped).
 */
export function toReportAnomalies(anomalies: readonly Anomaly[]): Reports.Anomaly[] {
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
