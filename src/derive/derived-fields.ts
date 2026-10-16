/**
 * §7. Links are taken by date from every variation of that date, whatever act references the
 * boundary; `transferred_to` is never on a first or last version. Closing with `ceded` is terminal
 * even when the entity has links (D33). On a successor cycle the fields are still computed: the
 * build is blocked anyway.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import type { IsoDate } from '../dates/index.ts';
import type { EntityId, Level, PublicLinkKind } from '../model/common.ts';
import type { DerivedFields, Entity, EntityLink, Variation } from '../model/internal.ts';

const DERIVED_ANOMALIES = {
  successorCycle: 'successor-cycle',
} as const;

const SUCCESSION_KINDS: readonly PublicLinkKind[] = ['merged_into', 'split_into', 'detached_into'];

export type DerivedEntity<E> = E & DerivedFields;

export function deriveFields<L extends Level, E extends Entity<L>>(options: {
  level: L;
  entities: readonly E[];
  variations: readonly Variation[];
  anomalies: AnomalyCollector;
}): DerivedEntity<E>[] {
  const { level, entities, variations, anomalies } = options;
  const byDate = new Map<IsoDate, Variation[]>();
  const cededVersions = new Set<string>();
  for (const variation of variations) {
    push(byDate, variation.date, variation);
    for (const p of variation.participants) {
      if (p.level === level && p.role === 'ceded' && p.versionBefore !== null) {
        cededVersions.add(versionRef(p.entityId, p.versionBefore));
      }
    }
  }
  const splits = splitOrigins(variations, level);

  const active = new Set(entities.filter((e) => e.versions.at(-1)?.validTo === null).map((e) => e.id));
  const predecessors = new Map<EntityId, EntityLink[]>();
  const successors = new Map<EntityId, EntityLink[]>();
  const ceded = new Set<EntityId>();
  for (const entity of entities) {
    const first = entity.versions[0];
    const last = entity.versions.at(-1);
    const opened = first === undefined ? [] : (byDate.get(first.validFrom) ?? []);
    predecessors.set(
      entity.id,
      entityLinks(opened, level, splits, (l) => (l.to === entity.id ? l.from : null)),
    );
    if (last?.validTo == null) {
      successors.set(entity.id, []);
      continue;
    }
    if (cededVersions.has(versionRef(entity.id, last.validFrom))) ceded.add(entity.id);
    successors.set(
      entity.id,
      entityLinks(byDate.get(last.validTo) ?? [], level, splits, (l) => (l.from === entity.id ? l.to : null)),
    );
  }

  const next = (id: EntityId): EntityId[] => [
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

  const currentSuccessors = (id: EntityId): EntityId[] => {
    if (active.has(id)) return [];
    const found = new Set<EntityId>();
    const visited = new Set<EntityId>([id]);
    const queue = next(id);
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      if (visited.has(target)) continue;
      visited.add(target);
      if (active.has(target)) found.add(target);
      else queue.push(...next(target));
    }
    return [...found].sort(compareCodeUnits);
  };

  // Memoised. Entities on a cycle (already reported) get `false`, which is then sound to keep.
  const formerItalian = new Map<EntityId, boolean>();
  const inProgress = new Set<EntityId>();
  const isFormerItalian = (id: EntityId): boolean => {
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
    currentSuccessors: level === 'municipality' ? currentSuccessors(entity.id) : null,
  }));
}

function versionRef(entityId: EntityId, validFrom: IsoDate): string {
  return `${entityId}|${validFrom}`;
}

/** D44: over every variation of the date, not only the act's. */
function splitOrigins(variations: readonly Variation[], level: Level): Set<string> {
  const destinations = new Map<string, Set<EntityId>>();
  for (const variation of variations) {
    for (const link of variation.links) {
      if (link.level !== level || link.kind !== 'merged_into') continue;
      const key = `${variation.date}|${link.from}`;
      const set = destinations.get(key) ?? new Set<EntityId>();
      set.add(link.to);
      destinations.set(key, set);
    }
  }
  return new Set([...destinations].filter(([, set]) => set.size > 1).map(([key]) => key));
}

/** Tarjan's strongly connected components. */
function cycles(ids: readonly EntityId[], next: (id: EntityId) => EntityId[]): EntityId[][] {
  const index = new Map<EntityId, number>();
  const low = new Map<EntityId, number>();
  const stack: EntityId[] = [];
  const onStack = new Set<EntityId>();
  const found: EntityId[][] = [];
  let counter = 0;

  const visit = (id: EntityId): void => {
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
    const component: EntityId[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    if (component.length > 1 || next(id).includes(id)) found.push(component.sort(compareCodeUnits));
  };

  for (const id of ids) if (!index.has(id)) visit(id);
  return found.sort((a, b) => compareCodeUnits(a[0] ?? '', b[0] ?? ''));
}

function entityLinks(
  variations: readonly Variation[],
  level: Level,
  splits: ReadonlySet<string>,
  other: (link: Variation['links'][number]) => EntityId | null,
): EntityLink[] {
  const links = new Map<string, EntityLink>();
  for (const variation of variations) {
    for (const link of variation.links) {
      const id = link.level === level ? other(link) : null;
      if (id === null || link.kind === 'transferred_to') continue;
      const kind: PublicLinkKind =
        link.kind === 'merged_into' && splits.has(`${variation.date}|${link.from}`) ? 'split_into' : link.kind;
      links.set(`${id}|${kind}|${variation.date}`, { id, kind, date: variation.date });
    }
  }
  return [...links.values()].sort((a, b) => compareCodeUnits(a.id, b.id) || compareCodeUnits(a.kind, b.kind));
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
