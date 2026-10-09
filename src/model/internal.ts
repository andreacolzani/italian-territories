/**
 * Internal domain model used by the whole pipeline (§4, §5, §6).
 *
 * Differences from the public model (§9): camelCase fields, half-open intervals
 * `[validFrom, validTo)` (§4.1), internal-only data (§5.5), participations without effect still
 * present (dropped by the emitter, §4.3), anomalies of every level.
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

/** A value that holds over a half-open interval. */
export type Dated<T> = HalfOpenInterval & { value: T };

// ---------------------------------------------------------------------------------------------
// Snapshot projections (§3.2, §6.2): the only fields of a SITUAS snapshot row that take part in
// equality checks. Codes are zero-padded strings, missing values are null, strings are NFC.
// ---------------------------------------------------------------------------------------------

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
   * `COD_PROV_STORICO` (internal only, §5.5): the municipality code prefix. Equals `code` before
   * 1948 and wherever SITUAS omits the field (§3.5); the fallback is checked by invariant I7.
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
  /**
   * Historical code of the parent UTS (§5.5): `COD_PROV_STORICO`, falling back to `utsCode`
   * before 1948 and wherever SITUAS omits the field (§3.5).
   */
  historicalUtsCode: string;
}

export interface SnapshotRowByLevel {
  region: RegionSnapshotRow;
  province: UtsSnapshotRow;
  municipality: MunicipalitySnapshotRow;
}

/** All territories of one level existing on one date (§2). */
export interface Snapshot<L extends Level = Level> {
  level: L;
  date: IsoDate;
  rows: SnapshotRowByLevel[L][];
}

// ---------------------------------------------------------------------------------------------
// Entities and versions (§4.2)
// ---------------------------------------------------------------------------------------------

/** A version has no id: it is identified by `(entity id, validFrom)` (§4.2, D40). */
interface VersionBase extends HalfOpenInterval {
  istatCode: string;
  officialName: string;
  italianName: string;
  foreignName: string | null;
}

/**
 * Regions and UTS: a bilingual denomination missing from the closed table (§4.2) leaves both names
 * null (`bilingual-name-unknown`, blocking); the emitter refuses them.
 */
interface RegionalNames {
  italianName: string | null;
  foreignName: string | null;
}

export interface RegionVersion extends Omit<VersionBase, 'italianName'>, RegionalNames {
  type: RegionType;
}

/*
 * A `null` abbreviation, `regionId` or `provinceId` means the version builder could not determine
 * it (a parent code resolving to no entity, a pre-1948 abbreviation not unanimous): the builder
 * reports a `blocking` anomaly and keeps the version. Invariants I4 and I8 report the null field;
 * the checks that depend on it (I5, I7) skip the version instead of adding derived anomalies. The
 * public model never admits these nulls: the emitter refuses them (Step 16).
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
  /** Registry id `<prefix>-<code>` (§5.3). */
  id: EntityId;
  /** Root ISTAT origin id (internal only, D41). */
  istatOriginId: number | null;
  /** Sorted by `validFrom`, non-overlapping (I1). */
  versions: VersionByLevel[L][];
}

export type RegionEntity = Entity<'region'>;
export type MunicipalityEntity = Entity<'municipality'>;

/**
 * UTS entity. `historicalCodes` (`COD_PROV_STORICO`, §5.5) is kept as its own timeline rather than
 * as a version field: it is not published, so it must not split versions (§4.2), and it is only
 * needed by invariant I7.
 */
export interface ProvinceEntity extends Entity<'province'> {
  historicalCodes: Dated<string>[];
}

export interface EntityByLevel {
  region: RegionEntity;
  province: ProvinceEntity;
  municipality: MunicipalityEntity;
}

/** A published link (§7): `transferred_to` never appears, `split_into` is derived (D44). */
export interface EntityLink {
  id: EntityId;
  kind: PublicLinkKind;
  date: IsoDate;
}

/** Derived fields (§7), computed after overrides. */
export interface DerivedFields {
  status: EntityStatus;
  isFormerItalian: boolean;
  predecessors: EntityLink[];
  successors: EntityLink[];
  /** Ids of active entities of the same level, sorted (ordinal string order). */
  currentSuccessors: EntityId[];
}

// ---------------------------------------------------------------------------------------------
// Variations (§4.3)
// ---------------------------------------------------------------------------------------------

export interface Participant {
  level: Level;
  entityId: EntityId;
  istatEvents: IstatEventCode[];
  /** The counterpart of one of its events (`AS`, `AN`, `CE`, `AQ`) is a foreign state (§4.3). */
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

// ---------------------------------------------------------------------------------------------
// Anomalies (§8.2)
// ---------------------------------------------------------------------------------------------

export interface Anomaly {
  level: AnomalyLevel;
  /** Stable machine identifier. */
  code: string;
  message: string;
  /** Entity/version/variation ids, codes, dates, source rows. */
  context: Record<string, unknown>;
}
