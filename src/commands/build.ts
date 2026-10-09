/**
 * The build of the data commands (§6.6–§6.12, Step 17): from the stored snapshots of the calendar,
 * the event lists and the internal crawl to the derived entities and variations, then the ANPR
 * cross-check and the invariants. It reads no network: every input comes from the store or from
 * the acquisition stages, so `rebuild` reproduces it offline.
 *
 * The order follows §6: identity per level (regions, UTS, municipalities) with registry ids, versions
 * (parents resolved through the timelines of the higher levels; versions have no id, D40),
 * variations with registry ids, overrides, derived fields, ANPR cross-check, invariants.
 */
import { AnomalyCollector } from '../anomalies.ts';
import {
  buildMunicipalityVersions,
  buildProvinceVersions,
  buildRegionVersions,
  buildVariations,
  EntityTimeline,
  internalVariationEvents,
  registerVariations,
  type EventAccount,
  type IdentifiedEntity,
  type VariationLevelInput,
} from '../build/index.ts';
import { calendarDates, type Calendar } from '../calendar/index.ts';
import { crossCheckAnpr, ANPR_ANOMALIES } from '../crosscheck/index.ts';
import { deriveFields } from '../derive/index.ts';
import type { InternalCrawlResult } from '../enrich/index.ts';
import {
  internalIdentity,
  Registry,
  resolveLevelIdentity,
  type InternalDataCause,
  type InternalIdentity,
  type LevelIdentity,
} from '../identity/index.ts';
import {
  checkInvariants,
  existenceOf,
  historicalCodesOf,
  storeSnapshotSets,
  type InvariantEntities,
  type InvariantReport,
} from '../invariants/index.ts';
import type { Level } from '../model/common.ts';
import type { EntityByLevel, Variation } from '../model/internal.ts';
import { loadOverrides, OverrideRun, type AppliedOverride } from '../overrides/index.ts';
import { loadIntervalIndex, type IntervalIndex } from '../resolve/index.ts';
import type { AnprRecord } from '../sources/anpr/index.ts';
import type { InternalReportNumber } from '../sources/situas-internal/index.ts';
import type { EventListsByLevel } from './acquire.ts';
import { silentProgress, type StageProgress } from '../progress.ts';
import type { RunContext } from './context.ts';

export interface BuildInput {
  calendar: Calendar;
  eventLists: EventListsByLevel;
  internal: InternalCrawlResult;
  anpr: AnprRecord[] | null;
  counts: Record<Level, number> | undefined;
}

export interface BuiltDataset {
  registry: Registry;
  entities: InvariantEntities;
  variations: Variation[];
  accounts: EventAccount[];
  overrides: AppliedOverride[];
  invariants: InvariantReport;
  /** The registry recorded retroactive remaps (§5.3). */
  retroactiveRemaps: boolean;
}

export async function buildDataset(
  ctx: RunContext,
  input: BuildInput,
  progress: StageProgress = silentProgress,
): Promise<BuiltDataset> {
  const { store, anomalies, today, logger } = ctx;
  progress.step('interval indexes');
  const registry = await Registry.load(ctx.config.paths.registry);
  const assign = { recordedOn: today, anomalies };
  const dates = calendarDates(input.calendar);

  const indexes = {
    region: await loadIntervalIndex(store, 'region', dates, anomalies),
    province: await loadIntervalIndex(store, 'province', dates, anomalies),
    municipality: await loadIntervalIndex(store, 'municipality', dates, anomalies),
  };
  const internal = internalIdentities(input.internal);
  const internalCause = (level: Level): InternalDataCause =>
    input.internal.failures.some((f) => REPORT_LEVELS[f.item.report] === level && f.cause === 'unavailable')
      ? 'unavailable'
      : 'absent';

  const identify = <L extends Level>(level: L, index: IntervalIndex<L>) => {
    progress.step(`identity: ${level}`);
    const identity = resolveLevelIdentity({
      level,
      index,
      internal: internal[level],
      internalCause: internalCause(level),
      eventLists: input.eventLists[level],
      anomalies,
    });
    const { ids } = registry.assignEntities(level, identity.entities, {
      ...assign,
      internalCause: internalCause(level),
    });
    const entities: IdentifiedEntity<L>[] = identity.entities.map((e) => {
      const id = ids.get(e.key);
      if (id === undefined) throw new Error(`no registry id for ${level} ${e.key}`);
      return { ...e, id };
    });
    logger.info('identity done', { territoryLevel: level, entities: entities.length });
    return { identity, entities };
  };
  const regions = identify('region', indexes.region);
  const provinces = identify('province', indexes.province);
  const municipalities = identify('municipality', indexes.municipality);

  progress.step('versions');
  // Overrides are applied by the version builder, day by day, before the merge (§6.10).
  const overrideRun = new OverrideRun(await loadOverrides(ctx.config.paths.overrides));
  const regionTimeline = EntityTimeline.of('region', regions.entities);
  const provinceTimeline = EntityTimeline.of('province', provinces.entities);
  const versions = {
    region: buildRegionVersions({ entities: regions.entities, anomalies }),
    province: buildProvinceVersions({
      entities: provinces.entities,
      regions: regionTimeline,
      municipalities: indexes.municipality,
      overrides: overrideRun,
      anomalies,
    }),
    municipality: buildMunicipalityVersions({
      entities: municipalities.entities,
      provinces: provinceTimeline,
      regions: regionTimeline,
      anomalies,
    }),
  };

  const identities = { region: regions, province: provinces, municipality: municipalities };
  const levelInput = <L extends Level>(level: L): VariationLevelInput<L> => {
    const { identity, entities } = identities[level] as unknown as {
      identity: LevelIdentity<L>;
      entities: IdentifiedEntity<L>[];
    };
    return {
      entities: versions[level] as EntityByLevel[L][],
      identified: entities,
      identity,
      eventLists: input.eventLists[level],
      internal: internalVariationEvents(input.internal[level]),
    };
  };
  const inferredDates = new Set(
    [...input.calendar.dates]
      .filter(([, sources]) => sources.length === 1 && sources[0] === 'inferred')
      .map(([d]) => d),
  );
  progress.step('variations');
  const built = buildVariations({
    levels: {
      region: levelInput('region'),
      province: levelInput('province'),
      municipality: levelInput('municipality'),
    },
    start: input.calendar.start,
    inferredDates,
    anomalies,
  });
  const { variations } = registerVariations(registry, built.variations, assign);

  progress.step('derived fields');
  const overridden = { provinces: versions.province, applied: overrideRun.finish(anomalies) };
  const entities = {
    region: deriveFields({ level: 'region', entities: versions.region, variations, anomalies }),
    province: deriveFields({ level: 'province', entities: overridden.provinces, variations, anomalies }),
    municipality: deriveFields({ level: 'municipality', entities: versions.municipality, variations, anomalies }),
  };

  for (const level of ['region', 'province', 'municipality'] as const) {
    const list = entities[level] as readonly { successors: { kind: string }[] }[];
    ctx.summary.derived[level] = {
      split_into: list.reduce((n, e) => n + e.successors.filter((l) => l.kind === 'split_into').length, 0),
    };
  }

  if (input.anpr !== null) {
    progress.step('ANPR cross-check');
    crossCheckAnpr({
      anpr: { rows: input.anpr },
      municipalities: entities.municipality,
      provinces: overridden.provinces,
      anomalies,
    });
    recordGolden14(ctx, entities.municipality, anomalies);
  }

  progress.step('invariants');
  const invariants = await checkInvariants(
    {
      start: input.calendar.start,
      today,
      entities,
      variations,
      existence: existenceOf({
        region: regions.entities,
        province: provinces.entities,
        municipality: municipalities.entities,
      }),
      historicalCodes: historicalCodesOf(overridden.provinces),
      snapshots: storeSnapshotSets(store, { until: today }),
      overrides: overridden.applied,
      ...(input.counts === undefined ? {} : { counts: input.counts }),
      accounts: built.accounts,
      variationIdOf: (key) => registry.variationId(key),
    },
    anomalies,
    { now: ctx.runtime.now },
  );
  for (const r of invariants.results) {
    if (r.durationMs !== undefined) ctx.summary.invariantDurations.set(r.id, r.durationMs);
  }
  ctx.summary.i12 = invariants.results.find((r) => r.id === 'I12')?.durationMs ?? null;
  ctx.summary.invariants = invariants;

  return {
    registry,
    entities,
    variations,
    accounts: built.accounts,
    overrides: overridden.applied,
    invariants,
    retroactiveRemaps: registry.retroactive,
  };
}

/** The level of each internal report (lists, events, details). */
const REPORT_LEVELS: Record<InternalReportNumber, Level> = {
  1: 'region',
  2: 'province',
  3: 'municipality',
  4: 'region',
  5: 'province',
  6: 'municipality',
  7: 'region',
  8: 'province',
  9: 'municipality',
};

/** The internal identity of each crawled level (the crawl's events, by their typed record). */
function internalIdentities(crawl: InternalCrawlResult): Record<Level, InternalIdentity | null> {
  return {
    region:
      crawl.region === null
        ? null
        : internalIdentity(
            crawl.region.graph,
            crawl.region.complete,
            ({ event }) => ({ ...event, recordId: event.originId }),
            'r4:region-events',
          ),
    province:
      crawl.province === null
        ? null
        : internalIdentity(
            crawl.province.graph,
            crawl.province.complete,
            ({ event }) => ({ ...event, recordId: event.utsId }),
            'r5:uts-events',
          ),
    municipality:
      crawl.municipality === null
        ? null
        : internalIdentity(
            crawl.municipality.graph,
            crawl.municipality.complete,
            ({ event }) => ({ ...event, recordId: event.originId }),
            'r6:municipality-events',
          ),
  };
}

/** Golden-14 (§11.3): municipalities absent from ANPR, and how many of them are suppressed. */
function recordGolden14(
  ctx: RunContext,
  municipalities: readonly { id: string; status: string }[],
  anomalies: AnomalyCollector,
): void {
  const missing = anomalies.list('info').find((a) => a.code === ANPR_ANOMALIES.missingEntity);
  const items = ((missing?.context as { items?: { entityId?: unknown }[] } | undefined)?.items ?? []).map(
    (i) => i.entityId,
  );
  const suppressed = new Set(municipalities.filter((m) => m.status === 'suppressed').map((m) => m.id));
  ctx.summary.golden14 = {
    anpr_missing_entity: items.length,
    anpr_missing_suppressed: items.filter((id) => typeof id === 'string' && suppressed.has(id)).length,
  };
}
