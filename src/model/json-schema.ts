/**
 * Generated from the zod models so the two never drift; refinements JSON Schema cannot express
 * (calendar validity, uniqueness) live only in zod and the invariants. The internal reports get no
 * JSON Schema (D39).
 */
import { z } from 'zod';
import { municipalitiesFileSchema, provincesFileSchema, regionsFileSchema } from './public.ts';
import { anomaliesFileSchema, changesSchema, metaSchema, variationsFileSchema } from './reports.ts';

export const PUBLIC_FILE_MODELS = {
  regions: regionsFileSchema,
  provinces: provincesFileSchema,
  municipalities: municipalitiesFileSchema,
} as const;

export const REPORT_FILE_MODELS = {
  variations: variationsFileSchema,
  anomalies: anomaliesFileSchema,
  changes: changesSchema,
  meta: metaSchema,
} as const;

export type PublicFileName = keyof typeof PUBLIC_FILE_MODELS;
export type ReportFileName = keyof typeof REPORT_FILE_MODELS;
export type ReleaseFileName = PublicFileName | ReportFileName;

export const RELEASE_FILE_MODELS = { ...PUBLIC_FILE_MODELS, ...REPORT_FILE_MODELS } as const;

export type JsonSchema = Record<string, unknown>;

export function schemaFileName(name: PublicFileName): string {
  return `${name}.schema.json`;
}

export function generateJsonSchema(name: PublicFileName): JsonSchema {
  return z.toJSONSchema(PUBLIC_FILE_MODELS[name], { target: 'draft-2020-12', io: 'output' });
}

export function generateJsonSchemas(): Record<string, JsonSchema> {
  const names = Object.keys(PUBLIC_FILE_MODELS) as PublicFileName[];
  return Object.fromEntries(names.map((name) => [schemaFileName(name), generateJsonSchema(name)]));
}
