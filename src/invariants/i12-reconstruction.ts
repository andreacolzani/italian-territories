/**
 * Invariant I12 (§8.1): the reconstruction equals SITUAS. For every snapshot given (every snapshot
 * of the store, or the audit samples), the versions valid on its date, projected, must equal the
 * rows of the snapshot (after the overrides), field by field and row by row.
 *
 * The projection of a version on a date is, per level:
 * - region: code, the names split as the builder does, type;
 * - UTS: code, names, type, the code of its region on that date, the historical code (§5.5) and
 *   the abbreviation. The expected abbreviation of a version is the value of the override applied
 *   to it, if any; else `SIGLA_AUTOMOBILISTICA` of the snapshot; before 1948 (snapshot value null)
 *   the one the municipality rows of the same snapshot report for the UTS, derived with the
 *   builder's own function (`municipalityAbbreviations`), null when not unanimous;
 * - municipality: code, the three names, cadastral code, the code of its UTS and of its region on
 *   that date, the historical code of its UTS.
 *
 * Differences are reported with one `blocking` anomaly per level and date, listing the first
 * {@link MAX_LISTED} of them: a version without row, a row without version, a code with several
 * versions, a field that differs.
 */
import { splitName } from '../build/versions.ts';
import { municipalityAbbreviations } from '../build/timeline.ts';
import { compareDates, containsDate, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import { LEVELS, type Level } from '../model/common.ts';
import type { Anomaly, SnapshotRowByLevel, VersionByLevel } from '../model/internal.ts';
import type { AppliedOverride } from '../overrides/index.ts';
import { REGIME_1948_START } from '../sources/situas-public/pfun.ts';
import { violation } from './anomaly.ts';
import type { HistoricalCodes, InvariantEntities } from './world.ts';

/** The rows of the snapshots of one date, for the levels that have one. */
export interface SnapshotSet {
  date: IsoDate;
  rows: { [L in Level]?: readonly SnapshotRowByLevel[L][] };
}

/** At most this many differences are listed in the anomaly of a level and date. */
export const MAX_LISTED = 20;

interface FieldDifference {
  field: string;
  snapshot: unknown;
  version: unknown;
}

interface Difference {
  code: string;
  kind: 'field' | 'no-version' | 'no-row' | 'ambiguous' | 'count';
  entityId?: number;
  versionId?: number;
  fields?: FieldDifference[];
  rows?: number;
  versions?: number;
}

interface Placed<V> {
  entityId: number;
  version: V;
}

class LevelIndex<V extends HalfOpenInterval & { id: number; istatCode: string }> {
  readonly byCode = new Map<string, Placed<V>[]>();
  readonly #byEntity = new Map<number, readonly V[]>();
  readonly #starts: IsoDate[] = [];
  readonly #ends: IsoDate[] = [];

  constructor(entities: readonly { id: number; versions: readonly V[] }[]) {
    for (const entity of entities) {
      this.#byEntity.set(entity.id, entity.versions);
      for (const version of entity.versions) {
        const placed = this.byCode.get(version.istatCode);
        if (placed === undefined) this.byCode.set(version.istatCode, [{ entityId: entity.id, version }]);
        else placed.push({ entityId: entity.id, version });
        this.#starts.push(version.validFrom);
        if (version.validTo !== null) this.#ends.push(version.validTo);
      }
    }
    this.#starts.sort(compareDates);
    this.#ends.sort(compareDates);
  }

  /** The number of versions valid on `date`. */
  count(date: IsoDate): number {
    return upperBound(this.#starts, date) - upperBound(this.#ends, date);
  }

  at(entityId: number | null, date: IsoDate): V | undefined {
    return entityId === null ? undefined : this.#byEntity.get(entityId)?.find((v) => containsDate(v, date));
  }

  valid(date: IsoDate): Placed<V>[] {
    return [...this.byCode.values()].flat().filter((p) => containsDate(p.version, date));
  }
}

/** The number of elements of the sorted `dates` that are `<= date`. */
function upperBound(dates: readonly IsoDate[], date: IsoDate): number {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareDates(dates[middle] ?? date, date) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface Context {
  date: IsoDate;
  regions: LevelIndex<VersionByLevel['region']>;
  provinces: LevelIndex<VersionByLevel['province']>;
  historicalCodes: HistoricalCodes;
  overrides: readonly AppliedOverride[];
  /** The abbreviations the municipalities of the snapshot report per UTS code, when it is known. */
  reported: () => ReadonlyMap<string, readonly string[]> | undefined;
  /** The pre-1948 abbreviations that could not be compared (no municipality rows on the date). */
  uncompared: { versions: Set<string>; dates: Set<IsoDate> };
}

function compare(fields: [string, unknown, unknown][]): FieldDifference[] {
  return fields.filter(([, a, b]) => a !== b).map(([field, snapshot, version]) => ({ field, snapshot, version }));
}

function historicalAt(context: Context, utsId: number | null, date: IsoDate): string | null {
  if (utsId === null) return null;
  return context.historicalCodes.get(utsId)?.find((p) => containsDate(p, date))?.value ?? null;
}

function names(row: { name: string }, version: VersionByLevel['region'] | VersionByLevel['province']) {
  const wanted = splitName(row.name);
  return [
    ['officialName', wanted.officialName, version.officialName],
    ['italianName', wanted.italianName, version.italianName],
    ['foreignName', wanted.foreignName, version.foreignName],
  ] satisfies [string, unknown, unknown][];
}

function diffRegion(row: SnapshotRowByLevel['region'], placed: Placed<VersionByLevel['region']>): FieldDifference[] {
  const { version } = placed;
  return compare([
    ['istatCode', row.code, version.istatCode],
    ...names(row, version),
    ['type', row.type, version.type],
  ]);
}

function diffProvince(
  row: SnapshotRowByLevel['province'],
  placed: Placed<VersionByLevel['province']>,
  context: Context,
): FieldDifference[] {
  const { version } = placed;
  const fields: [string, unknown, unknown][] = [
    ['istatCode', row.code, version.istatCode],
    ...names(row, version),
    ['type', row.type, version.type],
    ['historicalCode', row.historicalCode, historicalAt(context, placed.entityId, context.date)],
  ];
  if (version.regionId !== null) {
    fields.push(['regionCode', row.regionCode, context.regions.at(version.regionId, context.date)?.istatCode ?? null]);
  }
  // Abbreviations are the only field an override replaces (§6.10).
  const overridden = context.overrides.find(
    (o) => o.entityId === placed.entityId && o.validFrom === version.validFrom && o.validTo === version.validTo,
  );
  if (overridden !== undefined) {
    fields.push(['abbreviation', overridden.after, version.abbreviation]);
  } else if (row.abbreviation !== null || compareDates(context.date, REGIME_1948_START) >= 0) {
    fields.push(['abbreviation', row.abbreviation, version.abbreviation]);
  } else {
    const reported = context.reported()?.get(row.code);
    // Without the municipality rows of the date the abbreviation cannot be rebuilt.
    if (reported !== undefined || context.reported() !== undefined) {
      fields.push(['abbreviation', reported?.length === 1 ? (reported[0] ?? null) : null, version.abbreviation]);
    } else {
      context.uncompared.versions.add(`${placed.entityId}:${version.id}`);
      context.uncompared.dates.add(context.date);
    }
  }
  return compare(fields);
}

function diffMunicipality(
  row: SnapshotRowByLevel['municipality'],
  placed: Placed<VersionByLevel['municipality']>,
  context: Context,
): FieldDifference[] {
  const { version } = placed;
  const fields: [string, unknown, unknown][] = [
    ['istatCode', row.code, version.istatCode],
    ['officialName', row.officialName, version.officialName],
    ['italianName', row.italianName, version.italianName],
    ['foreignName', row.foreignName, version.foreignName],
    ['cadastralCode', row.cadastralCode, version.cadastralCode],
  ];
  if (version.provinceId !== null) {
    fields.push(
      ['utsCode', row.utsCode, context.provinces.at(version.provinceId, context.date)?.istatCode ?? null],
      ['historicalUtsCode', row.historicalUtsCode, historicalAt(context, version.provinceId, context.date)],
    );
  }
  if (version.regionId !== null) {
    fields.push(['regionCode', row.regionCode, context.regions.at(version.regionId, context.date)?.istatCode ?? null]);
  }
  return compare(fields);
}

/** What I12 could not compare: pre-1948 abbreviations on dates without municipality rows. */
export interface I12Uncompared {
  abbreviation: { versions: number; dates: number };
}

interface I12Options {
  entities: InvariantEntities;
  historicalCodes: HistoricalCodes;
  overrides: readonly AppliedOverride[];
  snapshots: Iterable<SnapshotSet> | AsyncIterable<SnapshotSet>;
}

export async function checkI12(options: I12Options): Promise<Anomaly[]> {
  return (await checkI12Detailed(options)).anomalies;
}

/**
 * {@link checkI12} with what it could not compare: the number of distinct versions and of dates whose
 * pre-1948 abbreviation was left out because the set of that date has no municipality rows.
 */
export async function checkI12Detailed(
  options: I12Options,
): Promise<{ anomalies: Anomaly[]; uncompared: I12Uncompared }> {
  const { entities } = options;
  const anomalies: Anomaly[] = [];
  const uncompared = { versions: new Set<string>(), dates: new Set<IsoDate>() };
  const indexes = {
    region: new LevelIndex(entities.region),
    province: new LevelIndex(entities.province),
    municipality: new LevelIndex(entities.municipality),
  };

  for await (const set of options.snapshots) {
    let reported: ReadonlyMap<string, readonly string[]> | undefined;
    const context: Context = {
      date: set.date,
      regions: indexes.region,
      provinces: indexes.province,
      historicalCodes: options.historicalCodes,
      overrides: options.overrides,
      uncompared,
      reported: () => {
        const rows = set.rows.municipality;
        if (reported === undefined && rows !== undefined) {
          const pieces = municipalityAbbreviations(
            rows.map((row) => ({ level: 'municipality', code: row.code, row, validFrom: set.date, validTo: null })),
          );
          reported = new Map([...pieces].map(([code, dated]) => [code, dated[0]?.value ?? []]));
        }
        return reported;
      },
    };
    for (const level of LEVELS) {
      if (set.rows[level] === undefined) continue;
      const differences =
        level === 'region'
          ? compareRows(set.date, set.rows.region ?? [], indexes.region, (row, placed) => diffRegion(row, placed))
          : level === 'province'
            ? compareRows(set.date, set.rows.province ?? [], indexes.province, (row, placed) =>
                diffProvince(row, placed, context),
              )
            : compareRows(set.date, set.rows.municipality ?? [], indexes.municipality, (row, placed) =>
                diffMunicipality(row, placed, context),
              );
      if (differences.length === 0) continue;
      anomalies.push(
        violation(
          'I12',
          `the ${level} versions valid on ${set.date} differ from the snapshot in ${differences.length} place(s), e.g. ${describe(differences[0])}`,
          { level, date: set.date, total: differences.length, differences: differences.slice(0, MAX_LISTED) },
        ),
      );
    }
  }
  return {
    anomalies,
    uncompared: { abbreviation: { versions: uncompared.versions.size, dates: uncompared.dates.size } },
  };
}

/** The differences between the rows of a snapshot and the versions of `index` valid on its date. */
function compareRows<R extends { code: string }, V extends HalfOpenInterval & { id: number; istatCode: string }>(
  date: IsoDate,
  rows: readonly R[],
  index: LevelIndex<V>,
  diff: (row: R, placed: Placed<V>) => FieldDifference[],
): Difference[] {
  const found: Difference[] = [];
  const matched = new Set<V>();
  for (const row of rows) {
    const candidates = (index.byCode.get(row.code) ?? []).filter((p) => containsDate(p.version, date));
    const [placed] = candidates;
    if (placed === undefined) {
      found.push({ code: row.code, kind: 'no-version' });
      continue;
    }
    for (const candidate of candidates) matched.add(candidate.version);
    if (candidates.length > 1) {
      found.push({ code: row.code, kind: 'ambiguous', versions: candidates.length });
      continue;
    }
    const fields = diff(row, placed);
    if (fields.length > 0) {
      found.push({ code: row.code, kind: 'field', entityId: placed.entityId, versionId: placed.version.id, fields });
    }
  }
  const valid = index.count(date);
  if (valid !== rows.length || matched.size !== valid) {
    for (const placed of index.valid(date)) {
      if (matched.has(placed.version)) continue;
      found.push({
        code: placed.version.istatCode,
        kind: 'no-row',
        entityId: placed.entityId,
        versionId: placed.version.id,
      });
    }
    if (valid !== rows.length) found.unshift({ code: '', kind: 'count', rows: rows.length, versions: valid });
  }
  return found;
}

function describe(difference: Difference | undefined): string {
  if (difference === undefined) return '';
  const where = `code ${difference.code}`;
  switch (difference.kind) {
    case 'no-version':
      return `${where} has a row but no version`;
    case 'no-row':
      return `${where} has a version (${difference.versionId}) but no row`;
    case 'ambiguous':
      return `${where} has several versions`;
    case 'count':
      return `${difference.rows} rows for ${difference.versions} versions`;
    case 'field':
      return `${where}: ${(difference.fields ?? []).map((f) => `${f.field} ${JSON.stringify(f.snapshot)} vs ${JSON.stringify(f.version)}`).join(', ')}`;
  }
}
