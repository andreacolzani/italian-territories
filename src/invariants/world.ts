/** Internal model: half-open intervals, `role: null` participations still present. */
import type { EventAccount } from '../build/index.ts';
import type { HalfOpenInterval, IsoDate } from '../dates/index.ts';
import type { EntityId, Level } from '../model/common.ts';
import type { Dated, DerivedFields, Entity, Variation } from '../model/internal.ts';
import type { AppliedOverride } from '../overrides/index.ts';
import type { SnapshotSet } from './i12-reconstruction.ts';

export type InvariantEntity<L extends Level> = Entity<L> & DerivedFields;

export interface InvariantEntities {
  region: readonly InvariantEntity<'region'>[];
  province: readonly InvariantEntity<'province'>[];
  municipality: readonly InvariantEntity<'municipality'>[];
}

/** Unpublished (§5.5). */
export type HistoricalCodes = ReadonlyMap<EntityId, readonly Dated<string>[]>;

export type Existence = Record<Level, ReadonlyMap<EntityId, readonly HalfOpenInterval[]>>;

export interface InvariantWorld {
  /** The versions starting on it open no variation (`PV`, I9). */
  start: IsoDate;
  today: IsoDate;
  entities: InvariantEntities;
  variations: readonly Variation[];
  existence?: Existence;
  historicalCodes?: HistoricalCodes;
  /** Test only (I7). */
  extraUtsCodes?: ReadonlySet<string>;
  snapshots?: Iterable<SnapshotSet> | AsyncIterable<SnapshotSet>;
  overrides?: readonly AppliedOverride[];
  counts?: Record<Level, number>;
  accounts?: readonly EventAccount[];
  variationIdOf?: (key: string) => number | undefined;
}

export function historicalCodesOf(
  provinces: readonly { id: EntityId; historicalCodes: readonly Dated<string>[] }[],
): HistoricalCodes {
  return new Map(provinces.map((p) => [p.id, p.historicalCodes]));
}

export function existenceOf(
  identified: Record<Level, readonly { id: EntityId; intervals: readonly HalfOpenInterval[] }[]>,
): Existence {
  const of = (entities: readonly { id: EntityId; intervals: readonly HalfOpenInterval[] }[]) =>
    new Map(entities.map((e) => [e.id, e.intervals]));
  return {
    region: of(identified.region),
    province: of(identified.province),
    municipality: of(identified.municipality),
  };
}
