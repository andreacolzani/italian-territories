/**
 * `changes.json` (§9): the diff between the previous release and the current data, by id, for the
 * entities and versions of every level and for the variations.
 *
 * Retroactivity is decided by the **days** whose published state changes (Step 16): an item is
 * retroactive iff it changes a day before the previous release's `data_version`. `affected_from`
 * (updated and removed items) is the first such day:
 *
 * - version: another field changed, or `valid_from` → the earlier `valid_from`; only `valid_until`
 *   → the day after the earlier of the two ends (null = open), so closing an open version at `U`
 *   affects `U + 1` onwards and is additive when `U + 1` is not before the reference (§10.2);
 *   removed → its `valid_from`; added → retroactive iff its `valid_from` is before the reference;
 * - variation: the earlier of the two dates; removed or added → its date;
 * - entity (entity-level fields only; its versions are items of their own): links → the earliest
 *   date among the links added or removed; `status` → the day after the last version's end, old or
 *   new; `istat_origin_id`, `is_former_italian` and `current_successors` carry no date (they follow
 *   from dated items, flagged on their own; origin-id remaps are not retroactive, §5.3), so with
 *   only those `affected_from` is null and the item is not retroactive; removed → its first
 *   `valid_from`; added → retroactive iff its first `valid_from` is before the reference.
 *
 * Without a previous release everything is added and nothing is retroactive.
 */
import { assertIsoDate, compareDates, type IsoDate, minDate, nextDay } from '../dates/index.ts';
import { canonicalJson } from '../http/index.ts';
import type {
  ChangeSet,
  Changes,
  EntityLink,
  Meta,
  Municipality,
  Province,
  Region,
  UpdatedItem,
  Variation,
} from '../model/public.ts';
import type { PublicData } from './public.ts';

export interface Release {
  data_version: string;
  generated_at: string;
}

/** The previous release, as far as the diff needs it. */
export interface PreviousRelease extends PublicData {
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

export function computeChanges(previous: PreviousRelease | null, current: PublicData, to: Release): Changes {
  const reference = previous === null ? null : dataVersionDate(previous.meta.data_version);
  const before = (date: IsoDate | null) => reference !== null && date !== null && compareDates(date, reference) < 0;
  const level = <E extends Region | Province | Municipality>(prev: readonly E[], next: readonly E[]) => ({
    entities: diff(prev, next, entityDiff, firstValidFrom, before),
    versions: diff(
      prev.flatMap((e) => e.versions as readonly Version[]),
      next.flatMap((e) => e.versions as readonly Version[]),
      versionDiff,
      (v) => v.valid_from,
      before,
    ),
  });

  const changes = {
    from:
      previous === null ? null : { data_version: previous.meta.data_version, generated_at: previous.meta.generated_at },
    to: { data_version: to.data_version, generated_at: to.generated_at },
    retroactive: false,
    regions: level(previous?.regions ?? [], current.regions),
    provinces: level(previous?.provinces ?? [], current.provinces),
    municipalities: level(previous?.municipalities ?? [], current.municipalities),
    variations: diff(previous?.variations ?? [], current.variations, variationDiff, (v) => v.date, before),
  };
  const sets: ChangeSet[] = [
    ...[changes.regions, changes.provinces, changes.municipalities].flatMap((l) => [l.entities, l.versions]),
    changes.variations,
  ];
  changes.retroactive = sets.some((s) => [...s.added, ...s.updated, ...s.removed].some((i) => i.retroactive));
  return changes;
}

// ---------------------------------------------------------------------------------------------

type Version = Region['versions'][number] | Province['versions'][number] | Municipality['versions'][number];

/** Changed fields of an item and the first day they affect (null: no dated change). */
interface ItemDiff {
  fields: string[];
  affectedFrom: IsoDate | null;
}

function diff<T extends { id: number }>(
  previous: readonly T[],
  current: readonly T[],
  compare: (a: T, b: T) => ItemDiff | null,
  firstDay: (item: T) => IsoDate,
  before: (date: IsoDate | null) => boolean,
): ChangeSet {
  const old = new Map(previous.map((item) => [item.id, item]));
  const now = new Map(current.map((item) => [item.id, item]));
  const set: ChangeSet = { added: [], updated: [], removed: [] };
  for (const item of current) {
    const was = old.get(item.id);
    if (was === undefined) {
      set.added.push({ id: item.id, retroactive: before(firstDay(item)) });
      continue;
    }
    const changed = compare(was, item);
    if (changed === null) continue;
    const updated: UpdatedItem = {
      id: item.id,
      fields: changed.fields,
      affected_from: changed.affectedFrom,
      retroactive: before(changed.affectedFrom),
    };
    set.updated.push(updated);
  }
  for (const item of previous) {
    if (now.has(item.id)) continue;
    const affected = firstDay(item);
    set.removed.push({ id: item.id, affected_from: affected, retroactive: before(affected) });
  }
  for (const list of [set.added, set.updated, set.removed]) list.sort((a, b) => a.id - b.id);
  return set;
}

/** Keys of `a` and `b` (in `b`'s order, then `a`'s) whose values differ, except `skip`. */
function changedFields(a: object, b: object, skip: readonly string[]): string[] {
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !skip.includes(k));
  const valueOf = (o: object, k: string) => canonicalJson((o as Record<string, unknown>)[k]);
  return keys.filter((k) => valueOf(a, k) !== valueOf(b, k));
}

function versionDiff(a: Version, b: Version): ItemDiff | null {
  const fields = changedFields(a, b, ['id']);
  if (fields.length === 0) return null;
  if (fields.some((f) => f !== 'valid_until')) return { fields, affectedFrom: minDate(a.valid_from, b.valid_from) };
  const ends = [a.valid_until, b.valid_until].filter((d) => d !== null);
  const [first, ...rest] = ends;
  return { fields, affectedFrom: first === undefined ? null : nextDay(minDate(first, ...rest)) };
}

function variationDiff(a: Variation, b: Variation): ItemDiff | null {
  const fields = changedFields(a, b, ['id']);
  return fields.length === 0 ? null : { fields, affectedFrom: minDate(a.date, b.date) };
}

function entityDiff(a: Region | Province | Municipality, b: Region | Province | Municipality): ItemDiff | null {
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

function firstValidFrom(entity: Region | Province | Municipality): IsoDate {
  const first = entity.versions[0];
  if (first === undefined) throw new RangeError(`entity ${entity.id} has no versions`);
  return first.valid_from;
}
