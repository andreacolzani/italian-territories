/**
 * The world the invariants (§8.1) are checked on: the entities of the three levels with their
 * derived fields (§7), after overrides (§6.10), and the variations, all in the internal model
 * (half-open intervals, `role: null` participations still present).
 *
 * Every check receives only the parts it reads. What some checks additionally need and not every
 * caller has (the existence of an entity in the snapshots, the unpublished historical UTS codes,
 * the stored snapshots, the SITUAS counts, the event accounts) is optional here: an invariant whose
 * data is missing is reported as `skipped` by `checkInvariants`, never as passed.
 */
import type { EventAccount } from '../build/index.ts';
import type { HalfOpenInterval, IsoDate } from '../dates/index.ts';
import type { EntityId, Level } from '../model/common.ts';
import type { Dated, DerivedFields, Entity, Variation } from '../model/internal.ts';
import type { AppliedOverride } from '../overrides/index.ts';
import type { SnapshotSet } from './i12-reconstruction.ts';

export type InvariantEntity<L extends Level> = Entity<L> & DerivedFields;

/** The entities of every level; levels without entities are empty lists. */
export interface InvariantEntities {
  region: readonly InvariantEntity<'region'>[];
  province: readonly InvariantEntity<'province'>[];
  municipality: readonly InvariantEntity<'municipality'>[];
}

/** The unpublished `COD_PROV_STORICO` timeline of each UTS entity id (§5.5). */
export type HistoricalCodes = ReadonlyMap<EntityId, readonly Dated<string>[]>;

/** The periods in which each entity id exists in the snapshots, per level (the identity stage). */
export type Existence = Record<Level, ReadonlyMap<EntityId, readonly HalfOpenInterval[]>>;

export interface InvariantWorld {
  /** First calendar date: the versions starting on it open no variation (`PV`, I9). */
  start: IsoDate;
  /** The date of the reconstructed state compared with the SITUAS counts (I13). */
  today: IsoDate;
  entities: InvariantEntities;
  variations: readonly Variation[];
  /** I2. */
  existence?: Existence;
  /** I7 and I12. */
  historicalCodes?: HistoricalCodes;
  /** Test only (I7): UTS codes a partial test world does not contain. Production leaves it unset. */
  extraUtsCodes?: ReadonlySet<string>;
  /** I12: the stored snapshots, or the audit samples. */
  snapshots?: Iterable<SnapshotSet> | AsyncIterable<SnapshotSet>;
  /** I12: the values the overrides replaced. */
  overrides?: readonly AppliedOverride[];
  /** I13: the SITUAS count endpoints of `today`. */
  counts?: Record<Level, number>;
  /** I14: what became of every event row, and the registry id of a variation natural key. */
  accounts?: readonly EventAccount[];
  variationIdOf?: (key: string) => number | undefined;
}

/** The `COD_PROV_STORICO` timeline of every UTS entity of `provinces`. */
export function historicalCodesOf(
  provinces: readonly { id: EntityId; historicalCodes: readonly Dated<string>[] }[],
): HistoricalCodes {
  return new Map(provinces.map((p) => [p.id, p.historicalCodes]));
}

/** The existence intervals of identified entities (the `intervals` of Step 9). */
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
