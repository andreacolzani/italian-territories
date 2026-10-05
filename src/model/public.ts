/**
 * Public data contract (§4, §8.2, §9): zod models of the emitted JSON files.
 *
 * Objects are strict (unknown keys rejected) and their keys are declared in the published order.
 * These schemas check the shape of single records; cross-record rules (sorting, overlaps,
 * references, derived fields) are the invariants of §8 and live in `src/invariants/`.
 */
import { z } from 'zod';
import { compareDates, isIsoDate } from '../dates/index.ts';
import {
  ABBREVIATION_PATTERN,
  ABROAD_EVENT_CODES,
  ANOMALY_LEVELS,
  CADASTRAL_CODE_PATTERN,
  ENTITY_STATUSES,
  ISTAT_CODE_PATTERNS,
  ISTAT_EVENT_CODES,
  LEVELS,
  LINK_KINDS,
  PARTICIPANT_ROLES,
  participantRoleViolations,
  REGION_TYPES,
  UTS_TYPES,
  VARIATION_ORIGINS,
} from './common.ts';

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isIsoDate, 'not an existing calendar date')
  .meta({ format: 'date', description: 'ISO calendar date YYYY-MM-DD, no time or timezone.' });

export const idSchema = z.int().positive().meta({ description: 'Stable positive integer id (registry, §5).' });

/** Unicode NFC, trimmed, non-empty; ISTAT casing preserved (§4.2). */
export const nameSchema = z
  .string()
  .min(1)
  .refine((s) => s === s.trim(), 'must be trimmed')
  .refine((s) => s === s.normalize('NFC'), 'must be Unicode NFC');

const levelSchema = z.enum(LEVELS);
const istatEventCodeSchema = z.enum(ISTAT_EVENT_CODES);

const istatCodeSchema = (level: keyof typeof ISTAT_CODE_PATTERNS) =>
  z
    .string()
    .regex(ISTAT_CODE_PATTERNS[level])
    .meta({ description: 'ISTAT code valid during this version, zero-padded.' });

// ---------------------------------------------------------------------------------------------
// Entities and versions (§4.2)
// ---------------------------------------------------------------------------------------------

export const entityLinkSchema = z
  .strictObject({
    id: idSchema.meta({ description: 'Linked entity of the same level.' }),
    kind: z.enum(LINK_KINDS),
    date: isoDateSchema.meta({ description: 'Date of the variation (first day of the new state).' }),
    variation_id: idSchema,
  })
  .meta({ id: 'Link' });

const versionCommonShape = {
  id: idSchema.meta({ description: 'Stable version id, unique per level.' }),
  valid_from: isoDateSchema.meta({ description: 'First day the version is valid.' }),
  valid_until: isoDateSchema
    .nullable()
    .meta({ description: 'Last day the version is valid (inclusive); null if current.' }),
};

const namesShape = {
  official_name: nameSchema,
  italian_name: nameSchema,
  foreign_name: nameSchema.nullable(),
};

/** `valid_from <= valid_until` (§4.1). Zero-length versions are unrepresentable with an inclusive end. */
function withOrderedInterval<T extends z.ZodType<{ valid_from: string; valid_until: string | null }>>(schema: T): T {
  return schema.refine((v) => v.valid_until === null || compareDates(v.valid_from, v.valid_until) <= 0, {
    message: 'valid_until must not precede valid_from',
    path: ['valid_until'],
  });
}

export const regionVersionSchema = withOrderedInterval(
  z
    .strictObject({
      ...versionCommonShape,
      istat_code: istatCodeSchema('region'),
      ...namesShape,
      type: z.enum(REGION_TYPES),
    })
    .meta({ id: 'RegionVersion' }),
);

export const provinceVersionSchema = withOrderedInterval(
  z
    .strictObject({
      ...versionCommonShape,
      istat_code: istatCodeSchema('province'),
      ...namesShape,
      type: z.enum(UTS_TYPES),
      abbreviation: z
        .string()
        .regex(ABBREVIATION_PATTERN)
        .meta({ description: 'Two uppercase letters; unique per date, reused over time.' }),
      region_id: idSchema.meta({ description: 'Region entity id.' }),
    })
    .meta({ id: 'ProvinceVersion' }),
);

export const municipalityVersionSchema = withOrderedInterval(
  z
    .strictObject({
      ...versionCommonShape,
      istat_code: istatCodeSchema('municipality'),
      cadastral_code: z.string().regex(CADASTRAL_CODE_PATTERN).nullable(),
      ...namesShape,
      province_id: idSchema.meta({ description: 'Province (UTS) entity id.' }),
      region_id: idSchema.meta({ description: "Region entity id; equals the province's region." }),
    })
    .meta({ id: 'MunicipalityVersion' }),
);

function entitySchema<V extends z.ZodType>(versionSchema: V, title: string) {
  return z
    .strictObject({
      id: idSchema.meta({ description: 'Stable entity id, unique per level, never reused.' }),
      istat_origin_id: z.int().positive().nullable().meta({ description: 'ISTAT origin id (root of the chain).' }),
      status: z.enum(ENTITY_STATUSES),
      is_former_italian: z.boolean(),
      predecessors: z.array(entityLinkSchema),
      successors: z.array(entityLinkSchema),
      current_successors: z
        .array(idSchema)
        .refine(isStrictlyAscending, 'must be sorted ascending without duplicates')
        .meta({ description: 'Currently active entities of the same level this entity resolves to.' }),
      versions: z.array(versionSchema).min(1),
    })
    .meta({ id: title });
}

export const regionSchema = entitySchema(regionVersionSchema, 'Region');
export const provinceSchema = entitySchema(provinceVersionSchema, 'Province');
export const municipalitySchema = entitySchema(municipalityVersionSchema, 'Municipality');

// ---------------------------------------------------------------------------------------------
// Variations (§4.3)
// ---------------------------------------------------------------------------------------------

export const participantSchema = z
  .strictObject({
    level: levelSchema,
    territory_id: idSchema.meta({ description: 'Entity id at the given level.' }),
    istat_events: z
      .array(istatEventCodeSchema.exclude(['PV']))
      .refine(isUnique, 'events must not repeat')
      .meta({ description: 'ISTAT events of this entity in the variation; empty for indirect participants.' }),
    abroad: z.boolean().meta({
      description: 'True when the counterpart of one of its events (AS, AN, CE) is a foreign state.',
    }),
    role: z.enum(PARTICIPANT_ROLES),
    version_before_id: idSchema.nullable(),
    version_after_id: idSchema.nullable(),
  })
  .superRefine((p, ctx) => {
    const violations = participantRoleViolations({
      role: p.role,
      istatEvents: p.istat_events,
      versionBeforeId: p.version_before_id,
      versionAfterId: p.version_after_id,
    });
    for (const message of violations) ctx.addIssue({ code: 'custom', message, path: ['role'] });
    if (p.abroad && !p.istat_events.some((e) => (ABROAD_EVENT_CODES as readonly string[]).includes(e))) {
      ctx.addIssue({
        code: 'custom',
        message: `abroad requires one of the events ${ABROAD_EVENT_CODES.join(', ')}`,
        path: ['abroad'],
      });
    }
  })
  .meta({ id: 'Participant' });

export const variationLinkSchema = z
  .strictObject({
    level: levelSchema,
    from: idSchema,
    to: idSchema,
    kind: z.enum(LINK_KINDS),
  })
  .refine((l) => l.from !== l.to, { message: 'a link cannot connect an entity to itself', path: ['to'] })
  .meta({ id: 'VariationLink' });

export const variationSchema = z
  .strictObject({
    id: idSchema.meta({ description: 'Stable variation id, globally unique.' }),
    date: isoDateSchema.meta({ description: 'First day of the new state.' }),
    istat_act_id: z.int().positive().nullable().meta({ description: 'ISTAT act id; null if unknown or inferred.' }),
    origin: z.enum(VARIATION_ORIGINS),
    description: z.string().min(1).nullable(),
    participants: z
      .array(participantSchema)
      .min(1)
      .refine((ps) => isUnique(ps.map((p) => `${p.level}:${p.territory_id}`)), 'participants must not repeat'),
    links: z
      .array(variationLinkSchema)
      .refine((ls) => isUnique(ls.map((l) => `${l.level}:${l.from}:${l.to}`)), 'links must not repeat'),
  })
  .refine((v) => v.origin !== 'inferred' || v.istat_act_id === null, {
    message: 'inferred variations have no ISTAT act id',
    path: ['istat_act_id'],
  })
  .meta({ id: 'Variation' });

// ---------------------------------------------------------------------------------------------
// Anomalies (§8.2)
// ---------------------------------------------------------------------------------------------

export const anomalySchema = z
  .strictObject({
    level: z.enum(ANOMALY_LEVELS),
    code: z
      .string()
      .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
      .meta({ description: 'Stable machine identifier, kebab-case.' }),
    message: z.string().min(1),
    context: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'Anomaly' });

/** Published anomalies are non-blocking by construction: a blocking run never publishes (§8.2). */
export const publishedAnomalySchema = anomalySchema.extend({ level: z.enum(ANOMALY_LEVELS).exclude(['blocking']) });

// ---------------------------------------------------------------------------------------------
// Files (§9)
// ---------------------------------------------------------------------------------------------

export const regionsFileSchema = z.array(regionSchema).meta({ title: 'Regions' });
export const provincesFileSchema = z.array(provinceSchema).meta({ title: 'Provinces' });
export const municipalitiesFileSchema = z.array(municipalitySchema).meta({ title: 'Municipalities' });
export const variationsFileSchema = z.array(variationSchema).meta({ title: 'Variations' });
export const anomaliesFileSchema = z.array(publishedAnomalySchema).meta({ title: 'Anomalies' });

// ---------------------------------------------------------------------------------------------
// Meta (§9)
// ---------------------------------------------------------------------------------------------

/** Request families of §6.1, the sources summarised by `meta.json`. */
export const SOURCE_FAMILIES = ['situas-public-snapshots', 'situas-public-reports', 'situas-internal', 'anpr'] as const;
export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const DATA_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}$/;

const dataVersionSchema = z
  .string()
  .regex(DATA_VERSION_PATTERN)
  .meta({ description: 'Date of the build (its "today") as YYYY.MM.DD.' });

const generatedAtSchema = z.iso.datetime().meta({ description: 'Wall-clock time of the build (UTC).' });

export const sourceSummarySchema = z
  .strictObject({
    fetched_at: isoDateSchema.meta({ description: 'Latest fetch date among the stored responses used.' }),
    content_hash: sha256Schema.meta({
      description: 'SHA-256 of the canonical JSON of the sorted [response key, content hash] pairs.',
    }),
    manifests: z.int().positive().meta({ description: 'Number of stored responses.' }),
  })
  .meta({ id: 'SourceSummary' });

const levelCountsSchema = z
  .strictObject({
    entities: z.int().nonnegative(),
    active: z.int().nonnegative(),
    versions: z.int().nonnegative(),
  })
  .meta({ id: 'LevelCounts' });

export const metaSchema = z
  .strictObject({
    schema_version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .meta({ description: 'Semantic version of the published data contract.' }),
    data_version: dataVersionSchema,
    generated_at: generatedAtSchema,
    sources: z
      .strictObject(
        Object.fromEntries(SOURCE_FAMILIES.map((f) => [f, sourceSummarySchema.nullable()])) as Record<
          SourceFamily,
          z.ZodNullable<typeof sourceSummarySchema>
        >,
      )
      .meta({ description: 'Per request family (§6.1); null when the build used none of its responses.' }),
    counts: z.strictObject({
      regions: levelCountsSchema,
      provinces: levelCountsSchema,
      municipalities: levelCountsSchema,
      variations: z.int().nonnegative(),
    }),
    anomalies: z.strictObject({ warning: z.int().nonnegative(), info: z.int().nonnegative() }),
  })
  .meta({ title: 'Meta' });

// ---------------------------------------------------------------------------------------------
// Changes (§9)
// ---------------------------------------------------------------------------------------------

const retroactiveSchema = z.boolean().meta({
  description: 'True when the item changes the published state of a day before the previous data_version.',
});

const affectedFromSchema = isoDateSchema.meta({ description: 'First day whose published state changes.' });

export const addedItemSchema = z
  .strictObject({ id: idSchema, retroactive: retroactiveSchema })
  .meta({ id: 'AddedItem' });

export const updatedItemSchema = z
  .strictObject({
    id: idSchema,
    fields: z.array(z.string().min(1)).min(1).meta({ description: 'Published fields that changed.' }),
    affected_from: affectedFromSchema
      .nullable()
      .meta({ description: 'First day whose published state changes; null when only undated fields changed.' }),
    retroactive: retroactiveSchema,
  })
  .meta({ id: 'UpdatedItem' });

export const removedItemSchema = z
  .strictObject({ id: idSchema, affected_from: affectedFromSchema, retroactive: retroactiveSchema })
  .meta({ id: 'RemovedItem' });

export const changeSetSchema = z
  .strictObject({
    added: z.array(addedItemSchema),
    updated: z.array(updatedItemSchema),
    removed: z.array(removedItemSchema),
  })
  .meta({ id: 'ChangeSet' });

const levelChangesSchema = z
  .strictObject({ entities: changeSetSchema, versions: changeSetSchema })
  .meta({ id: 'LevelChanges' });

const releaseSchema = z
  .strictObject({ data_version: dataVersionSchema, generated_at: generatedAtSchema })
  .meta({ id: 'Release' });

export const changesSchema = z
  .strictObject({
    from: releaseSchema.nullable().meta({ description: 'The previous release; null for the first one.' }),
    to: releaseSchema,
    retroactive: z.boolean().meta({ description: 'True when any item is retroactive.' }),
    regions: levelChangesSchema,
    provinces: levelChangesSchema,
    municipalities: levelChangesSchema,
    variations: changeSetSchema,
  })
  .meta({ title: 'Changes' });

export type EntityLink = z.output<typeof entityLinkSchema>;
export type RegionVersion = z.output<typeof regionVersionSchema>;
export type ProvinceVersion = z.output<typeof provinceVersionSchema>;
export type MunicipalityVersion = z.output<typeof municipalityVersionSchema>;
export type Region = z.output<typeof regionSchema>;
export type Province = z.output<typeof provinceSchema>;
export type Municipality = z.output<typeof municipalitySchema>;
export type Participant = z.output<typeof participantSchema>;
export type VariationLink = z.output<typeof variationLinkSchema>;
export type Variation = z.output<typeof variationSchema>;
export type Anomaly = z.output<typeof anomalySchema>;
export type SourceSummary = z.output<typeof sourceSummarySchema>;
export type Meta = z.output<typeof metaSchema>;
export type AddedItem = z.output<typeof addedItemSchema>;
export type UpdatedItem = z.output<typeof updatedItemSchema>;
export type RemovedItem = z.output<typeof removedItemSchema>;
export type ChangeSet = z.output<typeof changeSetSchema>;
export type Changes = z.output<typeof changesSchema>;

// ---------------------------------------------------------------------------------------------

function isUnique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function isStrictlyAscending(values: readonly number[]): boolean {
  return values.every((v, i) => i === 0 || (values[i - 1] ?? v) < v);
}
