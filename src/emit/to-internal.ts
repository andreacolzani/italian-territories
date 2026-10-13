/**
 * Release → internal model (`validate`, §10.1): the inverse of `toPublicData` and
 * `toReportVariations`, so the invariants (§8.1) run on a release (the public files and the
 * variation report). Inclusive `valid_until` becomes the half-open `validTo` with the `src/dates/`
 * conversion; derived fields are read as published.
 *
 * What a release does not carry stays out: the ISTAT origin ids (null), the UTS historical codes
 * (`historicalCodes` is left empty, and the world built by `validate` has no `historicalCodes`, so
 * I7 and I12 are skipped) and the participations without effect (dropped by the emitter).
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
import type * as Reports from '../model/reports.ts';
import type { ReleaseData } from './changes.ts';

export interface InternalData {
  entities: InvariantEntities;
  variations: Variation[];
}

export function toInternalData(data: ReleaseData): InternalData {
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
    currentSuccessors: 'current_successors' in e ? [...(e.current_successors as string[])] : null,
  };
  return {
    level,
    id: e.id,
    istatOriginId: null,
    versions: e.versions.map(version),
    ...derived,
  } as unknown as InvariantEntity<L>;
}

function link(l: Public.EntityLink): EntityLink {
  return { id: l.id, kind: l.kind, date: l.date };
}

function common(v: Public.RegionVersion | Public.ProvinceVersion | Public.MunicipalityVersion) {
  return {
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

function variation(v: Reports.Variation): Variation {
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
      versionBefore: p.version_before,
      versionAfter: p.version_after,
    })),
    links: v.links.map((l) => ({ level: l.level, from: l.from, to: l.to, kind: l.kind })),
  };
}
