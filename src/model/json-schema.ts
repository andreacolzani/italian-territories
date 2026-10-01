/**
 * JSON Schemas of the published files (§9, `dist/schema/*.schema.json`), generated from the zod
 * models so that the two can never drift. Refinements that JSON Schema cannot express (calendar
 * validity, role consistency, uniqueness) are enforced by the zod models and the invariants only.
 */
import { z } from 'zod';
import {
  anomaliesFileSchema,
  municipalitiesFileSchema,
  provincesFileSchema,
  regionsFileSchema,
  variationsFileSchema,
} from './public.ts';

/** Published data file (without extension) → its zod model. */
export const PUBLIC_FILE_MODELS = {
  regions: regionsFileSchema,
  provinces: provincesFileSchema,
  municipalities: municipalitiesFileSchema,
  variations: variationsFileSchema,
  anomalies: anomaliesFileSchema,
} as const;

export type PublicFileName = keyof typeof PUBLIC_FILE_MODELS;

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
