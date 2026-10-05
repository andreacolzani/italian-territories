/**
 * A small crafted world for the invariant tests (§8.1): one region, two UTS, four municipalities,
 * with a rename, a merger and a suppression, whose derived fields are computed by `deriveFields`.
 * Every invariant passes on it; the negative tests mutate a fresh copy (`baseline()`) so that exactly
 * one invariant is violated.
 */
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { EventAccount } from '../../src/build/index.ts';
import { deriveFields } from '../../src/derive/index.ts';
import { containsDate, type HalfOpenInterval, type IsoDate } from '../../src/dates/index.ts';
import {
  historicalCodesOf,
  type InvariantEntities,
  type InvariantEntity,
  type InvariantWorld,
  type SnapshotSet,
} from '../../src/invariants/index.ts';
import type { Level } from '../../src/model/common.ts';
import type { AppliedOverride } from '../../src/overrides/index.ts';
import type {
  Dated,
  Entity,
  MunicipalityVersion,
  Participant,
  ProvinceEntity,
  ProvinceVersion,
  RegionVersion,
  SnapshotRowByLevel,
  Variation,
} from '../../src/model/internal.ts';

export const START: IsoDate = '1861-03-17';
export const TODAY: IsoDate = '2026-01-01';
export const SNAPSHOT_DATES: IsoDate[] = ['1861-03-17', '1900-01-01', '1950-01-01', '1960-01-01', '2020-01-01'];

type Interval = [IsoDate, IsoDate | null];
const span = ([validFrom, validTo]: Interval): HalfOpenInterval => ({ validFrom, validTo });

export function regionVersion(id: number, interval: Interval, over: Partial<RegionVersion> = {}): RegionVersion {
  return {
    id,
    ...span(interval),
    istatCode: '01',
    officialName: 'Regione',
    italianName: 'Regione',
    foreignName: null,
    type: 'region',
    ...over,
  };
}

export function provinceVersion(
  id: number,
  interval: Interval,
  code: string,
  abbreviation: string,
  over: Partial<ProvinceVersion> = {},
): ProvinceVersion {
  return {
    id,
    ...span(interval),
    istatCode: code,
    officialName: `Provincia ${code}`,
    italianName: `Provincia ${code}`,
    foreignName: null,
    type: 'province',
    abbreviation,
    regionId: 1,
    ...over,
  };
}

export function municipalityVersion(
  id: number,
  interval: Interval,
  code: string,
  cadastral: string | null,
  name: string,
  over: Partial<MunicipalityVersion> = {},
): MunicipalityVersion {
  return {
    id,
    ...span(interval),
    istatCode: code,
    officialName: name,
    italianName: name,
    foreignName: null,
    cadastralCode: cadastral,
    provinceId: 1,
    regionId: 1,
    ...over,
  };
}

export function participant(
  entityId: number,
  role: NonNullable<Participant['role']> | null,
  istatEvents: Participant['istatEvents'],
  versionBeforeId: number | null,
  versionAfterId: number | null,
  over: Partial<Participant> = {},
): Participant {
  return {
    level: 'municipality',
    entityId,
    istatEvents,
    abroad: false,
    role,
    versionBeforeId,
    versionAfterId,
    ...over,
  };
}

export interface Baseline extends InvariantWorld {
  historicalCodes: NonNullable<InvariantWorld['historicalCodes']>;
  existence: NonNullable<InvariantWorld['existence']>;
  snapshots: SnapshotSet[];
  overrides: AppliedOverride[];
  counts: NonNullable<InvariantWorld['counts']>;
  accounts: EventAccount[];
  variationIdOf: NonNullable<InvariantWorld['variationIdOf']>;
  /** The provinces with their unpublished historical codes. */
  provinceEntities: ProvinceEntity[];
}

/**
 * Entities and variations:
 *
 * - municipality 1: `001001` Alfa (until 1950-01-01, RN, variation 2) then Beta;
 * - municipality 2: `001002` suppressed on 1900-01-01 and merged into 1 (variation 1, `ES`/`AQES`);
 * - municipality 3: `002001`, in UTS 2; municipality 4: `001801`, an 8xx code in UTS 1 until the
 *   suppression of 1900-01-01 (variation 1 as well, merged into 3 is not needed: into 1).
 */
export function baseline(): Baseline {
  const regionEntity = {
    level: 'region' as const,
    id: 1,
    istatOriginId: 1,
    versions: [regionVersion(1, [START, null])],
  };
  const historical = (code: string): Dated<string>[] => [{ ...span([START, null]), value: code }];
  const provinceEntities: ProvinceEntity[] = [
    {
      level: 'province',
      id: 1,
      istatOriginId: 1,
      versions: [provinceVersion(1, [START, null], '001', 'AA')],
      historicalCodes: historical('001'),
    },
    {
      level: 'province',
      id: 2,
      istatOriginId: 2,
      versions: [provinceVersion(2, [START, null], '002', 'BB')],
      historicalCodes: historical('002'),
    },
  ];
  const municipalities: Entity<'municipality'>[] = [
    {
      level: 'municipality',
      id: 1,
      istatOriginId: 1,
      versions: [
        municipalityVersion(1, [START, '1950-01-01'], '001001', 'A001', 'Alfa'),
        municipalityVersion(2, ['1950-01-01', null], '001001', 'A001', 'Beta'),
      ],
    },
    {
      level: 'municipality',
      id: 2,
      istatOriginId: 2,
      versions: [municipalityVersion(3, [START, '1900-01-01'], '001002', 'A002', 'Gamma')],
    },
    {
      level: 'municipality',
      id: 3,
      istatOriginId: 3,
      versions: [municipalityVersion(4, [START, null], '002001', 'B001', 'Delta', { provinceId: 2 })],
    },
    {
      level: 'municipality',
      id: 4,
      istatOriginId: 4,
      versions: [municipalityVersion(5, [START, '1900-01-01'], '001801', null, 'Epsilon')],
    },
  ];
  const variations: Variation[] = [
    {
      id: 1,
      date: '1900-01-01',
      istatActId: 1,
      origin: 'istat',
      description: 'Fusione',
      participants: [
        participant(1, 'territory_changed', ['AQES'], null, null),
        participant(2, 'suppressed', ['ES'], 3, null),
        participant(4, 'suppressed', ['ES'], 5, null),
      ],
      links: [
        { level: 'municipality', from: 2, to: 1, kind: 'merged_into' },
        { level: 'municipality', from: 4, to: 1, kind: 'merged_into' },
      ],
    },
    {
      id: 2,
      date: '1950-01-01',
      istatActId: 2,
      origin: 'istat',
      description: 'Cambio di denominazione',
      participants: [participant(1, 'changed', ['RN'], 1, 2)],
      links: [],
    },
  ];

  const derive = <L extends 'region' | 'province' | 'municipality'>(level: L, list: readonly Entity<L>[]) =>
    deriveFields({ level, entities: list, variations, anomalies: new AnomalyCollector() });
  const entities: InvariantEntities = {
    region: derive('region', [regionEntity]),
    province: derive('province', provinceEntities),
    municipality: derive('municipality', municipalities),
  };

  const existence = Object.fromEntries(
    (['region', 'province', 'municipality'] as const).map((level) => [
      level,
      new Map(
        (entities[level] as readonly Entity[]).map((e) => [
          e.id,
          e.versions.map((v) => ({ validFrom: v.validFrom, validTo: v.validTo })),
        ]),
      ),
    ]),
  ) as unknown as NonNullable<InvariantWorld['existence']>;

  const world: Baseline = {
    start: START,
    today: TODAY,
    entities,
    variations,
    existence,
    historicalCodes: historicalCodesOf(provinceEntities),
    snapshots: [],
    overrides: [],
    counts: { region: 1, province: 2, municipality: 2 },
    accounts: [
      {
        source: 'events:pfun-100',
        index: 0,
        level: 'municipality',
        event: 'ES',
        date: '1900-01-01',
        variation: 'act:1:1900-01-01',
        dropped: null,
      },
      {
        source: 'events:pfun-100',
        index: 1,
        level: 'municipality',
        event: 'AQES',
        date: '1900-01-01',
        variation: 'act:1:1900-01-01',
        dropped: null,
      },
      {
        source: 'events:pfun-104',
        index: 0,
        level: 'municipality',
        event: 'RN',
        date: '1950-01-01',
        variation: 'act:2:1950-01-01',
        dropped: null,
      },
      {
        source: 'events:pfun-100',
        index: 2,
        level: 'municipality',
        event: 'PV',
        date: START,
        variation: null,
        dropped: 'first-validity',
      },
    ],
    variationIdOf: (key) => ({ 'act:1:1900-01-01': 1, 'act:2:1950-01-01': 2 })[key],
    provinceEntities,
  };
  world.snapshots = SNAPSHOT_DATES.map((date) => snapshotSet(world.entities, date));
  return world;
}

/** The rows the snapshots of `date` would hold if SITUAS agreed with the entities. */
export function snapshotSet(entities: InvariantEntities, date: IsoDate): SnapshotSet {
  const valid = <V extends HalfOpenInterval>(list: readonly { id: number; versions: readonly V[] }[]) =>
    list.flatMap((entity) =>
      entity.versions.filter((v) => containsDate(v, date)).map((version) => ({ entity, version })),
    );
  const regionCode = (id: number | null): string =>
    valid(entities.region).find((r) => r.entity.id === id)?.version.istatCode ?? '??';
  const provinces = valid(entities.province);
  const province = (id: number | null) => provinces.find((p) => p.entity.id === id);
  const modern = date >= '1948-01-01';
  return {
    date,
    rows: {
      region: valid(entities.region).map(({ version: v }) => ({
        code: v.istatCode,
        name: v.officialName,
        type: v.type,
      })),
      province: provinces.map(({ entity, version: v }) => ({
        code: v.istatCode,
        name: v.officialName,
        regionCode: regionCode(v.regionId),
        type: v.type,
        abbreviation: modern ? v.abbreviation : null,
        historicalCode: (entity as ProvinceEntity).historicalCodes[0]?.value ?? v.istatCode,
      })),
      municipality: valid(entities.municipality).map(({ version: v }) => ({
        code: v.istatCode,
        officialName: v.officialName,
        italianName: v.italianName,
        foreignName: v.foreignName,
        cadastralCode: v.cadastralCode,
        utsCode: province(v.provinceId)?.version.istatCode ?? '??',
        regionCode: regionCode(v.regionId),
        utsAbbreviation: province(v.provinceId)?.version.abbreviation ?? null,
        historicalUtsCode: province(v.provinceId)?.version.istatCode ?? '??',
      })),
    },
  };
}

/** The type with every `readonly` removed, deeply, so that tests can craft violations. */
export type DeepWritable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? DeepWritable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepWritable<T[K]> }
      : T;

export function mut<T>(value: T): DeepWritable<T> {
  return value as DeepWritable<T>;
}

/** The (writable) entity with `id` of `level`. */
export function entityOf<L extends Level>(world: Baseline, level: L, id: number): DeepWritable<InvariantEntity<L>> {
  const found = (world.entities[level] as readonly InvariantEntity<L>[]).find((e) => e.id === id);
  if (found === undefined) throw new Error(`no ${level} entity ${id}`);
  return mut(found);
}

/** The (writable) version `versionId` of an entity. */
export function versionOf<L extends Level>(
  world: Baseline,
  level: L,
  entityId: number,
  versionId: number,
): DeepWritable<InvariantEntity<L>['versions'][number]> {
  const found = entityOf(world, level, entityId).versions.find((v) => v.id === versionId);
  if (found === undefined) throw new Error(`no ${level} version ${versionId}`);
  return found;
}

/** The (writable) variation `id`. */
export function variationOf(world: Baseline, id: number): DeepWritable<Variation> {
  const found = world.variations.find((v) => v.id === id);
  if (found === undefined) throw new Error(`no variation ${id}`);
  return mut(found);
}

/** The element at `index` of a list the test knows to have it. */
export function at<T>(list: readonly T[] | undefined, index = 0): T {
  const found = list?.[index];
  if (found === undefined) throw new Error(`no element at ${index}`);
  return found;
}

/** The (writable) rows of `level` in a snapshot set. */
export function rowsOf<L extends Level>(set: SnapshotSet, level: L): DeepWritable<SnapshotRowByLevel[L]>[] {
  const rows = set.rows[level];
  if (rows === undefined) throw new Error(`no ${level} rows on ${set.date}`);
  return mut(rows);
}
