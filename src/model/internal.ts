/**
 * Unlike the public model: camelCase, half-open intervals (§4.1), internal-only data (§5.5),
 * participations without effect still present.
 */
import type { HalfOpenInterval, IsoDate } from '../dates/index.ts';
import type {
  AnomalyLevel,
  EntityId,
  EntityStatus,
  IstatEventCode,
  Level,
  LinkKind,
  ParticipantRole,
  PublicLinkKind,
  RegionType,
  UtsType,
  VariationOrigin,
} from './common.ts';

export type Dated<T> = HalfOpenInterval & { value: T };

// Snapshot projections: the only fields of a SITUAS row that take part in equality checks (§6.2).

export interface RegionSnapshotRow {
  /** `COD_COMP` (≤1947) / `COD_REG` (≥1948). */
  code: string;
  /** `DEN_COMP` / `DEN_REG`. */
  name: string;
  /** Compartment before 1948, region from 1948 (by regime). */
  type: RegionType;
}

export interface UtsSnapshotRow {
  /** `COD_PROV` (≤1947) / `COD_UTS` (≥1948). */
  code: string;
  /** `DEN_PROV` / `DEN_UTS`. */
  name: string;
  /** `COD_COMP` / `COD_REG`. */
  regionCode: string;
  /** Always `province` before 1948; `TIPO_UTS` afterwards. */
  type: UtsType;
  /** `SIGLA_AUTOMOBILISTICA`; null before 1948 (derived from municipalities, §6.9). */
  abbreviation: string | null;
  /**
   * `COD_PROV_STORICO` (internal, §5.5): the municipality code prefix; `code` before 1948 and wherever
   * SITUAS omits it (I7 checks the fallback).
   */
  historicalCode: string;
}

export interface MunicipalitySnapshotRow {
  /** `PRO_COM_T`. */
  code: string;
  /** `COMUNE`. */
  officialName: string;
  /** `COMUNE_IT`. */
  italianName: string;
  /** `COMUNE_A`, null when absent. */
  foreignName: string | null;
  /** `COD_CATASTO`, null when missing (`ND`). */
  cadastralCode: string | null;
  /** Parent UTS code: `COD_PROV` (≤1947) / `COD_UTS` (≥1948). */
  utsCode: string;
  /** `COD_COMP` / `COD_REG`. */
  regionCode: string;
  /** `SIGLA_UTS` / `SIGLA_AUTOMOBILISTICA` as reported (may be a full name, §3.5 item 12). */
  utsAbbreviation: string | null;
  /** `COD_PROV_STORICO`, falling back to `utsCode` before 1948 and wherever SITUAS omits it (§3.5). */
  historicalUtsCode: string;
}

export interface SnapshotRowByLevel {
  region: RegionSnapshotRow;
  province: UtsSnapshotRow;
  municipality: MunicipalitySnapshotRow;
}

export interface Snapshot<L extends Level = Level> {
  level: L;
  date: IsoDate;
  rows: SnapshotRowByLevel[L][];
}

/** A version has no id: it is identified by `(entity id, validFrom)` (§4.2, D40). */
interface VersionBase extends HalfOpenInterval {
  istatCode: string;
  officialName: string;
  italianName: string;
  foreignName: string | null;
}

/** Null when the bilingual denomination is missing from the closed table (§4.2). */
interface RegionalNames {
  italianName: string | null;
  foreignName: string | null;
}

export interface RegionVersion extends Omit<VersionBase, 'italianName'>, RegionalNames {
  type: RegionType;
}

/*
 * A null abbreviation, `regionId` or `provinceId` is undetermined: the builder reports a `blocking`
 * anomaly and keeps the version, I4 and I8 report the null, I5 and I7 skip it, the emitter refuses it.
 */

export interface ProvinceVersion extends Omit<VersionBase, 'italianName'>, RegionalNames {
  type: UtsType;
  /** Not validated against `^[A-Z]{2}$` here: overrides come later, I8 checks it. */
  abbreviation: string | null;
  regionId: EntityId | null;
}

export interface MunicipalityVersion extends VersionBase {
  cadastralCode: string | null;
  provinceId: EntityId | null;
  regionId: EntityId | null;
}

export interface VersionByLevel {
  region: RegionVersion;
  province: ProvinceVersion;
  municipality: MunicipalityVersion;
}

export interface Entity<L extends Level = Level> {
  level: L;
  id: EntityId;
  /** Internal only (D41). */
  istatOriginId: number | null;
  versions: VersionByLevel[L][];
}

export type RegionEntity = Entity<'region'>;
export type MunicipalityEntity = Entity<'municipality'>;

/** `historicalCodes` is its own timeline: it is not published, so it must not split versions (§4.2). */
export interface ProvinceEntity extends Entity<'province'> {
  historicalCodes: Dated<string>[];
}

export interface EntityByLevel {
  region: RegionEntity;
  province: ProvinceEntity;
  municipality: MunicipalityEntity;
}

export interface EntityLink {
  id: EntityId;
  kind: PublicLinkKind;
  date: IsoDate;
}

export interface DerivedFields {
  status: EntityStatus;
  isFormerItalian: boolean;
  predecessors: EntityLink[];
  successors: EntityLink[];
  /** `null` for regions and provinces (D46). */
  currentSuccessors: EntityId[] | null;
}

export interface Participant {
  level: Level;
  entityId: EntityId;
  istatEvents: IstatEventCode[];
  abroad: boolean;
  /** `null` = participation without effect: kept internally, logged and dropped on emit (§4.3). */
  role: ParticipantRole | null;
  /** `validFrom` of the version the participation closes, null when none (D40). */
  versionBefore: IsoDate | null;
  /** `validFrom` of the version the participation opens (the variation date), null when none. */
  versionAfter: IsoDate | null;
}

export interface VariationLink {
  level: Level;
  from: EntityId;
  to: EntityId;
  kind: LinkKind;
}

export interface Variation {
  id: number;
  /** First day of the new state. */
  date: IsoDate;
  istatActId: number | null;
  origin: VariationOrigin;
  description: string | null;
  participants: Participant[];
  links: VariationLink[];
}

export interface Anomaly {
  level: AnomalyLevel;
  code: string;
  message: string;
  context: Record<string, unknown>;
}
