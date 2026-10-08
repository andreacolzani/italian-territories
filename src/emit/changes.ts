/**
 * `reports/changes.json` (§9): the diff between the previous release and the current one: entities
 * by id and versions by `(entity id, valid_from)` (D40) for every level, variations by id.
 *
 * Retroactivity is decided by the **days** whose published state changes (Step 16): an item is
 * retroactive iff it changes a day before the previous release's `data_version`. `affected_from`
 * (updated and removed items) is the first such day:
 *
 * - version: a field other than `valid_until` changed → its `valid_from`; only `valid_until` →
 *   the day after the earlier of the two ends (null = open), so closing an open version at `U`
 *   affects `U + 1` onwards and is additive when `U + 1` is not before the reference (§10.2);
 *   removed → its `valid_from`; added → retroactive iff its `valid_from` is before the reference. A
 *   version whose start moves is removed and added;
 * - variation: the earlier of the two dates; removed or added → its date;
 * - entity (entity-level fields only; its versions are items of their own): links → the earliest
 *   date among the links added or removed; `status` → the day after the last version's end, old or
 *   new; `is_former_italian`, `partially_ceded` and `current_successors` carry no date (they follow
 *   from dated items, flagged on their own), so with only those `affected_from` is null and the
 *   item is not retroactive; removed → its first `valid_from`; added → retroactive iff its first
 *   `valid_from` is before the reference.
 *
 * Without a previous release everything is added and nothing is retroactive.
 */
import { assertIsoDate, compareDates, type IsoDate, minDate, nextDay } from '../dates/index.ts';
import { canonicalJson } from '../http/index.ts';
import type { EntityLink, Municipality, Province, Region } from '../model/public.ts';
import type { Changes, Meta, Variation } from '../model/reports.ts';
import type { PublicData } from './public.ts';

export interface Release {
  data_version: string;
  generated_at: string;
}

/** The data a release diff compares: the public files and the variation report. */
export interface ReleaseData extends PublicData {
  variations: Variation[];
}

/** The previous release, as far as the diff needs it. */
export interface PreviousRelease extends ReleaseData {
  meta: Pick<Meta, 'data_version' | 'generated_at'>;
}

/** `YYYY.MM.DD` → ISO date. */
export function dataVersionDate(dataVersion: string): IsoDate {
  return assertIsoDate(dataVersion.replaceAll('.', '-'));
}

/** ISO date → `YYYY.MM.DD`. */
export function toDataVersion(date: IsoDate): string {
  return assertIsoDate(date).replaceAll('-', '.');
}

type Entity = Region | Province | Municipality;
type Version = Region['versions'][number] | Province['versions'][number] | Municipality['versions'][number];
type KeyedVersion = Version & { entity_id: string };

export function computeChanges(previous: PreviousRelease | null, current: ReleaseData, to: Release): Changes {
  const reference = previous === null ? null : dataVersionDate(previous.meta.data_version);
  const before = (date: IsoDate | null) => reference !== null && date !== null && compareDates(date, reference) < 0;
  const keyedVersions = (entities: readonly Entity[]): KeyedVersion[] =>
    entities.flatMap((e) => (e.versions as readonly Version[]).map((v) => ({ entity_id: e.id, ...v })));
  const level = <E extends Entity>(prev: readonly E[], next: readonly E[]) => ({
    entities: diff(prev, next, (e) => ({ id: e.id }), entityDiff, firstValidFrom, before),
    versions: diff(
      keyedVersions(prev),
      keyedVersions(next),
      (v) => ({ entity_id: v.entity_id, valid_from: v.valid_from }),
      versionDiff,
      (v) => v.valid_from,
      before,
    ),
  });

  const changes: Changes = {
    from:
      previous === null ? null : { data_version: previous.meta.data_version, generated_at: previous.meta.generated_at },
    to: { data_version: to.data_version, generated_at: to.generated_at },
    retroactive: false,
    regions: level(previous?.regions ?? [], current.regions),
    provinces: level(previous?.provinces ?? [], current.provinces),
    municipalities: level(previous?.municipalities ?? [], current.municipalities),
    variations: diff(
      previous?.variations ?? [],
      current.variations,
      (v) => ({ id: v.id }),
      variationDiff,
      (v) => v.date,
      before,
    ),
  };
  const sets = [
    ...[changes.regions, changes.provinces, changes.municipalities].flatMap((l) => [l.entities, l.versions]),
    changes.variations,
  ];
  changes.retroactive = sets.some((s) =>
    [...s.added, ...s.updated, ...s.removed].some((i: { retroactive: boolean }) => i.retroactive),
  );
  return changes;
}

// ---------------------------------------------------------------------------------------------

/** Changed fields of an item and the first day they affect (null: no dated change). */
interface ItemDiff {
  fields: string[];
  affectedFrom: IsoDate | null;
}

interface ChangeSetOf<K> {
  added: (K & { retroactive: boolean })[];
  updated: (K & { fields: string[]; affected_from: IsoDate | null; retroactive: boolean })[];
  removed: (K & { affected_from: IsoDate; retroactive: boolean })[];
}

function diff<T, K extends Record<string, string | number>>(
  previous: readonly T[],
  current: readonly T[],
  keyOf: (item: T) => K,
  compare: (a: T, b: T) => ItemDiff | null,
  firstDay: (item: T) => IsoDate,
  before: (date: IsoDate | null) => boolean,
): ChangeSetOf<K> {
  const text = (item: T) => canonicalJson(keyOf(item));
  const old = new Map(previous.map((item) => [text(item), item]));
  const now = new Map(current.map((item) => [text(item), item]));
  const set: ChangeSetOf<K> = { added: [], updated: [], removed: [] };
  for (const item of current) {
    const was = old.get(text(item));
    if (was === undefined) {
      set.added.push({ ...keyOf(item), retroactive: before(firstDay(item)) });
      continue;
    }
    const changed = compare(was, item);
    if (changed === null) continue;
    set.updated.push({
      ...keyOf(item),
      fields: changed.fields,
      affected_from: changed.affectedFrom,
      retroactive: before(changed.affectedFrom),
    });
  }
  for (const item of previous) {
    if (now.has(text(item))) continue;
    const affected = firstDay(item);
    set.removed.push({ ...keyOf(item), affected_from: affected, retroactive: before(affected) });
  }
  const order = (a: K, b: K): number => {
    for (const key of Object.keys(a)) {
      const [x, y] = [a[key], b[key]];
      if (x === y || x === undefined || y === undefined) continue;
      return x < y ? -1 : 1;
    }
    return 0;
  };
  for (const list of [set.added, set.updated, set.removed] as K[][]) list.sort(order);
  return set;
}

/** Keys of `a` and `b` (in `b`'s order, then `a`'s) whose values differ, except `skip`. */
function changedFields(a: object, b: object, skip: readonly string[]): string[] {
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !skip.includes(k));
  const valueOf = (o: object, k: string) => canonicalJson((o as Record<string, unknown>)[k]);
  return keys.filter((k) => valueOf(a, k) !== valueOf(b, k));
}

function versionDiff(a: KeyedVersion, b: KeyedVersion): ItemDiff | null {
  const fields = changedFields(a, b, ['entity_id', 'valid_from']);
  if (fields.length === 0) return null;
  if (fields.some((f) => f !== 'valid_until')) return { fields, affectedFrom: a.valid_from };
  const ends = [a.valid_until, b.valid_until].filter((d) => d !== null);
  const [first, ...rest] = ends;
  return { fields, affectedFrom: first === undefined ? null : nextDay(minDate(first, ...rest)) };
}

function variationDiff(a: Variation, b: Variation): ItemDiff | null {
  const fields = changedFields(a, b, ['id']);
  return fields.length === 0 ? null : { fields, affectedFrom: minDate(a.date, b.date) };
}

function entityDiff(a: Entity, b: Entity): ItemDiff | null {
  const fields = changedFields(a, b, ['id', 'versions']);
  if (fields.length === 0) return null;
  const days: IsoDate[] = [];
  for (const field of ['predecessors', 'successors'] as const) {
    if (fields.includes(field)) days.push(...linkDifference(a[field], b[field]).map((l) => l.date));
  }
  if (fields.includes('status')) {
    for (const end of [a.versions.at(-1)?.valid_until, b.versions.at(-1)?.valid_until]) {
      if (end != null) days.push(nextDay(end));
    }
  }
  const [first, ...rest] = days;
  return { fields, affectedFrom: first === undefined ? null : minDate(first, ...rest) };
}

function linkDifference(a: readonly EntityLink[], b: readonly EntityLink[]): EntityLink[] {
  const keys = (links: readonly EntityLink[]) => new Set(links.map((l) => canonicalJson(l)));
  const inA = keys(a);
  const inB = keys(b);
  return [...a.filter((l) => !inB.has(canonicalJson(l))), ...b.filter((l) => !inA.has(canonicalJson(l)))];
}

function firstValidFrom(entity: Entity): IsoDate {
  const first = entity.versions[0];
  if (first === undefined) throw new RangeError(`entity ${entity.id} has no versions`);
  return first.valid_from;
}
