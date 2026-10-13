/**
 * Internal reports of a release (§9, D39): zod models of `reports/variations.json`,
 * `reports/anomalies.json`, `reports/changes.json` and `reports/meta.json`. They are produced by
 * every data release, committed with the data and reviewed in PRs, but not published: no JSON
 * Schema, not in the npm package.
 *
 * Objects are strict and their keys declared in the written order. Versions have no id (D40): a
 * participant references them by `valid_from`, `changes.json` by `(entity_id, valid_from)`.
 */
import { z } from 'zod';
import {
  ABROAD_EVENT_CODES,
  ANOMALY_LEVELS,
  ISTAT_EVENT_CODES,
  LEVELS,
  LINK_KINDS,
  PARTICIPANT_ROLES,
  participantRoleViolations,
  VARIATION_ORIGINS,
} from './common.ts';
import { entityIdSchema, isoDateSchema } from './public.ts';

const levelSchema = z.enum(LEVELS);
const istatEventCodeSchema = z.enum(ISTAT_EVENT_CODES);
const variationIdSchema = z.int().positive();

// ---------------------------------------------------------------------------------------------
// Variations (§4.3)
// ---------------------------------------------------------------------------------------------

export const participantSchema = z
  .strictObject({
    level: levelSchema,
    territory_id: entityIdSchema,
    istat_events: z.array(istatEventCodeSchema.exclude(['PV'])).refine(isUnique, 'events must not repeat'),
    abroad: z.boolean(),
    role: z.enum(PARTICIPANT_ROLES),
    /** `valid_from` of the closed version. */
    version_before: isoDateSchema.nullable(),
    /** `valid_from` of the opened version. */
    version_after: isoDateSchema.nullable(),
  })
  .superRefine((p, ctx) => {
    const violations = participantRoleViolations({
      role: p.role,
      istatEvents: p.istat_events,
      versionBefore: p.version_before,
      versionAfter: p.version_after,
    });
    for (const message of violations) ctx.addIssue({ code: 'custom', message, path: ['role'] });
    if (p.abroad && !p.istat_events.some((e) => (ABROAD_EVENT_CODES as readonly string[]).includes(e))) {
      ctx.addIssue({
        code: 'custom',
        message: `abroad requires one of the events ${ABROAD_EVENT_CODES.join(', ')}`,
        path: ['abroad'],
      });
    }
  });

export const variationLinkSchema = z
  .strictObject({
    level: levelSchema,
    from: entityIdSchema,
    to: entityIdSchema,
    kind: z.enum(LINK_KINDS),
  })
  .refine((l) => l.from !== l.to, { message: 'a link cannot connect an entity to itself', path: ['to'] });

export const variationSchema = z
  .strictObject({
    id: variationIdSchema,
    date: isoDateSchema,
    istat_act_id: z.int().positive().nullable(),
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
  });

// ---------------------------------------------------------------------------------------------
// Anomalies (§8.2)
// ---------------------------------------------------------------------------------------------

export const anomalySchema = z.strictObject({
  level: z.enum(ANOMALY_LEVELS),
  code: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
  message: z.string().min(1),
  context: z.record(z.string(), z.unknown()),
});

/** Anomalies of a release are non-blocking by construction: a blocking run never publishes (§8.2). */
const releaseAnomalySchema = anomalySchema.extend({ level: z.enum(ANOMALY_LEVELS).exclude(['blocking']) });

// ---------------------------------------------------------------------------------------------
// Meta (§9)
// ---------------------------------------------------------------------------------------------

/** Request families of §6.1, the sources summarised by `meta.json`. */
const SOURCE_FAMILIES = ['situas-public-snapshots', 'situas-public-reports', 'situas-internal', 'anpr'] as const;
export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const DATA_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}$/;

/** Date of the build (its "today") as `YYYY.MM.DD`. */
const dataVersionSchema = z.string().regex(DATA_VERSION_PATTERN);

/** Wall-clock time of the build (UTC). */
const generatedAtSchema = z.iso.datetime();

export const sourceSummarySchema = z.strictObject({
  /** Latest fetch date among the stored responses used. */
  fetched_at: isoDateSchema,
  /** SHA-256 of the canonical JSON of the sorted [response key, content hash] pairs. */
  content_hash: sha256Schema,
  /** Number of stored responses. */
  manifests: z.int().positive(),
});

const levelCountsSchema = z.strictObject({
  entities: z.int().nonnegative(),
  active: z.int().nonnegative(),
  versions: z.int().nonnegative(),
});

export const metaSchema = z.strictObject({
  /** Semantic version of the published data contract; its major is the npm major. */
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  data_version: dataVersionSchema,
  generated_at: generatedAtSchema,
  /** Per request family (§6.1); null when the build used none of its responses. */
  sources: z.strictObject(
    Object.fromEntries(SOURCE_FAMILIES.map((f) => [f, sourceSummarySchema.nullable()])) as Record<
      SourceFamily,
      z.ZodNullable<typeof sourceSummarySchema>
    >,
  ),
  counts: z.strictObject({
    regions: levelCountsSchema,
    provinces: levelCountsSchema,
    municipalities: levelCountsSchema,
    variations: z.int().nonnegative(),
  }),
  anomalies: z.strictObject({ warning: z.int().nonnegative(), info: z.int().nonnegative() }),
});

// ---------------------------------------------------------------------------------------------
// Changes (§9)
// ---------------------------------------------------------------------------------------------

/** True when the item changes the published state of a day before the previous data_version. */
const retroactiveSchema = z.boolean();

/** First day whose published state changes. */
const affectedFromSchema = isoDateSchema;

/** The key of the items of a change set: an entity id, a version, a variation id. */
const entityKeyShape = { id: entityIdSchema };
const versionKeyShape = { entity_id: entityIdSchema, valid_from: isoDateSchema };
const variationKeyShape = { id: variationIdSchema };

function changeSetSchema<K extends z.ZodRawShape>(key: K) {
  return z.strictObject({
    added: z.array(z.strictObject({ ...key, retroactive: retroactiveSchema })),
    updated: z.array(
      z.strictObject({
        ...key,
        fields: z.array(z.string().min(1)).min(1),
        /** Null when only undated fields changed. */
        affected_from: affectedFromSchema.nullable(),
        retroactive: retroactiveSchema,
      }),
    ),
    removed: z.array(z.strictObject({ ...key, affected_from: affectedFromSchema, retroactive: retroactiveSchema })),
  });
}

const entityChangeSetSchema = changeSetSchema(entityKeyShape);
const versionChangeSetSchema = changeSetSchema(versionKeyShape);
const variationChangeSetSchema = changeSetSchema(variationKeyShape);

const levelChangesSchema = z.strictObject({ entities: entityChangeSetSchema, versions: versionChangeSetSchema });

const releaseSchema = z.strictObject({ data_version: dataVersionSchema, generated_at: generatedAtSchema });

export const changesSchema = z.strictObject({
  /** The previous release; null for the first one. */
  from: releaseSchema.nullable(),
  to: releaseSchema,
  /** True when any item is retroactive. */
  retroactive: z.boolean(),
  regions: levelChangesSchema,
  provinces: levelChangesSchema,
  municipalities: levelChangesSchema,
  variations: variationChangeSetSchema,
});

// ---------------------------------------------------------------------------------------------
// Files (§9)
// ---------------------------------------------------------------------------------------------

export const variationsFileSchema = z.array(variationSchema);
export const anomaliesFileSchema = z.array(releaseAnomalySchema);

export type Participant = z.output<typeof participantSchema>;
export type VariationLink = z.output<typeof variationLinkSchema>;
export type Variation = z.output<typeof variationSchema>;
export type Anomaly = z.output<typeof anomalySchema>;
export type SourceSummary = z.output<typeof sourceSummarySchema>;
export type Meta = z.output<typeof metaSchema>;
export type Changes = z.output<typeof changesSchema>;

function isUnique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}
