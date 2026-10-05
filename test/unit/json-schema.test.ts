import { describe, expect, it } from 'vitest';
import { generateJsonSchema, generateJsonSchemas, PUBLIC_FILE_MODELS } from '../../src/model/json-schema.ts';

interface ObjectSchema {
  properties: Record<string, { pattern?: string; enum?: string[]; type?: string }>;
  required: string[];
  additionalProperties: boolean;
}

function def(schema: Record<string, unknown>, name: string): ObjectSchema {
  const defs = schema.$defs as Record<string, ObjectSchema> | undefined;
  const found = defs?.[name];
  if (!found) throw new Error(`missing $defs.${name}`);
  return found;
}

describe('JSON Schema generation', () => {
  it('produces one draft 2020-12 schema per published file', () => {
    const schemas = generateJsonSchemas();
    expect(Object.keys(schemas)).toEqual([
      'regions.schema.json',
      'provinces.schema.json',
      'municipalities.schema.json',
      'variations.schema.json',
      'anomalies.schema.json',
      'changes.schema.json',
      'meta.schema.json',
    ]);
    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.type).toBe(['changes.schema.json', 'meta.schema.json'].includes(name) ? 'object' : 'array');
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(generateJsonSchemas())).toBe(JSON.stringify(generateJsonSchemas()));
  });

  it('carries the structural constraints of the zod models', () => {
    const provinces = generateJsonSchema('provinces');
    const version = def(provinces, 'ProvinceVersion');
    expect(version.additionalProperties).toBe(false);
    expect(Object.keys(version.properties)).toEqual([
      'id',
      'valid_from',
      'valid_until',
      'istat_code',
      'official_name',
      'italian_name',
      'foreign_name',
      'type',
      'abbreviation',
      'region_id',
    ]);
    expect(version.required).toEqual(Object.keys(version.properties));
    expect(version.properties.abbreviation?.pattern).toBe('^[A-Z]{2}$');
    expect(version.properties.istat_code?.pattern).toBe('^\\d{3}$');
    expect(version.properties.valid_from?.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');

    const entity = def(provinces, 'Province');
    expect(entity.properties.status?.enum).toEqual(['active', 'suppressed']);
    expect(def(provinces, 'Link').properties.kind?.enum).toEqual(['merged_into', 'detached_into', 'transferred_to']);

    const participant = def(generateJsonSchema('variations'), 'Participant');
    expect(participant.properties.role?.enum).toContain('territory_changed');
    expect(participant.properties.abroad?.type).toBe('boolean');
    expect(participant.required).toContain('abroad');
  });

  it('covers every public file model', () => {
    for (const name of Object.keys(PUBLIC_FILE_MODELS) as (keyof typeof PUBLIC_FILE_MODELS)[]) {
      expect(() => generateJsonSchema(name)).not.toThrow();
    }
  });
});
