/**
 * Worlds for variation tests: the version worlds of Step 10, then the variation builder (Step 11)
 * over their event lists and internal events.
 */
import { AnomalyCollector } from '../../src/anomalies.ts';
import {
  buildVariations,
  registerVariations,
  type EventAccount,
  type InternalVariationEvent,
  type VariationLevelInput,
} from '../../src/build/index.ts';
import { compareDates, type IsoDate } from '../../src/dates/index.ts';
import { internalIdentity, type IdentityGraph } from '../../src/identity/index.ts';
import { LEVELS, type EntityId, type IstatEventCode, type Level } from '../../src/model/common.ts';
import type { EntityByLevel, Variation } from '../../src/model/internal.ts';
import type { Override } from '../../src/overrides/index.ts';
import { IntervalIndex } from '../../src/resolve/index.ts';
import type { InternalMunicipalityEvent, InternalUtsEvent } from '../../src/sources/situas-internal/index.ts';
import { snapshotIndex } from './identity.ts';
import { decodedRows } from './internal.ts';
import { withSources } from './sources.ts';
import { buildWorld, type BuiltWorld, type VersionWorld } from './versions.ts';

export interface VariationWorld extends VersionWorld {
  /** Internal events per level (r4/r5/r6 with r7/r8 details). */
  internalEvents?: Partial<Record<Level, InternalVariationEvent[]>>;
  /** Calendar dates of inferred breakpoints. */
  inferredDates?: IsoDate[];
}

export interface BuiltVariations extends BuiltWorld {
  /** Entities with their versions. */
  entities: { [L in Level]: EntityByLevel[L][] };
  variations: Variation[];
  accounts: EventAccount[];
  /** Anomalies of the variation builder only. */
  variationAnomalies: AnomalyCollector;
}

export async function buildVariationWorld(world: VariationWorld): Promise<BuiltVariations> {
  const built = await buildWorld(world);
  const assign = { recordedOn: '2026-10-05', anomalies: new AnomalyCollector() };
  const entities = { region: built.region, province: built.province, municipality: built.municipality };
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
  E extends {
    event: IstatEventCode;
    date: IsoDate;
    code: string;
    actId: number;
    description: string | null;
    originId: number;
  },
>(graph: IdentityGraph<E>, details = new Map<string, InternalVariationEvent['details']>()): InternalVariationEvent[] {
  return graph.components.flatMap((component) =>
    component.events.map((e) => ({
      root: component.root,
      event: e.event,
      date: e.date,
      code: e.code,
      actId: e.actId,
      description: e.description,
      details: details.get(detailKey(e.originId, e.event, e.actId)) ?? null,
    })),
  );
}

/** r8 fixtures (`<id_uts_origine>_<event>_<act>.json`) by origin id, event and act. */
export async function utsDetails(files: readonly string[]): Promise<Map<string, InternalVariationEvent['details']>> {
  return eventDetails('utsEventDetails', 'r8-uts-event-details', files);
}

/** r7 fixtures (`<id_regione_origine>_<event>_<act>.json`) by origin id, event and act. */
export async function regionDetails(files: readonly string[]): Promise<Map<string, InternalVariationEvent['details']>> {
  return eventDetails('regionEventDetails', 'r7-region-event-details', files);
}

/** r9 fixtures (`<id_origine>_<event>_<act>.json`) by origin id, event and act. */
export async function municipalityDetails(
  files: readonly string[],
): Promise<Map<string, InternalVariationEvent['details']>> {
  return eventDetails('municipalityEventDetails', 'r9-municipality-event-details', files);
}

async function eventDetails(
  report: 'regionEventDetails' | 'utsEventDetails' | 'municipalityEventDetails',
  dir: string,
  files: readonly string[],
): Promise<Map<string, InternalVariationEvent['details']>> {
  const details = new Map<string, InternalVariationEvent['details']>();
  for (const file of files) {
    const [originId, event, actId] = file.replace(/\.json$/, '').split('_');
    const rows = await decodedRows(report, `${dir}/${file}`);
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
export function variationOf(built: BuiltVariations, level: Level, entityId: EntityId, date: IsoDate): Variation {
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
  const versions = new Map<string, { entityId: EntityId; validFrom: IsoDate; validTo: IsoDate | null }>();
  let start: IsoDate | undefined;
  for (const level of LEVELS) {
    for (const entity of built.entities[level]) {
      for (const v of entity.versions) {
        versions.set(`${level}|${entity.id}|${v.validFrom}`, {
          entityId: entity.id,
          validFrom: v.validFrom,
          validTo: v.validTo,
        });
        if (start === undefined || v.validFrom < start) start = v.validFrom;
      }
    }
  }
  const referenced = new Set<string>();
  for (const variation of built.variations) {
    for (const p of variation.participants) {
      if (p.role === null) continue;
      for (const [side, id] of [
        ['before', p.versionBefore],
        ['after', p.versionAfter],
      ] as const) {
        if (id === null) continue;
        const version = versions.get(`${p.level}|${p.entityId}|${id}`);
        if (version === undefined) {
          violations.push(`variation ${variation.id}: ${p.level} entity ${p.entityId} has no version from ${id}`);
        } else if ((side === 'before' ? version.validTo : version.validFrom) !== variation.date) {
          violations.push(
            `variation ${variation.id}: ${p.level} version from ${id} does not ${side === 'before' ? 'end' : 'start'} on ${variation.date}`,
          );
        }
        referenced.add(`${p.level}|${p.entityId}|${side}|${id}`);
      }
    }
  }
  for (const level of LEVELS) {
    for (const entity of built.entities[level]) {
      for (const v of entity.versions) {
        if (v.validFrom !== start && !referenced.has(`${level}|${entity.id}|after|${v.validFrom}`)) {
          violations.push(`${level} ${entity.id}: version from ${v.validFrom} opened by no variation`);
        }
        if (v.validTo !== null && !referenced.has(`${level}|${entity.id}|before|${v.validFrom}`)) {
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
    if (a.variation !== null && built.registry.variationId(a.variation) === undefined) {
      return [`${a.source}#${a.index}: variation ${a.variation} not registered`];
    }
    return [];
  });
}

function loadEventLists() {
  return withSources(async ({ situasPublic }) => {
    const list = async <L extends Level>(level: L, pfun: number, to: IsoDate) =>
      (await situasPublic.fetchEventList(level, pfun as never, '1861-03-17', to)).data;
    return {
      municipality: {
        98: await list('municipality', 98, '2026-09-30'),
        100: await list('municipality', 100, '2026-10-01'),
        103: await list('municipality', 103, '2026-10-01'),
        104: await list('municipality', 104, '2026-09-30'),
        105: await list('municipality', 105, '2026-09-30'),
      },
      province: {
        112: await list('province', 112, '2026-10-01'),
        113: await list('province', 113, '2026-10-01'),
        114: await list('province', 114, '2026-10-01'),
      },
      region: {
        106: await list('region', 106, '2026-10-01'),
        107: await list('region', 107, '2026-10-01'),
        108: await list('region', 108, '2026-10-01'),
      },
    };
  });
}

let loaded: ReturnType<typeof loadEventLists> | undefined;

/** The full-range event list fixtures of every level (loaded once). */
export function eventLists(): ReturnType<typeof loadEventLists> {
  loaded ??= loadEventLists();
  return loaded;
}

/** The lists of a level with only the rows of `dates`. */
async function listsOn(level: Level, dates: readonly IsoDate[]): Promise<Record<number, unknown[]>> {
  const byPfun = (await eventLists())[level] as Record<number, { date: IsoDate }[]>;
  return Object.fromEntries(Object.entries(byPfun).map(([pfun, rows]) => [pfun, onDates(rows, dates)]));
}

export interface WorldOptions {
  /** Codes kept per level; `false`: an empty level (no snapshots of those dates). */
  codes?: { region?: string[] | false; province?: string[] | false; municipality?: string[] };
  municipalities?: IdentityGraph<InternalMunicipalityEvent>;
  /** r9 fixtures of `municipalities`' events (the ambiguous ones, §6.8). */
  municipalityDetails?: string[];
  provinces?: { graph: IdentityGraph<InternalUtsEvent>; details?: string[] };
  overrides?: readonly Override[];
  /** Municipality event lists replacing the full-range fixtures (e.g. a list of another download). */
  municipalityLists?: Record<number, readonly { date: IsoDate }[]>;
  /** Internal municipality events added to those of `municipalities`. */
  extraMunicipalityEvents?: InternalVariationEvent[];
}

/**
 * A world of the real snapshots of `dates` (optionally reduced to some codes), with the event rows and
 * internal events of every date but the first.
 */
export async function fixtureWorld(dates: readonly IsoDate[], options: WorldOptions = {}): Promise<BuiltVariations> {
  const { codes = {} } = options;
  const eventDates = dates.slice(1);
  const indexes = await withSources(async ({ situasPublic }) => ({
    region:
      codes.region === false
        ? new IntervalIndex('region', new Map())
        : await snapshotIndex(situasPublic, 'region', dates, codes.region),
    province:
      codes.province === false
        ? new IntervalIndex('province', new Map())
        : await snapshotIndex(situasPublic, 'province', dates, codes.province),
    municipality: await snapshotIndex(situasPublic, 'municipality', dates, codes.municipality),
  }));
  const { municipalities, provinces } = options;
  return buildVariationWorld({
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    region: { index: indexes.region, eventLists: await listsOn('region', eventDates) },
    province: {
      index: indexes.province,
      eventLists: await listsOn('province', eventDates),
      internal:
        provinces === undefined
          ? null
          : internalIdentity(provinces.graph, true, (e) => ({ ...e, recordId: e.utsId }), 'r5:uts-events'),
    },
    municipality: {
      index: indexes.municipality,
      eventLists:
        options.municipalityLists === undefined
          ? await listsOn('municipality', eventDates)
          : Object.fromEntries(
              Object.entries(options.municipalityLists).map(([pfun, rows]) => [pfun, onDates(rows, eventDates)]),
            ),
      internal:
        municipalities === undefined
          ? null
          : internalIdentity(municipalities, false, (e) => ({ ...e, recordId: e.originId }), 'r6:municipality-events'),
    },
    internalEvents: {
      ...(municipalities === undefined
        ? {}
        : {
            municipality: onDates(
              [
                ...variationEvents(municipalities, await municipalityDetails(options.municipalityDetails ?? [])),
                ...(options.extraMunicipalityEvents ?? []),
              ],
              eventDates,
            ),
          }),
      ...(provinces === undefined
        ? {}
        : {
            province: onDates(variationEvents(provinces.graph, await utsDetails(provinces.details ?? [])), eventDates),
          }),
    },
  });
}
