/**
 * §5.1, D4: only the `id → id_origine` pointers, never names, codes or public data. A UTS type change
 * creates a new `id_uts` pointing to the record it continues, while `RN` keeps it (§3.5 item 14).
 * Regions and municipalities expose only self-pointers; the same algorithm runs for uniformity.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, type IsoDate } from '../dates/index.ts';
import type { Level, RegionType, UtsType } from '../model/common.ts';

export interface IdentityRecord {
  id: number;
  code: string;
  name: string;
  type: RegionType | UtsType | null;
}

export interface IdentityPointer {
  id: number;
  originId: number;
}

export interface IdentitySource<E> {
  /** `originId` is null for r3, which carries none. */
  listed: { code: string; name: string; type: RegionType | UtsType | null; originId: number | null };
  events: readonly E[];
}

export interface IdentityGraphOptions<E> {
  level: Level;
  sources: readonly IdentitySource<E>[];
  pointer: (event: E) => IdentityPointer;
  /** At the time of the event. */
  record: (event: E) => IdentityRecord;
  date: (event: E) => IsoDate;
  /** Rows returned by several records of the entity are merged by it. */
  eventKey: (event: E) => string;
  anomalies: AnomalyCollector;
}

export interface IdentityComponent<E> {
  level: Level;
  root: number;
  ids: number[];
  records: IdentityRecord[];
  events: E[];
}

export interface IdentityGraph<E> {
  level: Level;
  components: IdentityComponent<E>[];
  byId: ReadonlyMap<number, IdentityComponent<E>>;
}

export const IDENTITY_ANOMALIES = {
  ambiguousRoot: 'identity-root-ambiguous',
  inconsistentRecord: 'identity-record-inconsistent',
} as const;

export function buildIdentityGraph<E>(options: IdentityGraphOptions<E>): IdentityGraph<E> {
  const { level, pointer, anomalies } = options;
  const uf = new UnionFind();
  const outgoing = new Map<number, Set<number>>();
  const firstDate = new Map<number, IsoDate>();
  const events = new Map<string, E>();

  for (const source of options.sources) {
    if (source.listed.originId !== null && source.events.length === 0) uf.add(source.listed.originId);
    for (const event of source.events) {
      const { id, originId } = pointer(event);
      uf.union(id, originId);
      if (id !== originId) {
        const targets = outgoing.get(id) ?? new Set<number>();
        targets.add(originId);
        outgoing.set(id, targets);
      }
      const date = options.date(event);
      const first = firstDate.get(id);
      if (first === undefined || compareDates(date, first) < 0) firstDate.set(id, date);
      const key = options.eventKey(event);
      if (!events.has(key)) events.set(key, event);
    }
  }

  const groups = new Map<number, { ids: number[]; records: Map<string, IdentityRecord>; events: E[] }>();
  const groupOf = (id: number): { ids: number[]; records: Map<string, IdentityRecord>; events: E[] } => {
    const representative = uf.find(id);
    let group = groups.get(representative);
    if (group === undefined) {
      group = { ids: [], records: new Map(), events: [] };
      groups.set(representative, group);
    }
    return group;
  };
  for (const id of uf.nodes()) groupOf(id).ids.push(id);
  for (const event of events.values()) {
    const group = groupOf(pointer(event).id);
    group.events.push(event);
    addRecord(group.records, options.record(event));
  }

  for (const source of options.sources) {
    const { listed } = source;
    const nodes = new Set(source.events.map((e) => uf.find(pointer(e).id)));
    if (listed.originId !== null) nodes.add(uf.find(listed.originId));
    if (nodes.size > 1) {
      anomalies.add({
        level: 'blocking',
        code: IDENTITY_ANOMALIES.inconsistentRecord,
        message: `${level} record ${listed.code} ${listed.name}: its origin id and events belong to different entities`,
        context: { level, record: listed, ids: [...new Set(source.events.map((e) => pointer(e).id))].sort(byNumber) },
      });
    }
    const ids = [...new Set(source.events.map((e) => pointer(e).id))];
    const id = ids.length === 1 ? ids[0] : source.events.length === 0 ? listed.originId : null;
    if (id !== null && id !== undefined) {
      addRecord(groupOf(id).records, { id, code: listed.code, name: listed.name, type: listed.type });
    }
  }

  const components = [...groups.values()].map((group): IdentityComponent<E> => {
    const ids = group.ids.sort(byNumber);
    return {
      level,
      root: chooseRoot(level, ids, outgoing, firstDate, anomalies),
      ids,
      records: [...group.records.values()].sort(compareRecords),
      events: group.events
        .map((event) => ({ event, key: options.eventKey(event) }))
        .sort((a, b) => compareDates(options.date(a.event), options.date(b.event)) || compareStrings(a.key, b.key))
        .map((e) => e.event),
    };
  });
  components.sort((a, b) => a.root - b.root);
  const byId = new Map<number, IdentityComponent<E>>();
  for (const component of components) for (const id of component.ids) byId.set(id, component);
  return { level, components, byId };
}

function chooseRoot(
  level: Level,
  ids: readonly number[],
  outgoing: ReadonlyMap<number, ReadonlySet<number>>,
  firstDate: ReadonlyMap<number, IsoDate>,
  anomalies: AnomalyCollector,
): number {
  const chainEnds = ids.filter((id) => outgoing.get(id) === undefined);
  const dated = ids.flatMap((id) => {
    const date = firstDate.get(id);
    return date === undefined ? [] : [{ id, date }];
  });
  const earliest = dated.reduce<IsoDate | undefined>(
    (min, { date }) => (min === undefined || compareDates(date, min) < 0 ? date : min),
    undefined,
  );
  const oldest = dated.filter(({ date }) => date === earliest).map(({ id }) => id);

  const [end] = chainEnds;
  if (chainEnds.length === 1 && end !== undefined && (oldest.length === 0 || oldest.includes(end))) return end;
  const fallback = oldest[0] ?? chainEnds[0] ?? Math.min(...ids);
  anomalies.add({
    level: 'blocking',
    code: IDENTITY_ANOMALIES.ambiguousRoot,
    message:
      chainEnds.length === 1
        ? `${level} entity ${ids.join(', ')}: the end of the origin chain (${end}) is not its oldest record (${oldest.join(', ')})`
        : `${level} entity ${ids.join(', ')}: ${chainEnds.length} ends of the origin chain`,
    context: { level, ids, chain_ends: chainEnds, oldest, root: fallback },
  });
  return fallback;
}

function addRecord(records: Map<string, IdentityRecord>, record: IdentityRecord): void {
  const key = JSON.stringify([record.id, record.code, record.name, record.type]);
  if (!records.has(key)) records.set(key, record);
}

function compareRecords(a: IdentityRecord, b: IdentityRecord): number {
  return (
    a.id - b.id ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.name, b.name) ||
    compareStrings(a.type ?? '', b.type ?? '')
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byNumber(a: number, b: number): number {
  return a - b;
}

class UnionFind {
  readonly #parent = new Map<number, number>();

  add(id: number): void {
    if (!this.#parent.has(id)) this.#parent.set(id, id);
  }

  find(id: number): number {
    this.add(id);
    let root = id;
    for (let p = this.#parentOf(root); p !== root; p = this.#parentOf(root)) root = p;
    for (let node = id; node !== root;) {
      const next = this.#parentOf(node);
      this.#parent.set(node, root);
      node = next;
    }
    return root;
  }

  #parentOf(id: number): number {
    return this.#parent.get(id) ?? id;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    // The smaller id represents the set: representatives do not depend on insertion order.
    if (ra !== rb) {
      if (ra < rb) this.#parent.set(rb, ra);
      else this.#parent.set(ra, rb);
    }
  }

  nodes(): number[] {
    return [...this.#parent.keys()];
  }
}
