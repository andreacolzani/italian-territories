/**
 * Version builder (§4.2, §6.9): the versions of every entity of a level, internally
 * half-open, from the snapshot intervals the identity stage attached to it.
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
 *   `Venezia Giulia`) are kept: overrides come later (§6.10) and I8 checks the result. A missing
 *   `SIGLA_AUTOMOBILISTICA` stays null without an anomaly here, for the same reason.
 * - Regions and UTS: a denomination with `/` takes its Italian and foreign names from the closed
 *   table of `bilingual-names.ts` (§4.2); one missing from the table has null names and is a
 *   `blocking` `bilingual-name-unknown`, one per level and denomination, with the decomposition
 *   the rule suggests. Municipalities take `COMUNE`, `COMUNE_IT` and `COMUNE_A` as they are.
 *
 * A field that cannot be determined (a parent code identifying no entity, pre-1948 abbreviations
 * missing or not unanimous) is null in the version and a `blocking` anomaly, one per version and
 * cause; the version is kept, so later stages still run (see the internal model).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import { canonicalJson } from '../http/index.ts';
import type { EntityId, Level } from '../model/common.ts';
import type {
  Dated,
  EntityByLevel,
  MunicipalitySnapshotRow,
  RegionSnapshotRow,
  UtsSnapshotRow,
  VersionByLevel,
} from '../model/internal.ts';
import { boundaryCreated, type OverrideRun } from '../overrides/apply.ts';
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
import { decomposeBilingual, isUnknownBilingual, regionalNames } from './bilingual-names.ts';

/** Stable anomaly codes of the version builder (§8.2). */
export const VERSION_ANOMALIES = {
  /** A parent code identifies no entity of the parent level on some dates of a version. */
  parentUnresolved: 'version-parent-unresolved',
  /** The municipalities of a pre-1948 UTS report no abbreviation, or more than one. */
  abbreviationUnderived: 'abbreviation-underived',
  /** A region or UTS denomination with `/` missing from the bilingual name table (§4.2). */
  bilingualNameUnknown: 'bilingual-name-unknown',
} as const;

/** Why a field of a piece is null; becomes one anomaly per version. */
interface Note {
  code: string;
  field: string;
  message: string;
  detail: Record<string, unknown>;
}

type Fields<L extends Level> = Omit<VersionByLevel[L], keyof HalfOpenInterval>;

interface Piece<L extends Level> extends HalfOpenInterval {
  fields: Fields<L>;
  notes: Note[];
}

export function buildRegionVersions(options: {
  entities: readonly IdentifiedEntity<'region'>[];
  anomalies: AnomalyCollector;
}): EntityByLevel['region'][] {
  const regions = options.entities.map((entity) =>
    draft('region', entity, options.anomalies, (interval) => {
      const row: RegionSnapshotRow = interval.row;
      return [
        { ...range(interval), fields: { istatCode: row.code, ...regionalNames(row.name), type: row.type }, notes: [] },
      ];
    }),
  );
  reportUnknownBilingual('region', regions, options.anomalies);
  return regions;
}

export function buildProvinceVersions(options: {
  entities: readonly IdentifiedEntity<'province'>[];
  regions: EntityTimeline;
  /** The municipality index: pre-1948 abbreviations (§6.9). */
  municipalities: IntervalIndex<'municipality'>;
  /** Curated corrections, applied to the values of every day before the merge (§6.10). */
  overrides?: OverrideRun;
  anomalies: AnomalyCollector;
}): EntityByLevel['province'][] {
  const abbreviations = municipalityAbbreviations(options.municipalities.all());
  const run = options.overrides;
  const provinces = options.entities.map((entity) => {
    const overridden =
      run === undefined
        ? undefined
        : (pieces: Piece<'province'>[]): Piece<'province'>[] => {
            const result = pieces.flatMap((piece) => overridePiece(run, entity.id, piece));
            // An override may remove version boundaries, never create one (§6.10).
            const before = new Set(boundaries(merge(pieces)));
            for (const date of boundaries(merge(result))) {
              if (before.has(date)) continue;
              const at = result.find((p) => p.validFrom === date) ?? result[0];
              options.anomalies.add(boundaryCreated(entity.id, at?.fields.istatCode ?? '', date, run.overrides));
            }
            return result;
          };
    const built = draft(
      'province',
      entity,
      options.anomalies,
      (interval) => {
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
            ...regionalNames(row.name),
            type: row.type,
            abbreviation,
            regionId,
          };
          return { ...sub, fields, notes };
        });
      },
      overridden,
    );
    const historicalCodes = mergeDated(
      entity.intervals.map((i) => ({ ...range(i), value: i.row.historicalCode })),
      (v) => v,
    );
    return { ...built, historicalCodes };
  });
  reportUnknownBilingual('province', provinces, options.anomalies);
  return provinces;
}

export function buildMunicipalityVersions(options: {
  entities: readonly IdentifiedEntity<'municipality'>[];
  provinces: EntityTimeline;
  regions: EntityTimeline;
  anomalies: AnomalyCollector;
}): EntityByLevel['municipality'][] {
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
 * One `blocking` `bilingual-name-unknown` per denomination with `/` missing from the table (§4.2),
 * with the codes and periods using it and the decomposition the rule suggests.
 */
function reportUnknownBilingual(
  level: 'region' | 'province',
  entities: readonly EntityByLevel['region' | 'province'][],
  anomalies: AnomalyCollector,
): void {
  interface Use {
    entityId: EntityId;
    istatCode: string;
    validFrom: IsoDate;
    validTo: IsoDate | null;
  }
  const uses = new Map<string, Use[]>();
  for (const entity of entities) {
    for (const v of entity.versions) {
      if (!isUnknownBilingual(v.officialName)) continue;
      const list = uses.get(v.officialName) ?? [];
      list.push({ entityId: entity.id, istatCode: v.istatCode, validFrom: v.validFrom, validTo: v.validTo });
      uses.set(v.officialName, list);
    }
  }
  for (const [name, versions] of [...uses].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const suggested = decomposeBilingual(name);
    const suggestion =
      suggested === null
        ? 'the decomposition rule suggests nothing'
        : `the decomposition rule suggests ${JSON.stringify(suggested.italianName)} / ${JSON.stringify(suggested.foreignName)}`;
    anomalies.add({
      level: 'blocking',
      code: VERSION_ANOMALIES.bilingualNameUnknown,
      message:
        `${level} denomination ${JSON.stringify(name)} is not in the bilingual name table; ${suggestion}, ` +
        'to be checked against a source before adding the entry',
      context: { level, officialName: name, suggested, versions },
    });
  }
}

/**
 * The versions of one entity: its pieces (after `transform`, e.g. the overrides), merged while
 * their fields are equal.
 */
function draft<L extends Level>(
  level: L,
  entity: IdentifiedEntity<L>,
  anomalies: AnomalyCollector,
  pieces: (interval: SnapshotInterval<L>) => Piece<L>[],
  transform: (pieces: Piece<L>[]) => Piece<L>[] = (p) => p,
): { level: L; id: EntityId; istatOriginId: number | null; versions: VersionByLevel[L][] } {
  const all = [...entity.intervals].sort((a, b) => compareDates(a.validFrom, b.validFrom)).flatMap(pieces);
  const merged = merge(transform(all));
  const versions = merged.map((piece) => {
    report(level, entity, piece, anomalies);
    return { validFrom: piece.validFrom, validTo: piece.validTo, ...piece.fields } as VersionByLevel[L];
  });
  return { level, id: entity.id, istatOriginId: entity.istatOriginId, versions };
}

/** Contiguous pieces with equal fields merged (their notes joined). */
function merge<L extends Level>(pieces: readonly Piece<L>[]): Piece<L>[] {
  const merged: Piece<L>[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last?.validTo === piece.validFrom && sameFields(last.fields, piece.fields)) {
      last.validTo = piece.validTo;
      last.notes.push(...piece.notes);
    } else {
      merged.push({ ...piece, notes: [...piece.notes] });
    }
  }
  return merged;
}

/** The dates where one version ends and the next, contiguous, begins. */
function boundaries(versions: readonly HalfOpenInterval[]): IsoDate[] {
  return versions.flatMap((v, i) => {
    const next = versions[i + 1];
    return v.validTo !== null && next?.validFrom === v.validTo ? [v.validTo] : [];
  });
}

/**
 * A UTS piece with the abbreviation overrides of its code applied on the days they cover; the
 * abbreviation an override supplies is no longer undetermined.
 */
function overridePiece(run: OverrideRun, entityId: EntityId, piece: Piece<'province'>): Piece<'province'>[] {
  return run.abbreviationOverrides(piece.fields.istatCode, piece).map((sub) => {
    const range = { validFrom: sub.validFrom, validTo: sub.validTo };
    const override = sub.value;
    if (override === null) return { ...piece, ...range, notes: [...piece.notes] };
    run.record(override, entityId, range, piece.fields.abbreviation);
    return {
      ...piece,
      ...range,
      fields: { ...piece.fields, abbreviation: override.value },
      notes: piece.notes.filter((n) => n.field !== 'abbreviation'),
    };
  });
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

function parentPieces(timeline: EntityTimeline, code: string, interval: HalfOpenInterval): Dated<EntityId | null>[] {
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
