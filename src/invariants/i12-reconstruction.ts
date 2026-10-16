/**
 * §8.1. Before 1948 the snapshot has no abbreviation, so the expected one is derived from the
 * municipality rows of the same snapshot with the builder's own function.
 */
import { regionalNames } from '../build/bilingual-names.ts';
import { municipalityAbbreviations } from '../build/timeline.ts';
import { compareDates, containsDate, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import { LEVELS, type EntityId, type Level } from '../model/common.ts';
import type { Anomaly, SnapshotRowByLevel, VersionByLevel } from '../model/internal.ts';
import type { AppliedOverride } from '../overrides/index.ts';
import { REGIME_1948_START } from '../sources/situas-public/pfun.ts';
import { violation } from './anomaly.ts';
import type { HistoricalCodes, InvariantEntities } from './world.ts';

export interface SnapshotSet {
  date: IsoDate;
  rows: { [L in Level]?: readonly SnapshotRowByLevel[L][] };
}

export const MAX_LISTED = 20;

interface FieldDifference {
  field: string;
  snapshot: unknown;
  version: unknown;
}

interface Difference {
  code: string;
  kind: 'field' | 'no-version' | 'no-row' | 'ambiguous' | 'count';
  entityId?: EntityId;
  versionFrom?: IsoDate;
  fields?: FieldDifference[];
  rows?: number;
  versions?: number;
}

interface Placed<V> {
  entityId: EntityId;
  version: V;
}

type IndexedVersion = HalfOpenInterval & { istatCode: string };

class LevelIndex<V extends IndexedVersion> {
  readonly byCode = new Map<string, Placed<V>[]>();
  readonly #byEntity = new Map<EntityId, readonly V[]>();
  readonly #starts: IsoDate[] = [];
  readonly #ends: IsoDate[] = [];

  constructor(entities: readonly { id: EntityId; versions: readonly V[] }[]) {
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

  count(date: IsoDate): number {
    return upperBound(this.#starts, date) - upperBound(this.#ends, date);
  }

  at(entityId: EntityId | null, date: IsoDate): V | undefined {
    return entityId === null ? undefined : this.#byEntity.get(entityId)?.find((v) => containsDate(v, date));
  }

  valid(date: IsoDate): Placed<V>[] {
    return [...this.byCode.values()].flat().filter((p) => containsDate(p.version, date));
  }
}

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
  reported: () => ReadonlyMap<string, readonly string[]> | undefined;
  uncompared: { versions: Set<string>; dates: Set<IsoDate> };
}

function compare(fields: [string, unknown, unknown][]): FieldDifference[] {
  return fields.filter(([, a, b]) => a !== b).map(([field, snapshot, version]) => ({ field, snapshot, version }));
}

function historicalAt(context: Context, utsId: EntityId | null, date: IsoDate): string | null {
  if (utsId === null) return null;
  return context.historicalCodes.get(utsId)?.find((p) => containsDate(p, date))?.value ?? null;
}

function names(row: { name: string }, version: VersionByLevel['region'] | VersionByLevel['province']) {
  const wanted = regionalNames(row.name);
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
  // Abbreviations are the only field an override replaces (§6.10), on the days it covers.
  const overridden = context.overrides.find((o) => o.entityId === placed.entityId && containsDate(o, context.date));
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
      context.uncompared.versions.add(`${placed.entityId}:${version.validFrom}`);
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

function compareRows<R extends { code: string }, V extends IndexedVersion>(
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
      found.push({
        code: row.code,
        kind: 'field',
        entityId: placed.entityId,
        versionFrom: placed.version.validFrom,
        fields,
      });
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
        versionFrom: placed.version.validFrom,
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
      return `${where} has a version (entity ${difference.entityId}, from ${difference.versionFrom}) but no row`;
    case 'ambiguous':
      return `${where} has several versions`;
    case 'count':
      return `${difference.rows} rows for ${difference.versions} versions`;
    case 'field':
      return `${where}: ${(difference.fields ?? []).map((f) => `${f.field} ${JSON.stringify(f.snapshot)} vs ${JSON.stringify(f.version)}`).join(', ')}`;
  }
}
