/**
 * JSON Schemas of the published files (§9, `dist/schema/*.schema.json`), generated from the zod
 * models so that the two can never drift. Refinements that JSON Schema cannot express (calendar
 * validity, uniqueness) are enforced by the zod models and the invariants only.
 *
 * Only the three entity files are published (D39); the internal reports have zod models
 * (`REPORT_FILE_MODELS`) but no JSON Schema.
 */
import { z } from 'zod';
import { municipalitiesFileSchema, provincesFileSchema, regionsFileSchema } from './public.ts';
import { anomaliesFileSchema, changesSchema, metaSchema, variationsFileSchema } from './reports.ts';

/** Published data file (without extension) → its zod model. */
export const PUBLIC_FILE_MODELS = {
  regions: regionsFileSchema,
  provinces: provincesFileSchema,
  municipalities: municipalitiesFileSchema,
} as const;

/** Internal report file of a release (without extension) → its zod model. */
export const REPORT_FILE_MODELS = {
  variations: variationsFileSchema,
  anomalies: anomaliesFileSchema,
  changes: changesSchema,
  meta: metaSchema,
} as const;

export type PublicFileName = keyof typeof PUBLIC_FILE_MODELS;
export type ReportFileName = keyof typeof REPORT_FILE_MODELS;
export type ReleaseFileName = PublicFileName | ReportFileName;

/** Every file of a release → its zod model. */
export const RELEASE_FILE_MODELS = { ...PUBLIC_FILE_MODELS, ...REPORT_FILE_MODELS } as const;

export type JsonSchema = Record<string, unknown>;

export function schemaFileName(name: PublicFileName): string {
  return `${name}.schema.json`;
}

export function generateJsonSchema(name: PublicFileName): JsonSchema {
  return z.toJSONSchema(PUBLIC_FILE_MODELS[name], { target: 'draft-2020-12', io: 'output' });
}

/** `<name>.schema.json` → schema, in a fixed order. */
export function generateJsonSchemas(): Record<string, JsonSchema> {
  const names = Object.keys(PUBLIC_FILE_MODELS) as PublicFileName[];
  return Object.fromEntries(names.map((name) => [schemaFileName(name), generateJsonSchema(name)]));
}
