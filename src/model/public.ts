/** Per-record checks only: cross-record rules are the invariants (§8). */
import { z } from 'zod';
import { compareDates, isIsoDate } from '../dates/index.ts';
import {
  ABBREVIATION_PATTERN,
  CADASTRAL_CODE_PATTERN,
  ENTITY_ID_PATTERN,
  ENTITY_STATUSES,
  ISTAT_CODE_PATTERNS,
  PUBLIC_LINK_KINDS,
  REGION_TYPES,
  UTS_TYPES,
} from './common.ts';

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isIsoDate, 'not an existing calendar date')
  .meta({ format: 'date', description: 'ISO calendar date YYYY-MM-DD, no time or timezone.' });

export const entityIdSchema = z.string().regex(ENTITY_ID_PATTERN).meta({
  description:
    'Stable entity id: reg-, prv- or mun- and 6 Crockford base32 characters; unique in the dataset, never reused.',
});

/** ISTAT casing preserved (§4.2). */
const nameSchema = z
  .string()
  .min(1)
  .refine((s) => s === s.trim(), 'must be trimmed')
  .refine((s) => s === s.normalize('NFC'), 'must be Unicode NFC');

const istatCodeSchema = (level: keyof typeof ISTAT_CODE_PATTERNS) =>
  z
    .string()
    .regex(ISTAT_CODE_PATTERNS[level])
    .meta({ description: 'ISTAT code valid during this version, zero-padded.' });

export const entityLinkSchema = z
  .strictObject({
    id: entityIdSchema.meta({ description: 'Linked entity of the same level.' }),
    kind: z.enum(PUBLIC_LINK_KINDS).meta({
      description:
        'merged_into: the origin ceased and its territory went to this one destination; split_into: the origin ' +
        'ceased and its territory went to several destinations on the same date; detached_into: the origin ' +
        'survived and gave part of its territory to a new entity.',
    }),
    date: isoDateSchema.meta({ description: 'First day of the new state.' }),
  })
  .meta({ id: 'Link' });

const versionCommonShape = {
  valid_from: isoDateSchema.meta({
    description: 'First day the version is valid; with the entity id, it identifies the version.',
  }),
  valid_until: isoDateSchema
    .nullable()
    .meta({ description: 'Last day the version is valid (inclusive); null if current.' }),
};

const namesShape = {
  official_name: nameSchema,
  italian_name: nameSchema,
  foreign_name: nameSchema.nullable(),
};

/** Zero-length versions are unrepresentable with an inclusive end (§4.1). */
function withOrderedInterval<T extends z.ZodType<{ valid_from: string; valid_until: string | null }>>(schema: T): T {
  return schema.refine((v) => v.valid_until === null || compareDates(v.valid_from, v.valid_until) <= 0, {
    message: 'valid_until must not precede valid_from',
    path: ['valid_until'],
  });
}

const prefixed = (prefix: string, description: string) =>
  entityIdSchema.refine((id) => id.startsWith(`${prefix}-`), `must be a ${prefix}- id`).meta({ description });

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
      region_id: prefixed('reg', 'Region entity id.'),
    })
    .meta({ id: 'ProvinceVersion' }),
);

const municipalityVersionSchema = withOrderedInterval(
  z
    .strictObject({
      ...versionCommonShape,
      istat_code: istatCodeSchema('municipality'),
      cadastral_code: z.string().regex(CADASTRAL_CODE_PATTERN).nullable(),
      ...namesShape,
      province_id: prefixed('prv', 'Province (UTS) entity id.'),
      region_id: prefixed('reg', "Region entity id; equals the province's region."),
    })
    .meta({ id: 'MunicipalityVersion' }),
);

const currentSuccessorsSchema = z
  .array(entityIdSchema)
  .refine(isStrictlyAscending, 'must be sorted without duplicates')
  .meta({ description: 'Currently active municipalities this municipality resolves to (municipalities only).' });

function entityShape(prefix: string) {
  return {
    id: prefixed(prefix, 'Stable entity id, unique in the dataset, never reused.'),
    status: z.enum(ENTITY_STATUSES),
    is_former_italian: z.boolean().meta({
      description:
        'True when the entity ceased to exist because it was ceded abroad, directly or because all its ' +
        'successors were. It does not measure losses of territory: partial cessions of entities that ' +
        'continue to exist are not represented.',
    }),
    predecessors: z.array(entityLinkSchema),
    successors: z.array(entityLinkSchema),
  };
}

/** Regions and provinces: no `current_successors` (D46), resolved through the municipalities (§7). */
const regionSchema = z
  .strictObject({ ...entityShape('reg'), versions: z.array(regionVersionSchema).min(1) })
  .meta({ id: 'Region' });
const provinceSchema = z
  .strictObject({ ...entityShape('prv'), versions: z.array(provinceVersionSchema).min(1) })
  .meta({ id: 'Province' });
export const municipalitySchema = z
  .strictObject({
    ...entityShape('mun'),
    current_successors: currentSuccessorsSchema,
    versions: z.array(municipalityVersionSchema).min(1),
  })
  .meta({ id: 'Municipality' });

export const regionsFileSchema = z.array(regionSchema).meta({ title: 'Regions' });
export const provincesFileSchema = z.array(provinceSchema).meta({ title: 'Provinces' });
export const municipalitiesFileSchema = z.array(municipalitySchema).meta({ title: 'Municipalities' });

export type EntityLink = z.output<typeof entityLinkSchema>;
export type RegionVersion = z.output<typeof regionVersionSchema>;
export type ProvinceVersion = z.output<typeof provinceVersionSchema>;
export type MunicipalityVersion = z.output<typeof municipalityVersionSchema>;
export type Region = z.output<typeof regionSchema>;
export type Province = z.output<typeof provinceSchema>;
export type Municipality = z.output<typeof municipalitySchema>;

function isStrictlyAscending(values: readonly string[]): boolean {
  return values.every((v, i) => i === 0 || (values[i - 1] ?? v) < v);
}
