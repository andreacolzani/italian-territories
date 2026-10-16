/**
 * §4.3. Facts without act never join a variation with an act, but a fact whose links all exist in an
 * act's variation is accounted to it (D43). A territorial event claims a version boundary only when
 * no other event of the entity explains it. A fact without effect is dropped (the same-day `AP` of a
 * municipality suppressed that day, golden-6). Events after `today` enter the build on the day they
 * take effect (D49). Every event row is accounted for (I14).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { canonicalJson } from '../http/index.ts';
import { compareDates, containsDate, isAfter, previousDay, type IsoDate } from '../dates/index.ts';
import type { CrawledEvent } from '../enrich/index.ts';
import {
  keyOf,
  type AssignOptions,
  type Assignment,
  type LevelEventLists,
  type LevelIdentity,
  type Registry,
} from '../identity/index.ts';
import {
  LEVELS,
  PARTICIPANT_ROLE_RULES,
  participantRoleViolations,
  type EntityId,
  type IstatEventCode,
  type Level,
  type LinkKind,
  type ParticipantRole,
} from '../model/common.ts';
import type { EntityByLevel, Participant, Variation, VariationLink, VersionByLevel } from '../model/internal.ts';
import { ResolutionError, resolutionAnomaly, type Resolution, type ResolveQuery } from '../resolve/index.ts';
import type { EventRowByLevel } from '../sources/situas-public/index.ts';
import { equivalentEventCodes, eventRule, reportMissingRule, type EventRule } from './event-rules.ts';
import type { IdentifiedEntity } from './timeline.ts';

export interface InternalVariationEvent {
  root: number;
  event: IstatEventCode;
  date: IsoDate;
  /** At the time of the event. */
  code: string;
  actId: number;
  description: string | null;
  /** `null` for municipalities and failed details. */
  details: readonly { abroad: boolean; code: string | null }[] | null;
}

export interface VariationLevelInput<L extends Level> {
  entities: readonly EntityByLevel[L][];
  identified: readonly IdentifiedEntity<L>[];
  identity: Pick<LevelIdentity<L>, 'resolver' | 'transitions'>;
  eventLists: LevelEventLists<L>;
  /** `null` when the level was not crawled. */
  internal: readonly InternalVariationEvent[] | null;
}

export interface BuildVariationsOptions {
  levels: { [L in Level]?: VariationLevelInput<L> };
  /** First calendar date: versions starting on it open no variation (`PV`, I9). */
  start: IsoDate;
  today: IsoDate;
  inferredDates: ReadonlySet<IsoDate>;
  anomalies: AnomalyCollector;
}

export interface VariationDraft extends Omit<Variation, 'id'> {
  key: string;
}

export const DROP_REASONS = [
  'first-validity',
  'no-effect',
  'unresolved',
  'unknown-entity',
  'rule-missing',
  'future',
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export interface EventAccount {
  source: string;
  /** Position of the row in its public list, or in the internal events of its level. */
  index: number;
  level: Level;
  event: IstatEventCode;
  date: IsoDate;
  /** `null` when dropped. */
  variation: string | null;
  dropped: DropReason | null;
}

export interface VariationBuild {
  variations: VariationDraft[];
  accounts: EventAccount[];
}

const VARIATION_ANOMALIES = {
  unknownEntity: 'variation-entity-unknown',
  actAmbiguous: 'variation-act-ambiguous',
  withoutEffect: 'participation-without-effect',
  boundaryUnexplained: 'version-boundary-unexplained',
  participantInconsistent: 'variation-participant-inconsistent',
  /** Abbreviations are not ISTAT acts (Forlì-Cesena `FO` → `FC` on 1999-01-01, D34). */
  abbreviationChange: 'abbreviation-change-without-event',
  selfReference: 'self-reference-ignored',
  linkExplainedByAct: 'link-explained-by-act',
  eventCodeMismatch: 'event-code-mismatch',
  equivalenceAmbiguous: 'event-code-equivalence-ambiguous',
  futureEvent: 'future-event-ignored',
} as const;

const INTERNAL_SOURCES: Readonly<Record<Level, string>> = {
  region: 'r4:region-events',
  province: 'r5:uts-events',
  municipality: 'r6:municipality-events',
};

export function internalVariationEvents(
  crawl: {
    graph: {
      components: readonly {
        root: number;
        events: readonly CrawledEvent<
          { event: IstatEventCode; date: IsoDate; code: string; actId: number; description: string | null },
          { abroad: boolean; related: { code: string | null } | null }
        >[];
      }[];
    };
  } | null,
): InternalVariationEvent[] | null {
  if (crawl === null) return null;
  return crawl.graph.components.flatMap((component) =>
    component.events.map(({ event, details }) => ({
      root: component.root,
      event: event.event,
      date: event.date,
      code: event.code,
      actId: event.actId,
      description: event.description,
      details: details?.map((d) => ({ abroad: d.abroad, code: d.related?.code ?? null })) ?? null,
    })),
  );
}

type AnyVersion = VersionByLevel[Level];

interface Fact {
  level: Level;
  date: IsoDate;
  event: IstatEventCode;
  rule: EventRule;
  entityId: EntityId;
  actId: number | null;
  description: string | null;
  related: Set<EntityId>;
  /** They tell the acts of an ambiguous public row apart. */
  associatedCodes: Set<string>;
  abroad: boolean;
  rows: EventAccount[];
}

class LevelEntities {
  readonly level: Level;
  readonly #versions = new Map<EntityId, AnyVersion[]>();
  readonly #byInterval = new Map<string, EntityId>();
  readonly #byRoot = new Map<number, EntityId>();

  constructor(level: Level, input: VariationLevelInput<Level>) {
    this.level = level;
    for (const entity of input.entities) {
      this.#versions.set(
        entity.id,
        [...(entity.versions as AnyVersion[])].sort((a, b) => compareDates(a.validFrom, b.validFrom)),
      );
      if (entity.istatOriginId !== null) this.#byRoot.set(entity.istatOriginId, entity.id);
    }
    for (const entity of input.identified) for (const i of entity.intervals) this.#byInterval.set(keyOf(i), entity.id);
  }

  entities(): [EntityId, readonly AnyVersion[]][] {
    return [...this.#versions].sort(([a], [b]) => compareStrings(a, b));
  }

  ofInterval(key: string): EntityId | undefined {
    return this.#byInterval.get(key);
  }

  ofRoot(root: number): EntityId | undefined {
    return this.#byRoot.get(root);
  }

  ending(entityId: EntityId, date: IsoDate): AnyVersion | undefined {
    return this.#versions.get(entityId)?.find((v) => v.validTo === date);
  }

  starting(entityId: EntityId, date: IsoDate): AnyVersion | undefined {
    return this.#versions.get(entityId)?.find((v) => v.validFrom === date);
  }

  existsOn(entityId: EntityId, date: IsoDate): boolean {
    return this.#versions.get(entityId)?.some((v) => containsDate(v, date)) ?? false;
  }
}

export function buildVariations(options: BuildVariationsOptions): VariationBuild {
  const { anomalies } = options;
  const levels = new Map<Level, { input: VariationLevelInput<Level>; entities: LevelEntities }>();
  for (const level of LEVELS) {
    const input = options.levels[level] as VariationLevelInput<Level> | undefined;
    if (input !== undefined) levels.set(level, { input, entities: new LevelEntities(level, input) });
  }

  const accounts: EventAccount[] = [];
  const missingRules = new Map<string, { level: Level; event: IstatEventCode; count: number; source: string }>();
  const selfReferences: SelfReference[] = [];
  const mismatches = new Map<string, CodeMismatch>();
  const facts: Fact[] = [];
  for (const [level, { input, entities }] of levels) {
    facts.push(
      ...levelFacts(
        level,
        input,
        entities,
        options.today,
        accounts,
        missingRules,
        selfReferences,
        mismatches,
        anomalies,
      ),
    );
  }
  const future = accounts.filter((a) => a.dropped === 'future');
  if (future.length > 0) {
    const items = future.map(({ source, index, level, event, date }) => ({ source, index, level, event, date }));
    anomalies.add({
      level: 'info',
      code: VARIATION_ANOMALIES.futureEvent,
      message: `${future.length} events dated after ${options.today} ignored until they take effect`,
      context: { count: future.length, today: options.today, items },
    });
  }
  if (mismatches.size > 0) {
    const items = [...mismatches.values()];
    const count = items.reduce((sum, item) => sum + item.count, 0);
    anomalies.add({
      level: 'info',
      code: VARIATION_ANOMALIES.eventCodeMismatch,
      message: `${count} public rows matched to internal events with an equivalent event code (${items
        .map((i) => `${i.level} ${i.publicEvent} ↔ ${i.internalEvent}, act ${i.actId}: ${i.count}`)
        .join('; ')})`,
      context: { count, items },
    });
  }
  if (selfReferences.length > 0) {
    anomalies.add({
      level: 'info',
      code: VARIATION_ANOMALIES.selfReference,
      message: `${selfReferences.length} establishments list the subject itself as associated territory: ignored`,
      context: { count: selfReferences.length, items: selfReferences },
    });
  }
  for (const { level, event, count, source } of missingRules.values()) {
    reportMissingRule(level, event, count, source, anomalies);
  }

  // Entities whose version boundary of a date is explained by an event other than a territorial one.
  const explained = new Set<string>();
  for (const fact of facts) {
    const entities = levels.get(fact.level)?.entities;
    if (fact.rule.effect === 'territorial' || entities === undefined) continue;
    if (effectOf(fact, entities, explained) !== null) explained.add(boundaryKey(fact));
  }

  const groups = groupFacts(withoutLinksOfActs(facts, levels, explained, anomalies));
  const drafts: VariationDraft[] = [];
  for (const [key, group] of groups) {
    const draft = buildDraft(key, group, levels, explained, anomalies);
    if (draft !== null) drafts.push(draft);
  }
  coverBoundaries(drafts, levels, options);
  drafts.sort((a, b) => compareDates(a.date, b.date) || compareStrings(a.key, b.key));
  for (const draft of drafts) {
    draft.participants.sort((a, b) => compareLevels(a.level, b.level) || compareStrings(a.entityId, b.entityId));
    draft.links.sort(
      (a, b) => compareLevels(a.level, b.level) || compareStrings(a.from, b.from) || compareStrings(a.to, b.to),
    );
  }
  accounts.sort((a, b) => compareStrings(a.source, b.source) || a.index - b.index);
  return { variations: drafts, accounts };
}

function levelFacts(
  level: Level,
  input: VariationLevelInput<Level>,
  entities: LevelEntities,
  today: IsoDate,
  accounts: EventAccount[],
  missingRules: Map<string, { level: Level; event: IstatEventCode; count: number; source: string }>,
  selfReferences: SelfReference[],
  mismatches: Map<string, CodeMismatch>,
  anomalies: AnomalyCollector,
): Fact[] {
  const resolver = input.identity.resolver;
  const ruleOf = (event: IstatEventCode, source: string): EventRule | undefined => {
    const rule = eventRule(level, event);
    if (rule === undefined) {
      const key = `${level}|${event}|${source}`;
      const missing = missingRules.get(key) ?? { level, event, count: 0, source };
      missing.count += 1;
      missingRules.set(key, missing);
    }
    return rule;
  };
  const account = (source: string, index: number, event: IstatEventCode, date: IsoDate): EventAccount => {
    const entry: EventAccount = { source, index, level, event, date, variation: null, dropped: null };
    accounts.push(entry);
    return entry;
  };
  /**
   * A territory of a territorial event falls back to `D − 1`: it may cease that day (Tenda, ceded
   * abroad on 1947-09-16, D33).
   */
  const entityOf = (query: ResolveQuery, rule: EventRule, context: Record<string, unknown>): EntityId | null => {
    let resolution: Resolution | null;
    try {
      resolution = resolver.resolve(query);
    } catch (error) {
      if (!(error instanceof ResolutionError)) throw error;
      if (rule.effect === 'territorial' && query.side === 'successor' && error.reason === 'not-found') {
        resolution = resolver.resolveOrReport({ ...query, side: 'predecessor' }, anomalies, context);
      } else {
        anomalies.add(resolutionAnomaly(error, context));
        resolution = null;
      }
    }
    return resolution === null ? null : (entities.ofInterval(resolution.intervalKey) ?? null);
  };
  const relatedEntity = (
    rule: EventRule,
    code: string,
    date: IsoDate,
    cadastralCode: string | null,
    context: Record<string, unknown>,
  ): EntityId | null => {
    if (rule.flow === null) return null;
    return entityOf({ level, code, date, side: rule.flow.relatedSide, cadastralCode }, rule, context);
  };

  const internalByKey = new Map<string, Fact[]>();
  const internalEvent = new Map<Fact, IstatEventCode>();
  const publicEvent = new Map<Fact, IstatEventCode>();
  const facts: Fact[] = [];
  const source = INTERNAL_SOURCES[level];
  (input.internal ?? []).forEach((e, index) => {
    const row = account(source, index, e.event, e.date);
    if (isAfter(e.date, today)) {
      row.dropped = 'future';
      return;
    }
    const rule = ruleOf(e.event, source);
    if (rule === undefined) {
      row.dropped = 'rule-missing';
      return;
    }
    if (rule.effect === 'first-validity') {
      row.dropped = 'first-validity';
      return;
    }
    const entityId = entities.ofRoot(e.root);
    if (entityId === undefined) {
      row.dropped = 'unknown-entity';
      anomalies.add({
        level: 'blocking',
        code: VARIATION_ANOMALIES.unknownEntity,
        message: `${level} ${e.event} of ${e.date} (act ${e.actId}): no entity has the ISTAT origin id ${e.root}`,
        context: { level, event: e.event, date: e.date, actId: e.actId, root: e.root, source },
      });
      return;
    }
    const fact: Fact = {
      level,
      date: e.date,
      event: e.event,
      rule,
      entityId,
      actId: e.actId,
      description: e.description,
      related: new Set(),
      associatedCodes: new Set((e.details ?? []).flatMap((d) => (d.code === null ? [] : [d.code]))),
      abroad: false,
      rows: [row],
    };
    // Municipality details (r9) only disambiguate acts: the related territories come from the rows.
    for (const detail of level === 'municipality' ? [] : (e.details ?? [])) {
      if (detail.abroad) fact.abroad = true;
      else if (detail.code !== null && rule.effect === 'opening' && detail.code === e.code) {
        selfReferences.push({
          level,
          event: e.event,
          date: e.date,
          code: e.code,
          source: `${source} details`,
          actId: e.actId,
        });
      } else if (detail.code !== null) {
        const related = relatedEntity(rule, detail.code, e.date, null, { source: `${source} details`, actId: e.actId });
        if (related !== null) fact.related.add(related);
      }
    }
    facts.push(fact);
    internalEvent.set(fact, e.event);
    const key = factKey(level, e.date, entityId, e.event);
    internalByKey.set(key, [...(internalByKey.get(key) ?? []), fact]);
  });

  /** D48. `null`: not unique (`blocking`); `undefined`: none. */
  const equivalentFacts = (
    row: EventRowByLevel[Level],
    entityId: EntityId,
    source: string,
    index: number,
  ): Fact[] | null | undefined => {
    const candidates = equivalentEventCodes(level, row.event).flatMap(
      (code) => internalByKey.get(factKey(level, row.date, entityId, code)) ?? [],
    );
    if (candidates.length === 0) return undefined;
    const acts = [...new Set(candidates.map((f) => f.actId))];
    const codes = [...new Set(candidates.map((f) => internalEvent.get(f)))];
    if (acts.length === 1 && codes.length === 1) return candidates;
    ambiguousEquivalence(row, source, index, `internal events of acts ${acts.join(', ')}, codes ${codes.join(', ')}`);
    return null;
  };
  const ambiguousEquivalence = (row: EventRowByLevel[Level], source: string, index: number, detail: string): void => {
    anomalies.add({
      level: 'blocking',
      code: VARIATION_ANOMALIES.equivalenceAmbiguous,
      message: `${level} ${row.event} of ${row.code} on ${row.date} (${source}): no unique internal event (${detail})`,
      context: { level, event: row.event, date: row.date, code: row.code, source, index, detail },
    });
  };

  const publicByKey = new Map<string, Fact>();
  const lists = input.eventLists as Partial<Record<number, readonly EventRowByLevel[Level][]>>;
  for (const pfun of Object.keys(lists)
    .map(Number)
    .sort((a, b) => a - b)) {
    const listSource = `events:pfun-${pfun}`;
    (lists[pfun] ?? []).forEach((row, index) => {
      const entry = account(listSource, index, row.event, row.date);
      if (isAfter(row.date, today)) {
        entry.dropped = 'future';
        return;
      }
      const rule = ruleOf(row.event, listSource);
      if (rule === undefined) {
        entry.dropped = 'rule-missing';
        return;
      }
      if (rule.effect === 'first-validity') {
        entry.dropped = 'first-validity';
        return;
      }
      const context = { source: listSource, index, event: row.event, date: row.date, code: row.code };
      const entityId = entityOf(
        { level, code: row.code, date: row.date, side: rule.subjectSide, cadastralCode: cadastralOf(row) },
        rule,
        context,
      );
      if (entityId === null) {
        entry.dropped = 'unresolved';
        return;
      }
      const self = rule.effect === 'opening' && row.related?.code === row.code;
      if (self) {
        selfReferences.push({
          level,
          event: row.event,
          date: row.date,
          code: row.code,
          source: listSource,
          actId: null,
        });
      }
      const related =
        row.related?.code == null || self
          ? null
          : relatedEntity(rule, row.related.code, row.date, relatedCadastralOf(row), { ...context, side: 'related' });

      const key = factKey(level, row.date, entityId, row.event);
      const exact = internalByKey.get(key);
      const equivalent = exact === undefined ? equivalentFacts(row, entityId, listSource, index) : undefined;
      let fact = exact === undefined ? equivalent?.[0] : matchInternal(exact, level, row, listSource, anomalies);
      // An internal fact takes the rows of one public code only: the code its variation shows.
      const claimed = fact === undefined ? undefined : publicEvent.get(fact);
      if (fact !== undefined && claimed !== undefined && claimed !== row.event) {
        ambiguousEquivalence(row, listSource, index, `its internal event is already matched by ${claimed} rows`);
        fact = undefined;
      } else if (fact !== undefined && equivalent) {
        const internal = internalEvent.get(fact) ?? fact.event;
        const mismatchKey = `${level}|${row.event}|${internal}|${fact.actId}`;
        const mismatch = mismatches.get(mismatchKey) ?? {
          level,
          publicEvent: row.event,
          internalEvent: internal,
          actId: fact.actId,
          count: 0,
        };
        mismatch.count += 1;
        mismatches.set(mismatchKey, mismatch);
        // The public list is the source of truth (§3): the variation shows its code.
        for (const f of equivalent) {
          f.event = row.event;
          publicEvent.set(f, row.event);
        }
      } else if (fact !== undefined) {
        publicEvent.set(fact, row.event);
      }
      fact ??= publicByKey.get(key);
      if (fact === undefined) {
        fact = {
          level,
          date: row.date,
          event: row.event,
          rule,
          entityId,
          actId: null,
          description: null,
          related: new Set(),
          associatedCodes: new Set(),
          abroad: false,
          rows: [],
        };
        publicByKey.set(key, fact);
        facts.push(fact);
      }
      fact.rows.push(entry);
      if (row.abroad) fact.abroad = true;
      if (related !== null) fact.related.add(related);
    });
  }
  return facts;
}

/** An associated territory equal to the subject is not a predecessor (golden-20, Caserta 1945). */
interface SelfReference {
  level: Level;
  event: IstatEventCode;
  date: IsoDate;
  code: string;
  source: string;
  actId: number | null;
}

interface CodeMismatch {
  level: Level;
  publicEvent: IstatEventCode;
  internalEvent: IstatEventCode;
  actId: number | null;
  count: number;
}

function matchInternal(
  candidates: readonly Fact[] | undefined,
  level: Level,
  row: EventRowByLevel[Level],
  source: string,
  anomalies: AnomalyCollector,
): Fact | undefined {
  if (candidates === undefined) return undefined;
  const acts = [...new Set(candidates.map((f) => f.actId))];
  if (acts.length === 1) return candidates[0];
  // Several acts: the one whose details list the row's related territory (by code), if only one does.
  const relatedCode = row.related?.code ?? null;
  if (relatedCode !== null) {
    const matching = candidates.filter((f) => f.associatedCodes.has(relatedCode));
    if (new Set(matching.map((f) => f.actId)).size === 1) return matching[0];
  }
  anomalies.add({
    level: 'warning',
    code: VARIATION_ANOMALIES.actAmbiguous,
    message: `${level} ${row.event} of ${row.code} on ${row.date} (${source}) matches internal events of acts ${acts.join(', ')}`,
    context: { level, event: row.event, date: row.date, code: row.code, source, acts },
  });
  return undefined;
}

function withoutLinksOfActs(
  facts: readonly Fact[],
  levels: ReadonlyMap<Level, { entities: LevelEntities }>,
  explained: ReadonlySet<string>,
  anomalies: AnomalyCollector,
): Fact[] {
  const linkKey = (date: IsoDate, link: VariationLink): string => `${date}|${link.level}|${link.from}|${link.to}`;
  const actOf = new Map<string, string>();
  for (const fact of facts) {
    const entities = levels.get(fact.level)?.entities;
    if (fact.actId === null || entities === undefined || effectOf(fact, entities, explained) === null) continue;
    const key = `act:${fact.actId}:${fact.date}`;
    for (const link of factLinks(fact, entities)) {
      const k = linkKey(fact.date, link);
      const other = actOf.get(k);
      if (other === undefined || compareStrings(key, other) < 0) actOf.set(k, key);
    }
  }
  const items: { level: Level; date: IsoDate; event: IstatEventCode; entityId: EntityId; variation: string }[] = [];
  const kept = facts.filter((fact) => {
    const entities = levels.get(fact.level)?.entities;
    if (fact.actId !== null || entities === undefined) return true;
    const links = factLinks(fact, entities);
    const acts = links.map((link) => actOf.get(linkKey(fact.date, link)));
    if (links.length === 0 || acts.some((a) => a === undefined)) return true;
    const variation = [...(acts as string[])].sort(compareStrings)[0] ?? '';
    for (const row of fact.rows) row.variation = variation;
    items.push({ level: fact.level, date: fact.date, event: fact.event, entityId: fact.entityId, variation });
    return false;
  });
  if (items.length > 0) {
    anomalies.add({
      level: 'info',
      code: VARIATION_ANOMALIES.linkExplainedByAct,
      message: `${items.length} public rows without act repeat links of a variation with an act: explained by it`,
      context: { count: items.length, items },
    });
  }
  return kept;
}

function groupFacts(facts: readonly Fact[]): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>();
  const add = (key: string, fact: Fact): void => {
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  };
  const loose = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (fact.actId !== null) add(`act:${fact.actId}:${fact.date}`, fact);
    else {
      const key = `${fact.date}|${fact.level}`;
      loose.set(key, [...(loose.get(key) ?? []), fact]);
    }
  }
  for (const group of loose.values()) {
    const parent = group.map((_, i) => i);
    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) root = parent[root] ?? root;
      return root;
    };
    const owner = new Map<EntityId, number>();
    group.forEach((fact, i) => {
      for (const entity of [fact.entityId, ...fact.related]) {
        const other = owner.get(entity);
        if (other === undefined) owner.set(entity, i);
        else {
          const [a, b] = [find(other), find(i)];
          if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        }
      }
    });
    const components = new Map<number, Fact[]>();
    group.forEach((fact, i) => components.set(find(i), [...(components.get(find(i)) ?? []), fact]));
    for (const component of components.values()) {
      const [first] = component;
      if (first === undefined) continue;
      const entity = component.map((f) => f.entityId).sort(compareStrings)[0];
      for (const fact of component) add(`nk:${first.date}:${first.level}:${entity}`, fact);
    }
  }
  return groups;
}

function buildDraft(
  key: string,
  group: readonly Fact[],
  levels: ReadonlyMap<Level, { entities: LevelEntities }>,
  explained: ReadonlySet<string>,
  anomalies: AnomalyCollector,
): VariationDraft | null {
  const [first] = group;
  if (first === undefined) return null;
  const { date } = first;

  interface Claim {
    level: Level;
    entityId: EntityId;
    events: Set<IstatEventCode>;
    dropped: Set<IstatEventCode>;
    before: AnyVersion | null;
    after: AnyVersion | null;
    abroad: boolean;
  }
  const claims = new Map<string, Claim>();
  const links = new Map<string, VariationLink>();
  for (const fact of group) {
    const entities = levels.get(fact.level)?.entities;
    if (entities === undefined) continue;
    const claimKey = `${fact.level}|${fact.entityId}`;
    const claim: Claim = claims.get(claimKey) ?? {
      level: fact.level,
      entityId: fact.entityId,
      events: new Set(),
      dropped: new Set(),
      before: null,
      after: null,
      abroad: false,
    };
    claims.set(claimKey, claim);
    const effect = effectOf(fact, entities, explained);
    if (effect === null) {
      claim.dropped.add(fact.event);
      for (const row of fact.rows) row.dropped = 'no-effect';
      anomalies.add({
        level: 'info',
        code: VARIATION_ANOMALIES.withoutEffect,
        message: `${fact.level} entity ${fact.entityId}: ${fact.event} of ${date} has no effect on its versions (dropped)`,
        context: { level: fact.level, entityId: fact.entityId, event: fact.event, date, variation: key },
      });
      continue;
    }
    for (const row of fact.rows) row.variation = key;
    claim.events.add(fact.event);
    claim.before ??= effect.before;
    claim.after ??= effect.after;
    if (fact.abroad) claim.abroad = true;
    for (const link of factLinks(fact, entities)) links.set(`${link.level}|${link.from}|${link.to}`, link);
  }

  const participants: Participant[] = [];
  for (const claim of claims.values()) {
    const effective = claim.events.size > 0;
    const istatEvents = [...(effective ? claim.events : claim.dropped)].sort(compareStrings);
    const participant: Participant = {
      level: claim.level,
      entityId: claim.entityId,
      istatEvents,
      abroad: effective && claim.abroad,
      role: null,
      versionBefore: claim.before?.validFrom ?? null,
      versionAfter: claim.after?.validFrom ?? null,
    };
    if (effective) participant.role = roleOf(participant, key, anomalies);
    participants.push(participant);
  }
  if (!participants.some((p) => p.role !== null)) return null;

  return {
    key,
    date,
    istatActId: first.actId,
    origin: 'istat',
    description: descriptionOf(group),
    participants,
    links: [...links.values()],
  };
}

function effectOf(
  fact: Fact,
  entities: LevelEntities,
  explained: ReadonlySet<string>,
): { before: AnyVersion | null; after: AnyVersion | null } | null {
  const before = entities.ending(fact.entityId, fact.date) ?? null;
  const after = entities.starting(fact.entityId, fact.date) ?? null;
  switch (fact.rule.effect) {
    case 'closing':
      return before === null ? null : { before, after: null };
    case 'opening':
      return after === null ? null : { before: null, after };
    case 'attribute':
      return before === null || after === null ? null : { before, after };
    case 'territorial': {
      if (before !== null && after !== null && !explained.has(boundaryKey(fact))) return { before, after };
      const exists =
        entities.existsOn(fact.entityId, fact.date) || entities.existsOn(fact.entityId, previousDay(fact.date));
      return exists ? { before: null, after: null } : null;
    }
    case 'first-validity':
      return null;
  }
}

function boundaryKey(fact: Fact): string {
  return `${fact.level}|${fact.entityId}|${fact.date}`;
}

function factLinks(fact: Fact, entities: LevelEntities): VariationLink[] {
  const flow = fact.rule.flow;
  if (flow === null) return [];
  const links: VariationLink[] = [];
  for (const related of [...fact.related].sort(compareStrings)) {
    if (related === fact.entityId) continue;
    const [from, to] = flow.direction === 'subject-to-related' ? [fact.entityId, related] : [related, fact.entityId];
    links.push({ level: fact.level, from, to, kind: linkKind(from, to, fact.date, entities) });
  }
  return links;
}

function linkKind(from: EntityId, to: EntityId, date: IsoDate, entities: LevelEntities): LinkKind {
  if (!entities.existsOn(from, date)) return 'merged_into';
  if (!entities.existsOn(to, previousDay(date))) return 'detached_into';
  return 'transferred_to';
}

function roleOf(participant: Participant, key: string, anomalies: AnomalyCollector): ParticipantRole | null {
  const { istatEvents: events, versionBefore: before, versionAfter: after } = participant;
  const has = (...codes: IstatEventCode[]): boolean => codes.some((c) => events.includes(c));
  let role: ParticipantRole | null = null;
  if (before === null && after !== null) role = has('CS', 'CSCT') ? 'established' : has('AN') ? 'annexed' : null;
  else if (before !== null && after === null) role = has('ES', 'ESCT') ? 'suppressed' : has('AS') ? 'ceded' : null;
  else if (before !== null && after !== null) role = 'changed';
  else if (events.every((e) => PARTICIPANT_ROLE_RULES.territory_changed.only?.includes(e))) role = 'territory_changed';
  const violations = role === null ? ['no role fits'] : participantRoleViolations({ ...participant, role });
  if (violations.length === 0) return role;
  anomalies.add({
    level: 'blocking',
    code: VARIATION_ANOMALIES.participantInconsistent,
    message: `${participant.level} entity ${participant.entityId} in ${key}: ${violations.join('; ')}`,
    context: { variation: key, participant, violations },
  });
  return null;
}

/** Ties: the smallest text. */
function descriptionOf(group: readonly Fact[]): string | null {
  const counts = new Map<string, number>();
  for (const fact of group) {
    if (fact.description !== null) counts.set(fact.description, (counts.get(fact.description) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const entry of counts) {
    if (best === null || entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0])) best = entry;
  }
  return best?.[0] ?? null;
}

function coverBoundaries(
  drafts: VariationDraft[],
  levels: ReadonlyMap<Level, { input: VariationLevelInput<Level>; entities: LevelEntities }>,
  options: BuildVariationsOptions,
): void {
  const claimed = new Set<string>();
  const claim = (level: Level, entityId: EntityId, side: 'before' | 'after', validFrom: IsoDate): string =>
    `${level}|${entityId}|${side}|${validFrom}`;
  for (const draft of drafts) {
    for (const p of draft.participants) {
      if (p.versionBefore !== null) claimed.add(claim(p.level, p.entityId, 'before', p.versionBefore));
      if (p.versionAfter !== null) claimed.add(claim(p.level, p.entityId, 'after', p.versionAfter));
    }
  }
  const byDate = new Map<IsoDate, VariationDraft[]>();
  for (const draft of drafts) byDate.set(draft.date, [...(byDate.get(draft.date) ?? []), draft]);
  const sortedOn = (date: IsoDate): VariationDraft[] =>
    [...(byDate.get(date) ?? [])].sort((a, b) => compareStrings(a.key, b.key));

  for (const [level, { input, entities }] of levels) {
    const warned = warnedBoundaries(input, entities);
    for (const [entityId, versions] of entities.entities()) {
      versions.forEach((version, i) => {
        const previous = versions[i - 1];
        const contiguous = previous?.validTo === version.validFrom ? previous : undefined;
        if (version.validFrom !== options.start) {
          const before = contiguous;
          const covered =
            claimed.has(claim(level, entityId, 'after', version.validFrom)) &&
            (before === undefined || claimed.has(claim(level, entityId, 'before', before.validFrom)));
          if (!covered) {
            if (before === undefined) unexplained(level, entityId, version.validFrom, 'opened', options.anomalies);
            else {
              const date = version.validFrom;
              const participant: Participant = {
                level,
                entityId,
                istatEvents: [],
                abroad: false,
                role: 'indirect',
                versionBefore: before.validFrom,
                versionAfter: version.validFrom,
              };
              const parents = parentChange(before, version);
              const target =
                parents.length === 0 ? undefined : sortedOn(date).find((d) => hosts(d, parents, level, entityId));
              const abbreviationOnly = level === 'province' && onlyAbbreviationChanges(before, version);
              if (abbreviationOnly) {
                options.anomalies.add({
                  level: 'warning',
                  code: VARIATION_ANOMALIES.abbreviationChange,
                  message:
                    `province entity ${entityId}: abbreviation ${String(abbreviationOf(before))} → ` +
                    `${String(abbreviationOf(version))} on ${date} without an event`,
                  context: {
                    level,
                    entityId,
                    date,
                    istatCode: version.istatCode,
                    from: abbreviationOf(before),
                    to: abbreviationOf(version),
                  },
                });
              }
              if (target !== undefined) target.participants.push(participant);
              else if (abbreviationOnly || warned.has(`${entityId}|${date}`) || options.inferredDates.has(date)) {
                const draft: VariationDraft = {
                  key: `inferred:${date}:${level}:${entityId}`,
                  date,
                  istatActId: null,
                  origin: 'inferred',
                  description: null,
                  participants: [participant],
                  links: [],
                };
                drafts.push(draft);
                byDate.set(date, [...(byDate.get(date) ?? []), draft]);
              } else unexplained(level, entityId, date, 'changed', options.anomalies);
            }
          }
        }
        const next = versions[i + 1];
        if (version.validTo !== null && next?.validFrom !== version.validTo) {
          if (!claimed.has(claim(level, entityId, 'before', version.validFrom))) {
            unexplained(level, entityId, version.validTo, 'closed', options.anomalies);
          }
        }
      });
    }
  }
}

function abbreviationOf(version: AnyVersion): string | null {
  return 'abbreviation' in version ? version.abbreviation : null;
}

function onlyAbbreviationChanges(before: AnyVersion, after: AnyVersion): boolean {
  const rest = (version: AnyVersion) =>
    canonicalJson({ ...version, validFrom: undefined, validTo: undefined, abbreviation: undefined });
  return abbreviationOf(before) !== abbreviationOf(after) && rest(before) === rest(after);
}

/** A municipality whose province changes region is hosted by the province's variation. */
function parentChange(before: AnyVersion, after: AnyVersion): [Level, EntityId][] {
  const fields = [
    ['province', 'provinceId'],
    ['region', 'regionId'],
  ] as const;
  const value = (version: AnyVersion, name: string): EntityId | null =>
    name in version ? ((version as unknown as Record<string, EntityId | null>)[name] ?? null) : null;
  if (fields.every(([, name]) => value(before, name) === value(after, name))) return [];
  return fields.flatMap(([level, name]) =>
    [value(before, name), value(after, name)].flatMap((id): [Level, EntityId][] => (id === null ? [] : [[level, id]])),
  );
}

function hosts(
  draft: VariationDraft,
  parents: readonly [Level, EntityId][],
  level: Level,
  entityId: EntityId,
): boolean {
  return (
    draft.origin === 'istat' &&
    draft.participants.some((p) => p.role !== null && parents.some(([l, id]) => p.level === l && p.entityId === id)) &&
    !draft.participants.some((p) => p.level === level && p.entityId === entityId)
  );
}

function warnedBoundaries(input: VariationLevelInput<Level>, entities: LevelEntities): Set<string> {
  const warned = new Set<string>();
  const { transitions } = input.identity;
  for (const link of [...transitions.links.filter((l) => l.rule === 'cadastral'), ...transitions.renamesWithoutEvent]) {
    const entityId = entities.ofInterval(link.to);
    if (entityId !== undefined && entityId === entities.ofInterval(link.from)) warned.add(`${entityId}|${link.date}`);
  }
  return warned;
}

function unexplained(
  level: Level,
  entityId: EntityId,
  date: IsoDate,
  side: 'opened' | 'closed' | 'changed',
  anomalies: AnomalyCollector,
): void {
  anomalies.add({
    level: 'blocking',
    code: VARIATION_ANOMALIES.boundaryUnexplained,
    message: `${level} entity ${entityId}: the version ${side} on ${date} is explained by no event`,
    context: { level, entityId, date, side },
  });
}

export function registerVariations(
  registry: Registry,
  drafts: readonly VariationDraft[],
  options: AssignOptions,
): { variations: Variation[]; assignment: Assignment<number> } {
  const assignment = registry.assignVariations(
    drafts.map((d) => ({ key: d.key, date: d.date })),
    options,
  );
  const variations = drafts.map(({ key, ...draft }) => {
    const id = assignment.ids.get(key);
    if (id === undefined) throw new Error(`no id for variation ${key}`);
    return { id, ...draft };
  });
  return { variations, assignment };
}

function factKey(level: Level, date: IsoDate, entityId: EntityId, event: IstatEventCode): string {
  return `${level}|${date}|${entityId}|${event}`;
}

function cadastralOf(row: EventRowByLevel[Level]): string | null {
  return 'cadastralCode' in row ? row.cadastralCode : null;
}

function relatedCadastralOf(row: EventRowByLevel[Level]): string | null {
  return row.related !== null && 'cadastralCode' in row.related ? row.related.cadastralCode : null;
}

function compareLevels(a: Level, b: Level): number {
  return LEVELS.indexOf(a) - LEVELS.indexOf(b);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
