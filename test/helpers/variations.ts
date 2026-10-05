/**
 * Worlds for variation tests: the version worlds of Step 10 with registered versions, then the
 * variation builder (Step 11) over their event lists and internal events.
 */
import { AnomalyCollector } from '../../src/anomalies.ts';
import {
  buildVariations,
  registerVariations,
  registerVersions,
  type EventAccount,
  type InternalVariationEvent,
  type VariationLevelInput,
} from '../../src/build/index.ts';
import { compareDates, type IsoDate } from '../../src/dates/index.ts';
import type { IdentityGraph } from '../../src/identity/index.ts';
import { LEVELS, type IstatEventCode, type Level } from '../../src/model/common.ts';
import type { EntityByLevel, Variation } from '../../src/model/internal.ts';
import { decodedRows } from './internal.ts';
import { buildWorld, type BuiltWorld, type VersionWorld } from './versions.ts';

export interface VariationWorld extends VersionWorld {
  /** Internal events per level (r4/r5/r6 with r7/r8 details). */
  internalEvents?: Partial<Record<Level, InternalVariationEvent[]>>;
  /** Calendar dates of inferred breakpoints. */
  inferredDates?: IsoDate[];
}

export interface BuiltVariations extends BuiltWorld {
  /** Entities with registered versions. */
  entities: { [L in Level]: EntityByLevel[L][] };
  variations: Variation[];
  accounts: EventAccount[];
  /** Anomalies of the variation builder only. */
  variationAnomalies: AnomalyCollector;
}

export async function buildVariationWorld(world: VariationWorld): Promise<BuiltVariations> {
  const built = await buildWorld(world);
  const assign = { recordedOn: '2026-10-05', anomalies: new AnomalyCollector() };
  const entities = {
    region: registerVersions(built.registry, 'region', built.region, assign).entities,
    province: registerVersions(built.registry, 'province', built.province, assign).entities,
    municipality: registerVersions(built.registry, 'municipality', built.municipality, assign).entities,
  };
  const starts = LEVELS.flatMap((level) => built.identified[level].flatMap((e) => e.intervals.map((i) => i.validFrom)));
  const start = starts.sort(compareDates)[0] ?? '1861-03-17';
  const level = <L extends Level>(l: L): VariationLevelInput<L> | undefined => {
    const identity = built.identity[l];
    const levelWorld = world[l];
    if (identity === undefined || levelWorld === undefined) return undefined;
    return {
      entities: entities[l] as EntityByLevel[L][],
      identified: built.identified[l],
      identity,
      eventLists: (levelWorld.eventLists ?? {}) as VariationLevelInput<L>['eventLists'],
      internal: world.internalEvents?.[l] ?? null,
    };
  };
  const variationAnomalies = new AnomalyCollector();
  const { variations: drafts, accounts } = buildVariations({
    levels: { region: level('region'), province: level('province'), municipality: level('municipality') },
    start,
    inferredDates: new Set(world.inferredDates ?? []),
    anomalies: variationAnomalies,
  });
  const { variations } = registerVariations(built.registry, drafts, assign);
  return { ...built, entities, variations, accounts, variationAnomalies };
}

/** The internal events of an identity graph, with the r7/r8 details of `details` when given. */
export function variationEvents<
  E extends { event: IstatEventCode; date: IsoDate; actId: number; description: string | null; originId: number },
>(graph: IdentityGraph<E>, details = new Map<string, InternalVariationEvent['details']>()): InternalVariationEvent[] {
  return graph.components.flatMap((component) =>
    component.events.map((e) => ({
      root: component.root,
      event: e.event,
      date: e.date,
      actId: e.actId,
      description: e.description,
      details: details.get(detailKey(e.originId, e.event, e.actId)) ?? null,
    })),
  );
}

/** r8 fixtures (`<id_uts_origine>_<event>_<act>.json`) by origin id, event and act. */
export async function utsDetails(files: readonly string[]): Promise<Map<string, InternalVariationEvent['details']>> {
  const details = new Map<string, InternalVariationEvent['details']>();
  for (const file of files) {
    const [originId, event, actId] = file.replace(/\.json$/, '').split('_');
    const rows = await decodedRows('utsEventDetails', `r8-uts-event-details/${file}`);
    details.set(
      detailKey(Number(originId), event as IstatEventCode, Number(actId)),
      rows.map((r) => ({ abroad: r.abroad, code: r.related?.code ?? null })),
    );
  }
  return details;
}

function detailKey(originId: number, event: IstatEventCode, actId: number): string {
  return `${originId}|${event}|${actId}`;
}

/** Only the rows and events dated on `dates` (a world of those dates). */
export function onDates<T extends { date: IsoDate }>(rows: readonly T[], dates: readonly IsoDate[]): T[] {
  return rows.filter((r) => dates.includes(r.date));
}

/** The variation of `date` in which the entity participates. */
export function variationOf(built: BuiltVariations, level: Level, entityId: number, date: IsoDate): Variation {
  const found = built.variations.filter(
    (v) => v.date === date && v.participants.some((p) => p.level === level && p.entityId === entityId),
  );
  const [variation] = found;
  if (found.length !== 1 || variation === undefined) {
    throw new Error(`${found.length} variations of ${level} ${entityId} on ${date}`);
  }
  return variation;
}

/**
 * I9 and I10 as properties of the built variations: every version boundary (except the world's
 * first date) is referenced by a participant of a variation of that date, every referenced
 * version exists with coherent dates; no participant with effect lacks a role. Returns violations.
 */
export function variationPropertyViolations(built: BuiltVariations): string[] {
  const violations: string[] = [];
  const versions = new Map<string, { entityId: number; validFrom: IsoDate; validTo: IsoDate | null }>();
  let start: IsoDate | undefined;
  for (const level of LEVELS) {
    for (const entity of built.entities[level]) {
      for (const v of entity.versions) {
        versions.set(`${level}|${v.id}`, { entityId: entity.id, validFrom: v.validFrom, validTo: v.validTo });
        if (start === undefined || v.validFrom < start) start = v.validFrom;
      }
    }
  }
  const referenced = new Set<string>();
  for (const variation of built.variations) {
    for (const p of variation.participants) {
      if (p.role === null) continue;
      for (const [side, id] of [
        ['before', p.versionBeforeId],
        ['after', p.versionAfterId],
      ] as const) {
        if (id === null) continue;
        const version = versions.get(`${p.level}|${id}`);
        if (version?.entityId !== p.entityId) {
          violations.push(`variation ${variation.id}: ${p.level} version ${id} is not of entity ${p.entityId}`);
        } else if ((side === 'before' ? version.validTo : version.validFrom) !== variation.date) {
          violations.push(
            `variation ${variation.id}: ${p.level} version ${id} does not ${side === 'before' ? 'end' : 'start'} on ${variation.date}`,
          );
        }
        referenced.add(`${p.level}|${side}|${id}`);
      }
    }
  }
  for (const level of LEVELS) {
    for (const entity of built.entities[level]) {
      for (const v of entity.versions) {
        if (v.validFrom !== start && !referenced.has(`${level}|after|${v.id}`)) {
          violations.push(`${level} ${entity.id}: version from ${v.validFrom} opened by no variation`);
        }
        if (v.validTo !== null && !referenced.has(`${level}|before|${v.id}`)) {
          violations.push(`${level} ${entity.id}: version until ${v.validTo} closed by no variation`);
        }
      }
    }
  }
  return violations;
}

/** I14: every event row is represented in a registered variation or dropped with a reason. */
export function accountViolations(built: BuiltVariations): string[] {
  return built.accounts.flatMap((a) => {
    if ((a.variation === null) === (a.dropped === null)) return [`${a.source}#${a.index}: not accounted`];
    if (a.variation !== null && built.registry.get('variation', a.variation) === undefined) {
      return [`${a.source}#${a.index}: variation ${a.variation} not registered`];
    }
    return [];
  });
}
