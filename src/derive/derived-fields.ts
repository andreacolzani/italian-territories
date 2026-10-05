/**
 * Derived fields (§7): `status`, `predecessors`, `successors`, `current_successors` and
 * `is_former_italian`, computed per level after the overrides from the registered versions and
 * variations.
 *
 * - Links are taken by date, from every variation of that date (whatever act references the
 *   boundary), joined without repetitions and sorted by entity id, kind and variation id:
 *   `predecessors` are the links of the level whose `to` is the entity, from the variations dated on
 *   the `validFrom` of its **first** version; `successors` the links whose `from` is the entity, from
 *   the variations dated on the `validTo` of its **last** version, only for suppressed entities
 *   (intermediate closures are ignored).
 * - The role closing the last version is that of the entity's participants whose `versionBeforeId`
 *   is that version; participants without effect (`role: null`) are ignored.
 * - `current_successors`: closure over `successors` following `merged_into` and `detached_into`
 *   until active entities; visited entities are not followed again.
 * - `is_former_italian`: a suppressed entity whose last version was closed with role `ceded` is
 *   former Italian and a terminal point even when it has links (D33); any other suppressed entity is
 *   former Italian iff it has successors and all of them are. A path ending in an active entity or
 *   in a suppressed entity without successors is not former Italian.
 * - A cycle among the final closures (the `merged_into`/`detached_into` successors of suppressed
 *   entities) is a `blocking` anomaly (`successor-cycle`), one per strongly connected component,
 *   with the entities involved; their derived fields are still computed (the build is blocked).
 *
 * The consistency of the result is invariant I11 (Step 15).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import type { IsoDate } from '../dates/index.ts';
import type { Level, LinkKind } from '../model/common.ts';
import type { DerivedFields, EntityByLevel, EntityLink, Variation } from '../model/internal.ts';

/** Stable anomaly codes of the derived fields (§8.2). */
export const DERIVED_ANOMALIES = {
  /** The successors of suppressed entities form a cycle. */
  successorCycle: 'successor-cycle',
} as const;

/** Link kinds followed by `current_successors` and `is_former_italian` (§7). */
const SUCCESSION_KINDS: readonly LinkKind[] = ['merged_into', 'detached_into'];

export type DerivedEntity<E> = E & DerivedFields;

export function deriveFields<L extends Level, E extends EntityByLevel[L]>(options: {
  level: L;
  entities: readonly E[];
  variations: readonly Variation[];
  anomalies: AnomalyCollector;
}): DerivedEntity<E>[] {
  const { level, entities, variations, anomalies } = options;
  const byDate = new Map<IsoDate, Variation[]>();
  const cededVersions = new Set<number>();
  for (const variation of variations) {
    push(byDate, variation.date, variation);
    for (const p of variation.participants) {
      if (p.level === level && p.role === 'ceded' && p.versionBeforeId !== null) cededVersions.add(p.versionBeforeId);
    }
  }

  const active = new Set(entities.filter((e) => e.versions.at(-1)?.validTo === null).map((e) => e.id));
  const predecessors = new Map<number, EntityLink[]>();
  const successors = new Map<number, EntityLink[]>();
  const ceded = new Set<number>();
  for (const entity of entities) {
    const first = entity.versions[0];
    const last = entity.versions.at(-1);
    const opened = first === undefined ? [] : (byDate.get(first.validFrom) ?? []);
    predecessors.set(
      entity.id,
      entityLinks(opened, level, (l) => (l.to === entity.id ? l.from : null)),
    );
    if (last?.validTo == null) {
      successors.set(entity.id, []);
      continue;
    }
    if (cededVersions.has(last.id)) ceded.add(entity.id);
    successors.set(
      entity.id,
      entityLinks(byDate.get(last.validTo) ?? [], level, (l) => (l.from === entity.id ? l.to : null)),
    );
  }

  const next = (id: number): number[] => [
    ...new Set((successors.get(id) ?? []).filter((l) => SUCCESSION_KINDS.includes(l.kind)).map((l) => l.id)),
  ];

  for (const cycle of cycles(
    entities.map((e) => e.id),
    next,
  )) {
    anomalies.add({
      level: 'blocking',
      code: DERIVED_ANOMALIES.successorCycle,
      message: `${level} entities ${cycle.join(', ')}: their successors form a cycle`,
      context: {
        level,
        entityIds: cycle,
        links: cycle.flatMap((id) => (successors.get(id) ?? []).map((l) => ({ from: id, ...l }))),
      },
    });
  }

  const currentSuccessors = (id: number): number[] => {
    if (active.has(id)) return [];
    const found = new Set<number>();
    const visited = new Set<number>([id]);
    const queue = next(id);
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      if (visited.has(target)) continue;
      visited.add(target);
      if (active.has(target)) found.add(target);
      else queue.push(...next(target));
    }
    return [...found].sort((a, b) => a - b);
  };

  // Memoised. Entities on a cycle (already reported) get `false`, which is then sound to keep.
  const formerItalian = new Map<number, boolean>();
  const inProgress = new Set<number>();
  const isFormerItalian = (id: number): boolean => {
    const known = formerItalian.get(id);
    if (known !== undefined) return known;
    if (inProgress.has(id)) return false;
    let result: boolean;
    if (active.has(id)) result = false;
    else if (ceded.has(id)) result = true;
    else {
      const targets = next(id);
      inProgress.add(id);
      result = targets.length > 0 && targets.every(isFormerItalian);
      inProgress.delete(id);
    }
    formerItalian.set(id, result);
    return result;
  };

  return entities.map((entity) => ({
    ...entity,
    status: active.has(entity.id) ? 'active' : 'suppressed',
    isFormerItalian: isFormerItalian(entity.id),
    predecessors: predecessors.get(entity.id) ?? [],
    successors: successors.get(entity.id) ?? [],
    currentSuccessors: currentSuccessors(entity.id),
  }));
}

/**
 * The cycles of the graph `next` over `ids` (Tarjan): every strongly connected component with more
 * than one entity, or a single entity that is its own successor. Ids ascending, components sorted by
 * their first id.
 */
function cycles(ids: readonly number[], next: (id: number) => number[]): number[][] {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const found: number[][] = [];
  let counter = 0;

  const visit = (id: number): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of next(id)) {
      if (!index.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(target) ?? 0));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const component: number[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    if (component.length > 1 || next(id).includes(id)) found.push(component.sort((a, b) => a - b));
  };

  for (const id of ids) if (!index.has(id)) visit(id);
  return found.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

/**
 * The links of `level` in `variations` selected by `other` (the linked entity, or null to skip),
 * without repetitions, sorted by entity id, kind and variation id.
 */
function entityLinks(
  variations: readonly Variation[],
  level: Level,
  other: (link: Variation['links'][number]) => number | null,
): EntityLink[] {
  const links = new Map<string, EntityLink>();
  for (const variation of variations) {
    for (const link of variation.links) {
      const id = link.level === level ? other(link) : null;
      if (id === null) continue;
      links.set(`${id}|${link.kind}|${variation.id}`, {
        id,
        kind: link.kind,
        date: variation.date,
        variationId: variation.id,
      });
    }
  }
  return [...links.values()].sort(
    (a, b) => a.id - b.id || compareCodeUnits(a.kind, b.kind) || a.variationId - b.variationId,
  );
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
