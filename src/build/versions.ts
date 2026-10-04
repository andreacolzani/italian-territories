/**
 * Version builder (§4.2, §6.9, Step 10): the versions of every entity of a level, internally
 * half-open, from the snapshot intervals the identity stage attached to it (Step 9).
 *
 * - A version is a maximal period in which every published field is constant: contiguous pieces
 *   with equal fields are merged, so changes of unpublished fields (`COD_PROV_STORICO`, a parent's
 *   code or name) split snapshot intervals but not versions. A gap in the entity's intervals
 *   (a reconstitution) is a gap between versions.
 * - Parents are entity ids: the parent code of a row is resolved, on every date of the row, to the
 *   entity that code identifies at that level (municipality → UTS via `COD_PROV`/`COD_UTS`, UTS and
 *   municipality → region via `COD_COMP`/`COD_REG`). A municipality's `regionId` comes from its own
 *   region code; I5 checks it against the region of its UTS.
 * - UTS abbreviation: `SIGLA_AUTOMOBILISTICA` from 1948; before, the `SIGLA_UTS` reported by the
 *   municipalities of the UTS on each date, which must be unanimous. Non-conforming values (e.g.
 *   `Venezia Giulia`) are kept: overrides come later (Step 12) and I8 checks the result. A missing
 *   `SIGLA_AUTOMOBILISTICA` stays null without an anomaly here, for the same reason.
 * - Regions and UTS: a name containing `/` is split into Italian and foreign part (§4.2);
 *   municipalities take `COMUNE`, `COMUNE_IT` and `COMUNE_A` as they are.
 *
 * A field that cannot be determined (a parent code identifying no entity, pre-1948 abbreviations
 * missing or not unanimous) is null in the version and a `blocking` anomaly, one per version and
 * cause; the version is kept, so later stages still run (see the internal model).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, type HalfOpenInterval } from '../dates/index.ts';
import { canonicalJson } from '../http/index.ts';
import type { Level } from '../model/common.ts';
import type {
  Dated,
  EntityByLevel,
  MunicipalitySnapshotRow,
  RegionSnapshotRow,
  UtsSnapshotRow,
  VersionByLevel,
} from '../model/internal.ts';
import { versionKey, type AssignOptions, type Assignment, type Registry } from '../identity/index.ts';
import type { IntervalIndex, SnapshotInterval } from '../resolve/index.ts';
import { REGIME_1948_START } from '../sources/situas-public/pfun.ts';
import {
  cover,
  EntityTimeline,
  mergeDated,
  municipalityAbbreviations,
  splitRange,
  valueAt,
  type IdentifiedEntity,
} from './timeline.ts';

/** A version before its registry id (§5.3). */
export type VersionDraft<L extends Level = Level> = Omit<VersionByLevel[L], 'id'>;

/** An entity whose versions have no registry id yet. */
export type EntityDraft<L extends Level = Level> = Omit<EntityByLevel[L], 'versions'> & {
  versions: VersionDraft<L>[];
};

/** Stable anomaly codes of the version builder (§8.2). */
export const VERSION_ANOMALIES = {
  /** A parent code identifies no entity of the parent level on some dates of a version. */
  parentUnresolved: 'version-parent-unresolved',
  /** The municipalities of a pre-1948 UTS report no abbreviation, or more than one. */
  abbreviationUnderived: 'abbreviation-underived',
} as const;

/** Why a field of a piece is null; becomes one anomaly per version. */
interface Note {
  code: string;
  field: string;
  message: string;
  detail: Record<string, unknown>;
}

type Fields<L extends Level> = Omit<VersionDraft<L>, keyof HalfOpenInterval>;

interface Piece<L extends Level> extends HalfOpenInterval {
  fields: Fields<L>;
  notes: Note[];
}

export function buildRegionVersions(options: {
  entities: readonly IdentifiedEntity<'region'>[];
  anomalies: AnomalyCollector;
}): EntityDraft<'region'>[] {
  return options.entities.map((entity) =>
    draft('region', entity, options.anomalies, (interval) => {
      const row: RegionSnapshotRow = interval.row;
      return [
        { ...range(interval), fields: { istatCode: row.code, ...splitName(row.name), type: row.type }, notes: [] },
      ];
    }),
  );
}

export function buildProvinceVersions(options: {
  entities: readonly IdentifiedEntity<'province'>[];
  regions: EntityTimeline;
  /** The municipality index: pre-1948 abbreviations (§6.9). */
  municipalities: IntervalIndex<'municipality'>;
  anomalies: AnomalyCollector;
}): EntityDraft<'province'>[] {
  const abbreviations = municipalityAbbreviations(options.municipalities.all());
  return options.entities.map((entity) => {
    const built = draft('province', entity, options.anomalies, (interval) => {
      const row: UtsSnapshotRow = interval.row;
      const regions = parentPieces(options.regions, row.regionCode, interval);
      const derived = row.abbreviation === null && compareDates(interval.validFrom, REGIME_1948_START) < 0;
      const sigle = derived
        ? cover<string[]>(interval, abbreviations.get(row.code) ?? [], [])
        : [{ ...range(interval), value: [] }];
      return splitRange(interval, [regions, sigle]).map((sub) => {
        const regionId = valueAt(regions, sub.validFrom);
        const values = valueAt(sigle, sub.validFrom);
        const abbreviation = derived ? (values.length === 1 ? (values[0] ?? null) : null) : row.abbreviation;
        const notes: Note[] = [];
        if (regionId === null) notes.push(parentNote('region', 'regionId', row.regionCode));
        if (derived && abbreviation === null) {
          notes.push({
            code: VERSION_ANOMALIES.abbreviationUnderived,
            field: 'abbreviation',
            message:
              values.length === 0
                ? `no municipality of UTS ${row.code} reports an abbreviation`
                : `the municipalities of UTS ${row.code} report ${values.length} abbreviations (${values.join(', ')})`,
            detail: { utsCode: row.code, values },
          });
        }
        const fields: Fields<'province'> = {
          istatCode: row.code,
          ...splitName(row.name),
          type: row.type,
          abbreviation,
          regionId,
        };
        return { ...sub, fields, notes };
      });
    });
    const historicalCodes = mergeDated(
      entity.intervals.map((i) => ({ ...range(i), value: i.row.historicalCode })),
      (v) => v,
    );
    return { ...built, historicalCodes };
  });
}

export function buildMunicipalityVersions(options: {
  entities: readonly IdentifiedEntity<'municipality'>[];
  provinces: EntityTimeline;
  regions: EntityTimeline;
  anomalies: AnomalyCollector;
}): EntityDraft<'municipality'>[] {
  return options.entities.map((entity) =>
    draft('municipality', entity, options.anomalies, (interval) => {
      const row: MunicipalitySnapshotRow = interval.row;
      const provinces = parentPieces(options.provinces, row.utsCode, interval);
      const regions = parentPieces(options.regions, row.regionCode, interval);
      return splitRange(interval, [provinces, regions]).map((sub) => {
        const provinceId = valueAt(provinces, sub.validFrom);
        const regionId = valueAt(regions, sub.validFrom);
        const notes: Note[] = [];
        if (provinceId === null) notes.push(parentNote('province', 'provinceId', row.utsCode));
        if (regionId === null) notes.push(parentNote('region', 'regionId', row.regionCode));
        const fields: Fields<'municipality'> = {
          istatCode: row.code,
          officialName: row.officialName,
          italianName: row.italianName,
          foreignName: row.foreignName,
          cadastralCode: row.cadastralCode,
          provinceId,
          regionId,
        };
        return { ...sub, fields, notes };
      });
    }),
  );
}

/**
 * `official_name` of a region or UTS with its Italian and foreign parts: split on the first `/`
 * (`Bolzano/Bozen`), never on `-` (§4.2).
 */
export function splitName(name: string): { officialName: string; italianName: string; foreignName: string | null } {
  const slash = name.indexOf('/');
  if (slash < 0) return { officialName: name, italianName: name, foreignName: null };
  const foreign = name.slice(slash + 1).trim();
  return { officialName: name, italianName: name.slice(0, slash).trim(), foreignName: foreign === '' ? null : foreign };
}

/** The versions of one entity: its pieces, merged while their fields are equal. */
function draft<L extends Level>(
  level: L,
  entity: IdentifiedEntity<L>,
  anomalies: AnomalyCollector,
  pieces: (interval: SnapshotInterval<L>) => Piece<L>[],
): { level: L; id: number; istatOriginId: number | null; versions: VersionDraft<L>[] } {
  const merged: Piece<L>[] = [];
  for (const piece of [...entity.intervals].sort((a, b) => compareDates(a.validFrom, b.validFrom)).flatMap(pieces)) {
    const last = merged[merged.length - 1];
    if (last?.validTo === piece.validFrom && sameFields(last.fields, piece.fields)) {
      last.validTo = piece.validTo;
      last.notes.push(...piece.notes);
    } else {
      merged.push({ ...piece, notes: [...piece.notes] });
    }
  }
  const versions = merged.map((piece) => {
    report(level, entity, piece, anomalies);
    return { validFrom: piece.validFrom, validTo: piece.validTo, ...piece.fields } as VersionDraft<L>;
  });
  return { level, id: entity.id, istatOriginId: entity.istatOriginId, versions };
}

function report<L extends Level>(
  level: L,
  entity: IdentifiedEntity<L>,
  piece: Piece<L>,
  anomalies: AnomalyCollector,
): void {
  const seen = new Set<string>();
  for (const note of piece.notes) {
    const key = canonicalJson([note.code, note.field, note.detail]);
    if (seen.has(key)) continue;
    seen.add(key);
    anomalies.add({
      level: 'blocking',
      code: note.code,
      message: `${level} entity ${entity.id}, version from ${piece.validFrom}: ${note.field} is undetermined, ${note.message}`,
      context: {
        level,
        entityId: entity.id,
        istatOriginId: entity.istatOriginId,
        validFrom: piece.validFrom,
        validTo: piece.validTo,
        istatCode: piece.fields.istatCode,
        field: note.field,
        ...note.detail,
      },
    });
  }
}

function parentPieces(timeline: EntityTimeline, code: string, interval: HalfOpenInterval): Dated<number | null>[] {
  return timeline.over(code, range(interval));
}

function parentNote(parentLevel: Level, field: string, code: string): Note {
  return {
    code: VERSION_ANOMALIES.parentUnresolved,
    field,
    message: `${parentLevel} code ${code} identifies no entity`,
    detail: { parentLevel, parentCode: code },
  };
}

function range(interval: HalfOpenInterval): HalfOpenInterval {
  return { validFrom: interval.validFrom, validTo: interval.validTo };
}

function sameFields(a: object, b: object): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** The entities with the registry ids of their versions (§5.3: `<entity id>:<validFrom>`). */
export function registerVersions<L extends Level>(
  registry: Registry,
  level: L,
  drafts: readonly EntityDraft<L>[],
  options: AssignOptions,
): { entities: EntityByLevel[L][]; assignment: Assignment } {
  const assignment = registry.assignVersions(
    level,
    drafts.flatMap((e) => e.versions.map((v) => ({ entityId: e.id, validFrom: v.validFrom, validTo: v.validTo }))),
    options,
  );
  const entities = drafts.map((e) => {
    const versions = e.versions.map((v) => {
      const id = assignment.ids.get(versionKey(e.id, v.validFrom));
      if (id === undefined) throw new Error(`no id for version ${versionKey(e.id, v.validFrom)}`);
      return { id, ...v };
    });
    return { ...e, versions } as unknown as EntityByLevel[L];
  });
  return { entities, assignment };
}
