import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitDataset } from '../../src/emit/index.ts';
import { readTextIfExists } from '../../src/store/index.ts';
import { withTempDir } from '../helpers/http.ts';
import { baseline } from '../helpers/invariants.ts';
import { publishedSchemaViolations } from '../helpers/json-schema.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'dist');
const published = (await readTextIfExists(join(ROOT, 'reports', 'meta.json'))) !== undefined;
const SOURCES = {
  'situas-public-snapshots': { fetched_at: '2026-10-01', content_hash: 'a'.repeat(64), manifests: 3 },
  'situas-public-reports': null,
  'situas-internal': null,
  anpr: { fetched_at: '2026-10-02', content_hash: 'b'.repeat(64), manifests: 1 },
};

describe('published files against the published JSON Schemas (§9)', () => {
  it('an emitted dataset validates against the schemas it publishes', async () => {
    await withTempDir(async (dir) => {
      await emitDataset({
        dirs: { dist: join(dir, 'dist'), reports: join(dir, 'reports') },
        world: baseline(),
        anomalies: [{ level: 'info', code: 'anpr-missing-entity', message: 'm', context: { count: 1 } }],
        previous: null,
        generatedAt: '2026-01-01T04:00:00Z',
        today: '2026-01-01',
        sources: SOURCES,
      });
      expect(await publishedSchemaViolations(join(dir, 'dist'))).toEqual([]);
    });
  });

  it('the schemas reject what the public models reject', async () => {
    await withTempDir(async (dir) => {
      await emitDataset({
        dirs: { dist: join(dir, 'dist'), reports: join(dir, 'reports') },
        world: baseline(),
        anomalies: [],
        previous: null,
        generatedAt: '2026-01-01T04:00:00Z',
        today: '2026-01-01',
        sources: SOURCES,
      });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, 'dist', 'regions.json'), '[{"id": 1, "extra": true}]\n');
      await writeFile(join(dir, 'dist', 'provinces.json'), '[{"id": "prv-00000I"}]\n');
      const violations = await publishedSchemaViolations(join(dir, 'dist'));
      expect(violations.some((v) => v.startsWith('regions.json'))).toBe(true);
      expect(violations.some((v) => v.startsWith('provinces.json'))).toBe(true);
    });
  });

  it.skipIf(!published)('every file of dist/ validates against the JSON Schema published next to it', async () => {
    expect(await publishedSchemaViolations(DIST)).toEqual([]);
  });
});
