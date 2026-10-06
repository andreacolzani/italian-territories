/**
 * Public → internal model (Step 17, `validate`): the inverse of `toPublicData`, so the invariants
 * (§8.1) run on a published dataset. Inclusive `valid_until` becomes the half-open `validTo` with the
 * `src/dates/` conversion; derived fields are read as published.
 *
 * What the public files do not carry stays out: the UTS historical codes (`historicalCodes` is left
 * empty, and the world built by `validate` has no `historicalCodes`, so I7 and I12 are skipped) and
 * the participations without effect (dropped by the emitter).
 */
import { toHalfOpen } from '../dates/index.ts';
import type { InvariantEntities, InvariantEntity } from '../invariants/index.ts';
import type { Level } from '../model/common.ts';
import type {
  DerivedFields,
  EntityLink,
  MunicipalityVersion,
  ProvinceVersion,
  RegionVersion,
  Variation,
} from '../model/internal.ts';
import type * as Public from '../model/public.ts';
import type { PublicData } from './public.ts';

export interface InternalData {
  entities: InvariantEntities;
  variations: Variation[];
}

export function toInternalData(data: PublicData): InternalData {
  return {
    entities: {
      region: data.regions.map((e) => entity('region', e, regionVersion)),
      province: data.provinces.map((e) => ({ ...entity('province', e, provinceVersion), historicalCodes: [] })),
      municipality: data.municipalities.map((e) => entity('municipality', e, municipalityVersion)),
    },
    variations: data.variations.map(variation),
  };
}

function entity<L extends Level, P extends { versions: readonly unknown[] }>(
  level: L,
  e: Omit<Public.Region, 'versions'> & P,
  version: (v: P['versions'][number]) => unknown,
): InvariantEntity<L> {
  const derived: DerivedFields = {
    status: e.status,
    isFormerItalian: e.is_former_italian,
    predecessors: e.predecessors.map(link),
    successors: e.successors.map(link),
    currentSuccessors: [...e.current_successors],
  };
  return {
    level,
    id: e.id,
    istatOriginId: e.istat_origin_id,
    versions: e.versions.map(version),
    ...derived,
  } as unknown as InvariantEntity<L>;
}

function link(l: Public.EntityLink): EntityLink {
  return { id: l.id, kind: l.kind, date: l.date, variationId: l.variation_id };
}

function common(v: Public.RegionVersion | Public.ProvinceVersion | Public.MunicipalityVersion) {
  return {
    id: v.id,
    ...toHalfOpen({ valid_from: v.valid_from, valid_until: v.valid_until }),
    istatCode: v.istat_code,
    officialName: v.official_name,
    italianName: v.italian_name,
    foreignName: v.foreign_name,
  };
}

function regionVersion(v: Public.RegionVersion): RegionVersion {
  return { ...common(v), type: v.type };
}

function provinceVersion(v: Public.ProvinceVersion): ProvinceVersion {
  return { ...common(v), type: v.type, abbreviation: v.abbreviation, regionId: v.region_id };
}

function municipalityVersion(v: Public.MunicipalityVersion): MunicipalityVersion {
  return { ...common(v), cadastralCode: v.cadastral_code, provinceId: v.province_id, regionId: v.region_id };
}

function variation(v: Public.Variation): Variation {
  return {
    id: v.id,
    date: v.date,
    istatActId: v.istat_act_id,
    origin: v.origin,
    description: v.description,
    participants: v.participants.map((p) => ({
      level: p.level,
      entityId: p.territory_id,
      istatEvents: [...p.istat_events],
      abroad: p.abroad,
      role: p.role,
      versionBeforeId: p.version_before_id,
      versionAfterId: p.version_after_id,
    })),
    links: v.links.map((l) => ({ level: l.level, from: l.from, to: l.to, kind: l.kind })),
  };
}
