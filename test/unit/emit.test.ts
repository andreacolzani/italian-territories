import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emitDataset,
  EmitError,
  loadPublishedDataset,
  serialize,
  sourceSummaries,
  summariseManifests,
  type EmitOptions,
  type ReleaseDirs,
  type SourceSummaries,
} from '../../src/emit/index.ts';
import { canonicalJson, sha256 } from '../../src/http/index.ts';
import { generateJsonSchemas } from '../../src/model/json-schema.ts';
import { reportUrls } from '../../src/sources/situas-internal/index.ts';
import { Store } from '../../src/store/index.ts';
import { withTempDir } from '../helpers/http.ts';
import { at, baseline, entityOf, M, mut } from '../helpers/invariants.ts';

const SOURCES: SourceSummaries = {
  'situas-public-snapshots': { fetched_at: '2026-10-01', content_hash: 'a'.repeat(64), manifests: 3 },
  'situas-public-reports': null,
  'situas-internal': null,
  anpr: null,
};

const ANOMALIES: EmitOptions['anomalies'] = [
  { level: 'info', code: 'anpr-missing-entity', message: 'missing', context: { count: 1 } },
  { level: 'warning', code: 'inferred-breakpoint', message: 'inferred', context: { date: '1900-01-01' } },
];

function dirs(dir: string): ReleaseDirs {
  return { dist: join(dir, 'dist'), reports: join(dir, 'reports') };
}

function options(dir: string, over: Partial<EmitOptions> = {}): EmitOptions {
  return {
    dirs: dirs(dir),
    world: baseline(),
    anomalies: ANOMALIES,
    previous: null,
    generatedAt: '2026-01-01T04:00:00Z',
    today: '2026-01-01',
    sources: SOURCES,
    ...over,
  };
}

async function filesOf(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  const texts = await Promise.all(
    files.map(async (f): Promise<[string, string]> => [
      f.slice(dir.length + 1).replaceAll('\\', '/'),
      await readFile(f, 'utf8'),
    ]),
  );
  return Object.fromEntries(texts.sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe('emitDataset (§6.12, §9)', () => {
  it('writes the three data files and their schemas to dist/, the reports to reports/, meta last', async () => {
    await withTempDir(async (dir) => {
      const result = await emitDataset(options(dir));
      expect(result.kind).toBe('data');
      if (result.kind === 'unchanged') return;
      expect(result.files.at(-1)).toBe('reports/meta.json');
      expect(result.files).toEqual([
        'regions.json',
        'provinces.json',
        'municipalities.json',
        'schema/regions.schema.json',
        'schema/provinces.schema.json',
        'schema/municipalities.schema.json',
        'reports/variations.json',
        'reports/anomalies.json',
        'reports/changes.json',
        'reports/meta.json',
      ]);
      expect(Object.keys(generateJsonSchemas())).toEqual([
        'regions.schema.json',
        'provinces.schema.json',
        'municipalities.schema.json',
      ]);
      const files = await filesOf(dir);
      expect(Object.keys(files).sort()).toEqual(
        result.files.map((f) => (f.startsWith('reports/') ? f : `dist/${f}`)).sort(),
      );
      for (const text of Object.values(files)) {
        expect(text.endsWith('}\n') || text.endsWith(']\n')).toBe(true);
        expect(text.charCodeAt(0)).not.toBe(0xfeff);
        expect(text).not.toContain('\r');
      }
      expect(JSON.parse(files['reports/meta.json'] ?? '')).toEqual({
        schema_version: '1.0.0',
        data_version: '2026.01.01',
        generated_at: '2026-01-01T04:00:00Z',
        sources: SOURCES,
        counts: {
          regions: { entities: 1, active: 1, versions: 1 },
          provinces: { entities: 2, active: 2, versions: 2 },
          municipalities: { entities: 4, active: 2, versions: 5 },
          variations: 2,
        },
        anomalies: { warning: 1, info: 1 },
      });
      expect((JSON.parse(files['reports/anomalies.json'] ?? '') as { code: string }[]).map((a) => a.code)).toEqual([
        'inferred-breakpoint',
        'anpr-missing-entity',
      ]);
      expect(JSON.parse(files['reports/changes.json'] ?? '')).toMatchObject({ from: null, retroactive: false });
    });
  });

  it('is byte-identical across two runs, and reads back as the previous release', async () => {
    await withTempDir(async (dir) => {
      await emitDataset(options(join(dir, 'a')));
      await emitDataset(options(join(dir, 'b')));
      expect(await filesOf(join(dir, 'a'))).toEqual(await filesOf(join(dir, 'b')));

      const previous = await loadPublishedDataset(dirs(join(dir, 'a')));
      expect(previous?.meta.data_version).toBe('2026.01.01');
      expect(previous?.municipalities).toHaveLength(4);
      expect(previous?.variations).toHaveLength(2);
      expect(await loadPublishedDataset(dirs(join(dir, 'none')))).toBeNull();
    });
  });

  it('leaves the directory untouched when neither the data files nor the schemas changed', async () => {
    await withTempDir(async (dir) => {
      await emitDataset(options(dir));
      const before = await filesOf(dir);
      const mtime = (await stat(join(dir, 'reports', 'meta.json'))).mtimeMs;
      const previous = await loadPublishedDataset(dirs(dir));
      const result = await emitDataset(
        options(dir, { previous, generatedAt: '2026-01-08T04:00:00Z', today: '2026-01-08', anomalies: [] }),
      );
      expect(result.kind).toBe('unchanged');
      expect(result.anomalies).toEqual([]);
      expect(await filesOf(dir)).toEqual(before);
      expect((await stat(join(dir, 'reports', 'meta.json'))).mtimeMs).toBe(mtime);
    });
  });

  it('does not release when only the internal reports would change (§9)', async () => {
    await withTempDir(async (dir) => {
      await emitDataset(options(dir));
      const before = await filesOf(dir);
      const previous = await loadPublishedDataset(dirs(dir));
      const world = baseline();
      mut(world).variations[1] = { ...at(world.variations, 1), description: 'Altra descrizione' };
      const result = await emitDataset(options(dir, { world, previous, today: '2026-01-08' }));
      expect(result.kind).toBe('unchanged');
      expect(await filesOf(dir)).toEqual(before);
    });
  });

  it('writes a diff against the previous release when the data changed', async () => {
    await withTempDir(async (dir) => {
      await emitDataset(options(dir));
      const previous = await loadPublishedDataset(dirs(dir));
      const world = baseline();
      at(entityOf(world, 'municipality', 3).versions).officialName = 'Delta Nuova';
      const result = await emitDataset(
        options(dir, { world, previous, generatedAt: '2026-01-08T04:00:00Z', today: '2026-01-08' }),
      );
      expect(result.kind).toBe('data');
      expect(result.kind !== 'unchanged' && result.changes).toMatchObject({
        from: { data_version: '2026.01.01', generated_at: '2026-01-01T04:00:00Z' },
        to: { data_version: '2026.01.08', generated_at: '2026-01-08T04:00:00Z' },
        retroactive: true,
        municipalities: {
          versions: {
            updated: [
              {
                entity_id: M(3),
                valid_from: '1861-03-17',
                fields: ['official_name'],
                affected_from: '1861-03-17',
                retroactive: true,
              },
            ],
          },
        },
      });
      expect((await loadPublishedDataset(dirs(dir)))?.meta.data_version).toBe('2026.01.08');
    });
  });

  it('with the same data and different schemas, publishes the schemas, an empty diff and a new meta', async () => {
    await withTempDir(async (dir) => {
      await emitDataset(options(dir));
      const before = await filesOf(dir);
      const previous = await loadPublishedDataset(dirs(dir));
      if (previous === null) throw new Error('nothing published');
      // A release of an older generator: one schema differs, one is missing.
      previous.schemas['regions.schema.json'] = '{}';
      delete previous.schemas['provinces.schema.json'];
      const result = await emitDataset(
        options(dir, {
          previous,
          generatedAt: '2026-01-08T04:00:00Z',
          today: '2026-01-08',
          anomalies: [],
          sources: { ...SOURCES, anpr: null, 'situas-internal': null, 'situas-public-snapshots': null },
        }),
      );
      expect(result.kind).toBe('schemas');
      if (result.kind === 'unchanged') return;
      expect(result.files).toEqual([
        ...Object.keys(generateJsonSchemas()).map((name) => `schema/${name}`),
        'reports/changes.json',
        'reports/meta.json',
      ]);
      const after = await filesOf(dir);
      for (const name of [
        'dist/regions.json',
        'dist/provinces.json',
        'dist/municipalities.json',
        'reports/variations.json',
        'reports/anomalies.json',
      ]) {
        expect(after[name]).toBe(before[name]);
      }
      const empty = { added: [], updated: [], removed: [] };
      expect(result.changes).toEqual({
        from: { data_version: '2026.01.01', generated_at: '2026-01-01T04:00:00Z' },
        to: { data_version: '2026.01.01', generated_at: '2026-01-08T04:00:00Z' },
        retroactive: false,
        regions: { entities: empty, versions: empty },
        provinces: { entities: empty, versions: empty },
        municipalities: { entities: empty, versions: empty },
        variations: empty,
      });
      // The meta of the release that produced the data, with the new schema version and time.
      expect(result.meta).toEqual({
        ...previous.meta,
        schema_version: '1.0.0',
        generated_at: '2026-01-08T04:00:00Z',
      });
      expect(result.meta.data_version).toBe('2026.01.01');
      const reloaded = await loadPublishedDataset(dirs(dir));
      expect(reloaded?.schemas).toEqual(
        Object.fromEntries(Object.entries(generateJsonSchemas()).map(([name, schema]) => [name, serialize(schema)])),
      );
    });
  });

  it('refuses blocking anomalies and invalid data before writing anything', async () => {
    await withTempDir(async (dir) => {
      const blocking = [{ level: 'blocking' as const, code: 'invariant-i1', message: 'x', context: {} }];
      await expect(emitDataset(options(dir, { anomalies: blocking }))).rejects.toThrow(EmitError);
      const world = baseline();
      at(entityOf(world, 'province', 1).versions).abbreviation = 'Venezia Giulia';
      await expect(emitDataset(options(dir, { world }))).rejects.toThrow(/provinces.json violates its model/);
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it('rejects a previous release that violates its models, public files and reports', async () => {
    await withTempDir(async (dir) => {
      await emitDataset(options(dir));
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, 'dist', 'regions.json'), '[{"id": 0}]\n');
      await expect(loadPublishedDataset(dirs(dir))).rejects.toThrow(EmitError);
    });
    await withTempDir(async (dir) => {
      await emitDataset(options(dir));
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, 'reports', 'variations.json'), '[{"id": 0}]\n');
      await expect(loadPublishedDataset(dirs(dir))).rejects.toThrow(EmitError);
    });
  });
});

describe('source summaries (meta.json)', () => {
  it('summarises manifests by key, latest fetch and count', () => {
    const refs = [
      { key: 'b', fetched_at: '2026-09-01', content_hash: '2'.repeat(64) },
      { key: 'a', fetched_at: '2026-10-01', content_hash: '1'.repeat(64) },
    ];
    expect(summariseManifests(refs)).toEqual({
      fetched_at: '2026-10-01',
      content_hash: sha256(
        canonicalJson([
          ['a', '1'.repeat(64)],
          ['b', '2'.repeat(64)],
        ]),
      ),
      manifests: 2,
    });
    expect(summariseManifests([...refs].reverse())).toEqual(summariseManifests(refs));
    expect(summariseManifests([])).toBeNull();
  });

  it('reads every source family from the store, counts and ANPR included', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(dir);
      expect(await sourceSummaries(store)).toEqual({
        'situas-public-snapshots': null,
        'situas-public-reports': null,
        'situas-internal': null,
        anpr: null,
      });
      const row = { code: '01', name: 'Piemonte', type: 'region' as const };
      await store.putSnapshot('region', '2026-01-01', 68, { fetchedAt: '2026-10-01', rows: [row] });
      await store.putSnapshot('region', '2025-12-31', 68, { fetchedAt: '2026-10-02', rows: [row] });
      await store.putEventList(112, '1861-03-17', '2026-10-01', { fetchedAt: '2026-10-01', rows: [] });
      await store.putInternalReport(3, reportUrls.municipalityList(), {
        fetchedAt: '2026-09-30',
        rows: [{ code: '001001', name: 'A' }],
      });
      await store.putCount(68, '2026-10-01', { fetchedAt: '2026-10-04', rows: [{ count: 20 }] });
      const anpr = await store.putAnpr({ fetchedAt: '2026-10-03', rows: [] });
      const summaries = await sourceSummaries(store);
      expect(summaries['situas-public-snapshots']).toMatchObject({ fetched_at: '2026-10-02', manifests: 2 });
      expect(summaries['situas-public-reports']).toMatchObject({ fetched_at: '2026-10-04', manifests: 2 });
      expect(summaries['situas-internal']).toMatchObject({ fetched_at: '2026-09-30', manifests: 1 });
      expect(summaries.anpr).toEqual({
        fetched_at: '2026-10-03',
        content_hash: sha256(canonicalJson([['anpr', anpr.manifest.content_hash]])),
        manifests: 1,
      });
    });
  });
});
