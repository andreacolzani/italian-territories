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
    ]);
    for (const schema of Object.values(schemas)) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.type).toBe('array');
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
    expect(Object.keys(entity.properties)).not.toContain('partially_ceded');
    // current_successors only for municipalities (D46).
    expect(Object.keys(entity.properties)).not.toContain('current_successors');
    expect(Object.keys(def(generateJsonSchema('regions'), 'Region').properties)).not.toContain('current_successors');
    expect(Object.keys(def(generateJsonSchema('municipalities'), 'Municipality').properties)).toContain(
      'current_successors',
    );
    expect((entity.properties.is_former_italian as { description?: string }).description).toMatch(/ceded abroad/);
    expect(Object.keys(entity.properties)).not.toContain('istat_origin_id');
    expect(def(provinces, 'Link').properties.kind?.enum).toEqual(['merged_into', 'split_into', 'detached_into']);
    expect(Object.keys(def(provinces, 'Link').properties)).toEqual(['id', 'kind', 'date']);
    expect(def(provinces, 'Link').properties.id?.pattern).toBe('^(reg|prv|mun)-[0-9A-HJKMNP-TV-Z]{6}$');
  });

  it('covers every public file model', () => {
    for (const name of Object.keys(PUBLIC_FILE_MODELS) as (keyof typeof PUBLIC_FILE_MODELS)[]) {
      expect(() => generateJsonSchema(name)).not.toThrow();
    }
  });
});
