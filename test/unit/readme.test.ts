import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateJsonSchemas, type JsonSchema } from '../../src/model/json-schema.ts';
import { readmeDate } from '../../scripts/release.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const readme = await readFile(join(ROOT, 'README.md'), 'utf8');

interface DocumentedField {
  type: string;
  semantics: string;
}

/** The rows of the README tables whose first cell is a field name in backticks. */
function documentedFields(text: string): Map<string, DocumentedField[]> {
  const fields = new Map<string, DocumentedField[]>();
  for (const line of text.split('\n')) {
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim());
    const name = /^`([a-z_]+)`$/.exec(cells[0] ?? '')?.[1];
    if (name === undefined || cells.length < 3) continue;
    fields.set(name, [...(fields.get(name) ?? []), { type: cells[1] ?? '', semantics: cells[2] ?? '' }]);
  }
  return fields;
}

/** Every property of every object definition of the published JSON Schemas, with its enum values. */
function publishedFields(): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const schema of Object.values(generateJsonSchemas())) {
    const defs = (schema.$defs ?? {}) as Record<string, JsonSchema>;
    for (const def of Object.values(defs)) {
      const properties = (def.properties ?? {}) as Record<string, JsonSchema>;
      for (const [name, property] of Object.entries(properties)) {
        const values = Array.isArray(property.enum) ? property.enum.map(String) : [];
        fields.set(name, [...new Set([...(fields.get(name) ?? []), ...values])]);
      }
    }
  }
  return fields;
}

describe('README', () => {
  it('documents every public field with type and semantics', () => {
    const documented = documentedFields(readme);
    const published = publishedFields();
    expect(published.size).toBeGreaterThan(10);
    for (const name of published.keys()) {
      const rows = documented.get(name) ?? [];
      expect(rows, `field ${name} is not documented in a README table`).not.toEqual([]);
      for (const row of rows) {
        expect(row.type, `type of ${name}`).not.toBe('');
        expect(row.semantics, `semantics of ${name}`).not.toBe('');
      }
    }
  });

  it('documents every value of the published enums', () => {
    for (const [name, values] of publishedFields()) {
      for (const value of values) {
        expect(readme.includes(`"${value}"`), `value ${value} of ${name}`).toBe(true);
      }
    }
  });

  it('carries the date of the data between its markers', async () => {
    const meta = JSON.parse(await readFile(join(ROOT, 'reports', 'meta.json'), 'utf8')) as { data_version: string };
    expect(readmeDate(readme)).toBe(meta.data_version.replaceAll('.', '-'));
  });
});
