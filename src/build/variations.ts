/**
 * Variations, participants and links (§4.3, Step 11), from the public event lists and the internal
 * event histories, over the versions built by Step 10.
 *
 * 1. **Facts.** Every event row becomes a fact `(level, date, entity, event code)`:
 *    - internal events (r4/r5/r6) belong to the entity whose ISTAT origin id is the root of their
 *      identity component (§5.1); they carry the act id and the description, and for regions and
 *      UTS the associated territories of their details (r7/r8);
 *    - public rows identify their subject and related territory through the code resolver, on the
 *      sides of their event rule (`event-rules.ts`, §3.5 item 6);
 *    - a public row is matched to the internal event of the same `(date, entity, event code)`,
 *      which provides `istat_act_id` and `description`; unmatched rows keep both null.
 * 2. **Grouping.** One variation per `(istat_act_id, date)`, across levels (`act:<act>:<date>`).
 *    Facts without act id are grouped per date and level into the connected components of the
 *    entities they mention (subject or related), keyed by the smallest subject entity id
 *    (`nk:<date>:<level>:<entity id>`); they never join a variation with an act id.
 * 3. **Effect**, per fact: a closing event needs the subject's version ending on `D`, an opening
 *    event the version starting on `D`, an attribute change both (a version boundary on `D`); a
 *    territorial event needs the subject to exist around `D`, and claims its version boundary on
 *    `D` only when no other event of the entity on `D` (in any act) explains it already: an
 *    attribute change carried by territorial events only (§4.3 `changed`). A
 *    fact without effect is dropped and logged (`info`; e.g. the same-day `AP` of a municipality
 *    suppressed on that day, golden-6), and its participation keeps `role: null` when nothing else
 *    of the entity has an effect in that variation.
 * 4. **Participants**: one per entity and variation, with the codes of its effective facts (sorted), the
 *    versions they claim and the role of §4.3; `abroad` when a counterpart is a foreign state.
 * 5. **Links**: the territory flows of effective facts between two entities of the same level,
 *    once per `(from, to)`. The kind follows from the effect (§4.3): `merged_into` when `from` no
 *    longer exists on `D`, otherwise `detached_into` when `to` did not exist on `D − 1`, otherwise
 *    `transferred_to`.
 * 6. **Uncovered version boundaries** (I9): a boundary between two contiguous versions whose parent
 *    (province or region) changes gets an `indirect` participant in the variation of `D` where an
 *    old or new parent participates (the first by natural key). Otherwise, a boundary already
 *    reported upstream (`identity-cadastral-continuity`, `name-change-without-event`,
 *    `inferred-breakpoint`) gets an `inferred` variation (`inferred:<date>:<level>:<entity id>`);
 *    any other uncovered boundary is `blocking` (`version-boundary-unexplained`).
 *
 * Every event row is accounted for (I14): represented in a variation, or dropped with a reason.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareDates, containsDate, previousDay, type IsoDate } from '../dates/index.ts';
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
  type IstatEventCode,
  type Level,
  type LinkKind,
  type ParticipantRole,
} from '../model/common.ts';
import type { EntityByLevel, Participant, Variation, VariationLink, VersionByLevel } from '../model/internal.ts';
import { ResolutionError, resolutionAnomaly, type Resolution, type ResolveQuery } from '../resolve/index.ts';
import type { EventRowByLevel } from '../sources/situas-public/index.ts';
import { eventRule, reportMissingRule, type EventRule } from './event-rules.ts';
import type { IdentifiedEntity } from './timeline.ts';

/** An internal event as the variation builder needs it. */
export interface InternalVariationEvent {
  /** Root of the event's identity component: the ISTAT origin id of its entity (§5.1). */
  root: number;
  event: IstatEventCode;
  date: IsoDate;
  actId: number;
  description: string | null;
  /** Associated territories (r7/r8); `null` when not available (municipalities, failed details). */
  details: readonly { abroad: boolean; code: string | null }[] | null;
}

export interface VariationLevelInput<L extends Level> {
  /** Entities with their registered versions (Step 10). */
  entities: readonly EntityByLevel[L][];
  /** Snapshot intervals of each entity (Step 9). */
  identified: readonly IdentifiedEntity<L>[];
  /** Resolver (with the same-day aliases) and transitions of the level (Step 9). */
  identity: Pick<LevelIdentity<L>, 'resolver' | 'transitions'>;
  eventLists: LevelEventLists<L>;
  /** `null` when the level was not crawled. */
  internal: readonly InternalVariationEvent[] | null;
}

export interface BuildVariationsOptions {
  levels: { [L in Level]?: VariationLevelInput<L> };
  /** First calendar date: versions starting on it open no variation (`PV`, I9). */
  start: IsoDate;
  /** Calendar dates whose only source is an inferred breakpoint (Step 6). */
  inferredDates: ReadonlySet<IsoDate>;
  anomalies: AnomalyCollector;
}

/** A variation before its registry id (§5.3), with its natural key. */
export interface VariationDraft extends Omit<Variation, 'id'> {
  key: string;
}

export type DropReason = 'first-validity' | 'no-effect' | 'unresolved' | 'unknown-entity' | 'rule-missing';

/** What became of one event row (I14). */
export interface EventAccount {
  /** Endpoint id of the row (`events:pfun-<id>`, `r4:region-events`, …). */
  source: string;
  /** Position of the row in its public list, or in the internal events of its level. */
  index: number;
  level: Level;
  event: IstatEventCode;
  date: IsoDate;
  /** Natural key of the variation representing the row; `null` when dropped. */
  variation: string | null;
  dropped: DropReason | null;
}

export interface VariationBuild {
  /** Sorted by date, then natural key. */
  variations: VariationDraft[];
  accounts: EventAccount[];
}

/** Stable anomaly codes of the variation builder (§8.2). */
export const VARIATION_ANOMALIES = {
  /** An internal event whose identity component is the root of no entity. */
  unknownEntity: 'variation-entity-unknown',
  /** A public row matching internal events of several acts. */
  actAmbiguous: 'variation-act-ambiguous',
  /** An event row without effect, dropped (§4.3). */
  withoutEffect: 'participation-without-effect',
  /** A version boundary that no event, parent change or upstream warning explains (I9). */
  boundaryUnexplained: 'version-boundary-unexplained',
  /** A participant inconsistent with the role table (§4.3). */
  participantInconsistent: 'variation-participant-inconsistent',
} as const;

const INTERNAL_SOURCES: Readonly<Record<Level, string>> = {
  region: 'r4:region-events',
  province: 'r5:uts-events',
  municipality: 'r6:municipality-events',
};

/** The internal events of a crawled level (Step 7), with their details. */
export function internalVariationEvents(
  crawl: {
    graph: {
      components: readonly {
        root: number;
        events: readonly CrawledEvent<
          { event: IstatEventCode; date: IsoDate; actId: number; description: string | null },
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
      actId: event.actId,
      description: event.description,
      details: details?.map((d) => ({ abroad: d.abroad, code: d.related?.code ?? null })) ?? null,
    })),
  );
}

type AnyVersion = VersionByLevel[Level];

/** An event of one entity on one date, from one or more rows. */
interface Fact {
  level: Level;
  date: IsoDate;
  event: IstatEventCode;
  rule: EventRule;
  entityId: number;
  actId: number | null;
  description: string | null;
  /** Related entities of the same level, by resolved row. */
  related: Set<number>;
  abroad: boolean;
  /** The rows of the fact, for the accounting (I14). */
  rows: EventAccount[];
}

/** Versions and intervals of the entities of one level. */
class LevelEntities {
  readonly level: Level;
  readonly #versions = new Map<number, AnyVersion[]>();
  readonly #byInterval = new Map<string, number>();
  readonly #byRoot = new Map<number, number>();

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

  entities(): [number, readonly AnyVersion[]][] {
    return [...this.#versions].sort(([a], [b]) => a - b);
  }

  ofInterval(key: string): number | undefined {
    return this.#byInterval.get(key);
  }

  ofRoot(root: number): number | undefined {
    return this.#byRoot.get(root);
  }

  /** The version of `entityId` ending on `date` (`validTo = date`). */
  ending(entityId: number, date: IsoDate): AnyVersion | undefined {
    return this.#versions.get(entityId)?.find((v) => v.validTo === date);
  }

  /** The version of `entityId` starting on `date`. */
  starting(entityId: number, date: IsoDate): AnyVersion | undefined {
    return this.#versions.get(entityId)?.find((v) => v.validFrom === date);
  }

  existsOn(entityId: number, date: IsoDate): boolean {
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
  const facts: Fact[] = [];
  for (const [level, { input, entities }] of levels) {
    facts.push(...levelFacts(level, input, entities, accounts, missingRules, anomalies));
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

  const groups = groupFacts(facts);
  const drafts: VariationDraft[] = [];
  for (const [key, group] of groups) {
    const draft = buildDraft(key, group, levels, explained, anomalies);
    if (draft !== null) drafts.push(draft);
  }
  coverBoundaries(drafts, levels, options);
  drafts.sort((a, b) => compareDates(a.date, b.date) || compareStrings(a.key, b.key));
  for (const draft of drafts) {
    draft.participants.sort((a, b) => compareLevels(a.level, b.level) || a.entityId - b.entityId);
    draft.links.sort((a, b) => compareLevels(a.level, b.level) || a.from - b.from || a.to - b.to);
  }
  accounts.sort((a, b) => compareStrings(a.source, b.source) || a.index - b.index);
  return { variations: drafts, accounts };
}

/** Facts of one level: internal events, then public rows matched to them or kept on their own. */
function levelFacts(
  level: Level,
  input: VariationLevelInput<Level>,
  entities: LevelEntities,
  accounts: EventAccount[],
  missingRules: Map<string, { level: Level; event: IstatEventCode; count: number; source: string }>,
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
   * The entity a row code identifies. A territory of a territorial event is looked up on `D` and,
   * when the code does not exist there, on `D − 1`: it ceases that day (e.g. Tenda gives part of
   * its territory to Limone Piemonte and is ceded abroad on 1947-09-16, §6.6, D33).
   */
  const entityOf = (query: ResolveQuery, rule: EventRule, context: Record<string, unknown>): number | null => {
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
  ): number | null => {
    if (rule.flow === null) return null;
    return entityOf({ level, code, date, side: rule.flow.relatedSide, cadastralCode }, rule, context);
  };

  const internalByKey = new Map<string, Fact[]>();
  const facts: Fact[] = [];
  const source = INTERNAL_SOURCES[level];
  (input.internal ?? []).forEach((e, index) => {
    const row = account(source, index, e.event, e.date);
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
      abroad: false,
      rows: [row],
    };
    for (const detail of e.details ?? []) {
      if (detail.abroad) fact.abroad = true;
      else if (detail.code !== null) {
        const related = relatedEntity(rule, detail.code, e.date, null, { source: `${source} details`, actId: e.actId });
        if (related !== null) fact.related.add(related);
      }
    }
    facts.push(fact);
    const key = factKey(level, e.date, entityId, e.event);
    internalByKey.set(key, [...(internalByKey.get(key) ?? []), fact]);
  });

  const publicByKey = new Map<string, Fact>();
  const lists = input.eventLists as Partial<Record<number, readonly EventRowByLevel[Level][]>>;
  for (const pfun of Object.keys(lists)
    .map(Number)
    .sort((a, b) => a - b)) {
    const listSource = `events:pfun-${pfun}`;
    (lists[pfun] ?? []).forEach((row, index) => {
      const entry = account(listSource, index, row.event, row.date);
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
      const related =
        row.related?.code == null
          ? null
          : relatedEntity(rule, row.related.code, row.date, relatedCadastralOf(row), { ...context, side: 'related' });

      const key = factKey(level, row.date, entityId, row.event);
      let fact = matchInternal(internalByKey.get(key), level, row, listSource, anomalies) ?? publicByKey.get(key);
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

/** The internal fact a public row belongs to: the only act among the candidates, if any. */
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
  anomalies.add({
    level: 'warning',
    code: VARIATION_ANOMALIES.actAmbiguous,
    message: `${level} ${row.event} of ${row.code} on ${row.date} (${source}) matches internal events of acts ${acts.join(', ')}`,
    context: { level, event: row.event, date: row.date, code: row.code, source, acts },
  });
  return undefined;
}

/** Facts by variation key: `act:<act>:<date>`, or the connected components of the others. */
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
    const owner = new Map<number, number>();
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
      const entity = Math.min(...component.map((f) => f.entityId));
      for (const fact of component) add(`nk:${first.date}:${first.level}:${entity}`, fact);
    }
  }
  return groups;
}

/** The variation of one group, or `null` when none of its facts has an effect. */
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
    entityId: number;
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
      versionBeforeId: claim.before?.id ?? null,
      versionAfterId: claim.after?.id ?? null,
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

/**
 * The versions a fact claims, or `null` when it has no effect (§4.3). A territorial fact claims
 * the boundary of its date only when no other event of the entity (`explained`) does.
 */
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
  for (const related of [...fact.related].sort((a, b) => a - b)) {
    if (related === fact.entityId) continue;
    const [from, to] = flow.direction === 'subject-to-related' ? [fact.entityId, related] : [related, fact.entityId];
    links.push({ level: fact.level, from, to, kind: linkKind(from, to, fact.date, entities) });
  }
  return links;
}

function linkKind(from: number, to: number, date: IsoDate, entities: LevelEntities): LinkKind {
  if (!entities.existsOn(from, date)) return 'merged_into';
  if (!entities.existsOn(to, previousDay(date))) return 'detached_into';
  return 'transferred_to';
}

/** The role of a participant with effective events (§4.3 role table). */
function roleOf(participant: Participant, key: string, anomalies: AnomalyCollector): ParticipantRole | null {
  const { istatEvents: events, versionBeforeId: before, versionAfterId: after } = participant;
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

/** The most frequent description of the group's internal events (ties: the smallest text). */
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

/**
 * Version boundaries not claimed by any participant (I9): `indirect` participants for parent
 * changes, `inferred` variations for boundaries reported upstream, `blocking` otherwise.
 */
function coverBoundaries(
  drafts: VariationDraft[],
  levels: ReadonlyMap<Level, { input: VariationLevelInput<Level>; entities: LevelEntities }>,
  options: BuildVariationsOptions,
): void {
  const claimed = new Set<string>();
  for (const draft of drafts) {
    for (const p of draft.participants) {
      if (p.versionBeforeId !== null) claimed.add(`${p.level}|before|${p.versionBeforeId}`);
      if (p.versionAfterId !== null) claimed.add(`${p.level}|after|${p.versionAfterId}`);
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
            claimed.has(`${level}|after|${version.id}`) &&
            (before === undefined || claimed.has(`${level}|before|${before.id}`));
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
                versionBeforeId: before.id,
                versionAfterId: version.id,
              };
              const parents = parentChange(before, version);
              const target =
                parents.length === 0 ? undefined : sortedOn(date).find((d) => hosts(d, parents, level, entityId));
              if (target !== undefined) target.participants.push(participant);
              else if (warned.has(`${entityId}|${date}`) || options.inferredDates.has(date)) {
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
          if (!claimed.has(`${level}|before|${version.id}`)) {
            unexplained(level, entityId, version.validTo, 'closed', options.anomalies);
          }
        }
      });
    }
  }
}

/**
 * The parents (old and new province and region) of a boundary where a parent changes, none
 * otherwise: e.g. a municipality whose province changes region is hosted by the variation of its
 * province.
 */
function parentChange(before: AnyVersion, after: AnyVersion): [Level, number][] {
  const fields = [
    ['province', 'provinceId'],
    ['region', 'regionId'],
  ] as const;
  const value = (version: AnyVersion, name: string): number | null =>
    name in version ? ((version as unknown as Record<string, number | null>)[name] ?? null) : null;
  if (fields.every(([, name]) => value(before, name) === value(after, name))) return [];
  return fields.flatMap(([level, name]) =>
    [value(before, name), value(after, name)].flatMap((id): [Level, number][] => (id === null ? [] : [[level, id]])),
  );
}

/** An ISTAT variation where one of `parents` participates and the entity does not yet. */
function hosts(draft: VariationDraft, parents: readonly [Level, number][], level: Level, entityId: number): boolean {
  return (
    draft.origin === 'istat' &&
    draft.participants.some((p) => p.role !== null && parents.some(([l, id]) => p.level === l && p.entityId === id)) &&
    !draft.participants.some((p) => p.level === level && p.entityId === entityId)
  );
}

/** Boundaries `<entity>|<date>` reported upstream: cadastral continuity, renames without event. */
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
  entityId: number,
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

/** Registry ids of the variations (§5.3). */
export function registerVariations(
  registry: Registry,
  drafts: readonly VariationDraft[],
  options: AssignOptions,
): { variations: Variation[]; assignment: Assignment } {
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

function factKey(level: Level, date: IsoDate, entityId: number, event: IstatEventCode): string {
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
