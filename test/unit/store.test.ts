import { readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, normaliseUrl, sha256 } from '../../src/http/index.ts';
import type { RegionSnapshotRow } from '../../src/model/internal.ts';
import { reportUrls } from '../../src/sources/situas-internal/index.ts';
import { anprRecord } from '../../src/sources/anpr/index.ts';
import type { UtsEventRow } from '../../src/sources/situas-public/index.ts';
import {
  contentHash,
  PROJECTION_VERSIONS,
  rowHash,
  Store,
  StoreCorruptionError,
  type ProjectionVersions,
} from '../../src/store/index.ts';
import { withTempDir } from '../helpers/http.ts';
import { withSources } from '../helpers/sources.ts';

const PIEMONTE: RegionSnapshotRow = { code: '01', name: 'Piemonte', type: 'region' };
const LOMBARDIA: RegionSnapshotRow = { code: '03', name: 'Lombardia', type: 'region' };
const VENETO: RegionSnapshotRow = { code: '05', name: 'Veneto', type: 'region' };

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter((l) => l !== '');
}

function byCanonical(rows: readonly unknown[]): string[] {
  return rows.map((r) => canonicalJson(r)).sort();
}

function bumped(patch: (v: ProjectionVersions) => void): ProjectionVersions {
  const versions = structuredClone(PROJECTION_VERSIONS);
  patch(versions);
  return versions;
}

describe('row hashing', () => {
  it('is the SHA-256 of the canonical JSON (keys sorted, no whitespace)', () => {
    expect(rowHash(PIEMONTE)).toBe(sha256('{"code":"01","name":"Piemonte","type":"region"}'));
    expect(rowHash({ type: 'region', name: 'Piemonte', code: '01' })).toBe(rowHash(PIEMONTE));
    expect(rowHash({ ...PIEMONTE, name: 'Piemonte ' })).not.toBe(rowHash(PIEMONTE));
  });
});

describe('snapshots', () => {
  it('round-trips real snapshots and stores rows shared by two dates once', async () => {
    await withSources(async ({ situasPublic }) => {
      const before = (await situasPublic.fetchSnapshot('municipality', '2024-01-21')).data;
      const after = (await situasPublic.fetchSnapshot('municipality', '2024-01-22')).data;
      await withTempDir(async (dir) => {
        const store = new Store(dir);
        const first = await store.putSnapshot('municipality', '2024-01-21', before.pfun, {
          fetchedAt: '2026-09-30',
          rows: before.snapshot.rows,
          adapterStats: { historical_code_fallbacks: before.historicalCodeFallbacks },
        });
        expect(first.outcome).toBe('created');
        await store.putSnapshot('municipality', '2024-01-22', after.pfun, {
          fetchedAt: '2026-09-30',
          rows: after.snapshot.rows,
        });

        const distinct = new Set([...before.snapshot.rows, ...after.snapshot.rows].map(rowHash));
        expect(distinct.size).toBeLessThan(before.snapshot.rows.length + after.snapshot.rows.length);
        const log = await lines(join(dir, 'rows', 'municipality.ndjson'));
        expect(log).toHaveLength(distinct.size);
        expect(new Set(log.map((l) => (JSON.parse(l) as { hash: string }).hash)).size).toBe(distinct.size);

        // A fresh instance reads everything back from disk.
        const reread = new Store(dir);
        const stored = await reread.getSnapshot('municipality', '2024-01-21');
        expect(stored).toBeDefined();
        expect(byCanonical(stored?.rows ?? [])).toEqual(byCanonical(before.snapshot.rows));
        const manifest = stored?.manifest;
        expect(manifest).toMatchObject({
          level: 'municipality',
          date: '2024-01-21',
          pfun: 61,
          projection_version: PROJECTION_VERSIONS.snapshot.municipality,
          fetched_at: '2026-09-30',
          adapter_stats: { historical_code_fallbacks: before.historicalCodeFallbacks },
          history: [],
        });
        expect(manifest?.row_hashes).toEqual([...(manifest?.row_hashes ?? [])].sort());
        expect(manifest?.content_hash).toBe(contentHash(manifest?.row_hashes ?? []));
        expect(Object.keys(manifest ?? {})).toEqual([
          'level',
          'date',
          'pfun',
          'projection_version',
          'fetched_at',
          'content_hash',
          'adapter_stats',
          'row_hashes',
          'history',
        ]);
        expect(await reread.snapshotDates('municipality')).toEqual(['2024-01-21', '2024-01-22']);
        expect(await reread.getSnapshot('municipality', '2024-01-23')).toBeUndefined();
      });
    });
  });

  it('keeps duplicate rows in the manifest', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(dir);
      await store.putSnapshot('region', '2026-01-01', 68, { fetchedAt: '2026-10-01', rows: [PIEMONTE, PIEMONTE] });
      expect((await new Store(dir).getSnapshot('region', '2026-01-01'))?.rows).toEqual([PIEMONTE, PIEMONTE]);
      expect(await lines(join(dir, 'rows', 'region.ndjson'))).toHaveLength(1);
    });
  });

  it('writes nothing when a refresh returns the same content', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(dir);
      await store.putSnapshot('region', '2026-01-01', 68, { fetchedAt: '2026-10-01', rows: [PIEMONTE, LOMBARDIA] });
      const path = join(dir, 'snapshots', 'region', '2026-01-01.json');
      const text = await readFile(path, 'utf8');
      const mtime = (await stat(path)).mtimeMs;

      const again = await new Store(dir).putSnapshot('region', '2026-01-01', 68, {
        fetchedAt: '2026-10-08',
        rows: [LOMBARDIA, PIEMONTE],
      });
      expect(again.outcome).toBe('unchanged');
      expect(again.manifest.fetched_at).toBe('2026-10-01');
      expect(await readFile(path, 'utf8')).toBe(text);
      expect((await stat(path)).mtimeMs).toBe(mtime);
      expect(await lines(join(dir, 'rows', 'region.ndjson'))).toHaveLength(2);
    });
  });

  it('excludes adapter_stats from the content hash', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(dir);
      const first = await store.putSnapshot('region', '2026-01-01', 68, {
        fetchedAt: '2026-10-01',
        rows: [PIEMONTE],
        adapterStats: { n: 1 },
      });
      const second = await store.putSnapshot('region', '2026-01-01', 68, {
        fetchedAt: '2026-10-08',
        rows: [PIEMONTE],
        adapterStats: { n: 2 },
      });
      expect(second.outcome).toBe('unchanged');
      expect(second.manifest).toMatchObject({
        content_hash: first.manifest.content_hash,
        fetched_at: '2026-10-01',
        adapter_stats: { n: 2 },
        history: [],
      });
    });
  });

  it('appends the replaced content to history when a refresh changes it', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(dir);
      const first = await store.putSnapshot('region', '2026-01-01', 68, { fetchedAt: '2026-10-01', rows: [PIEMONTE] });
      const second = await store.putSnapshot('region', '2026-01-01', 68, {
        fetchedAt: '2026-10-08',
        rows: [PIEMONTE, VENETO],
      });
      expect(second.outcome).toBe('changed');
      expect(second.manifest.fetched_at).toBe('2026-10-08');
      expect(second.manifest.history).toEqual([
        { fetched_at: '2026-10-01', content_hash: first.manifest.content_hash },
      ]);
      const third = await store.putSnapshot('region', '2026-01-01', 68, { fetchedAt: '2026-10-15', rows: [PIEMONTE] });
      expect(third.outcome).toBe('changed');
      expect(third.manifest.content_hash).toBe(first.manifest.content_hash);
      expect(third.manifest.history.map((h) => h.fetched_at)).toEqual(['2026-10-01', '2026-10-08']);
      expect((await new Store(dir).getSnapshot('region', '2026-01-01'))?.rows).toEqual([PIEMONTE]);
    });
  });

  it('ignores manifests of another projection version and replaces them without history', async () => {
    await withTempDir(async (dir) => {
      await new Store(dir).putSnapshot('region', '2026-01-01', 68, { fetchedAt: '2026-10-01', rows: [PIEMONTE] });
      const store = new Store(dir, { projectionVersions: bumped((v) => (v.snapshot.region = 2)) });
      expect(await store.getSnapshot('region', '2026-01-01')).toBeUndefined();
      expect(await store.snapshotDates('region')).toEqual(['2026-01-01']);

      const put = await store.putSnapshot('region', '2026-01-01', 68, { fetchedAt: '2026-10-08', rows: [VENETO] });
      expect(put.outcome).toBe('reprojected');
      expect(put.manifest).toMatchObject({ projection_version: 2, fetched_at: '2026-10-08', history: [] });
      expect((await store.getSnapshot('region', '2026-01-01'))?.rows).toEqual([VENETO]);
      // Other levels keep their version.
      await store.putSnapshot('province', '2026-01-01', 64, { fetchedAt: '2026-10-08', rows: [] });
      expect((await store.getSnapshot('province', '2026-01-01'))?.manifest.projection_version).toBe(1);
      expect(await new Store(dir).getSnapshot('region', '2026-01-01')).toBeUndefined();
    });
  });

  it('rejects a pfun that is not the one of the date regime', async () => {
    await withTempDir((dir) => {
      const store = new Store(dir);
      expect(() => store.putSnapshot('region', '1947-12-31', 68, { fetchedAt: '2026-10-01', rows: [] })).toThrow(
        RangeError,
      );
      return Promise.resolve();
    });
  });

  it('stores concurrent puts sharing rows without duplicates', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(dir);
      const dates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'];
      await Promise.all(
        dates.map((date, i) =>
          store.putSnapshot('region', date, 68, {
            fetchedAt: '2026-10-01',
            rows: i % 2 === 0 ? [PIEMONTE, LOMBARDIA] : [LOMBARDIA, VENETO],
          }),
        ),
      );
      expect(await lines(join(dir, 'rows', 'region.ndjson'))).toHaveLength(3);
      expect(await store.snapshotDates('region')).toEqual(dates);
    });
  });

  it('cuts the partial line left by an interrupted append', async () => {
    await withTempDir(async (dir) => {
      await new Store(dir).putSnapshot('region', '2026-01-01', 68, { fetchedAt: '2026-10-01', rows: [PIEMONTE] });
      const log = join(dir, 'rows', 'region.ndjson');
      await appendFile(log, '{"hash":"abc","row":{"co', 'utf8');

      const store = new Store(dir);
      expect((await store.getSnapshot('region', '2026-01-01'))?.rows).toEqual([PIEMONTE]);
      await store.putSnapshot('region', '2026-01-02', 68, { fetchedAt: '2026-10-01', rows: [VENETO] });
      const stored = await lines(log);
      expect(stored).toHaveLength(2);
      expect(stored.map((l) => JSON.parse(l) as unknown)).toHaveLength(2);
    });
  });

  it('detects tampered rows and manifests referencing unknown rows', async () => {
    await withTempDir(async (dir) => {
      await new Store(dir).putSnapshot('region', '2026-01-01', 68, { fetchedAt: '2026-10-01', rows: [PIEMONTE] });
      const log = join(dir, 'rows', 'region.ndjson');
      const original = await readFile(log, 'utf8');
      await writeFile(log, original.replace('Piemonte', 'Piedmont'), 'utf8');
      await expect(new Store(dir).getSnapshot('region', '2026-01-01')).rejects.toThrow(StoreCorruptionError);

      await writeFile(log, '', 'utf8');
      await expect(new Store(dir).getSnapshot('region', '2026-01-01')).rejects.toThrow(/unknown row hash/);

      await writeFile(join(dir, 'snapshots', 'region', '2026-01-01.json'), '{"level":"region"}', 'utf8');
      await expect(new Store(dir).getSnapshot('region', '2026-01-01')).rejects.toThrow(/invalid manifest/);
    });
  });
});

describe('event lists', () => {
  it('compares a list with every stored row of its range, whichever list they came from', async () => {
    await withSources(async ({ situasPublic }) => {
      const full = (await situasPublic.fetchEventList('province', 112, '1861-03-17', '2026-10-01')).data;
      const recent = (await situasPublic.fetchEventList('province', 112, '2026-01-01', '2026-09-30')).data;
      expect(recent.length).toBeGreaterThan(0);
      await withTempDir(async (dir) => {
        const store = new Store(dir);
        const first = await store.putEventList(112, '1861-03-17', '2026-10-01', {
          fetchedAt: '2026-10-01',
          rows: full,
        });
        expect(first.outcome).toBe('created');
        expect(first.added).toHaveLength(full.length);
        expect(first.removed).toEqual([]);
        expect(first.manifest).toMatchObject({ pfun: 112, level: 'province', from: '1861-03-17', to: '2026-10-01' });

        // The narrower real list agrees with the full one on its range: nothing changed.
        const second = await store.putEventList(112, '2026-01-01', '2026-09-30', {
          fetchedAt: '2026-10-01',
          rows: recent,
        });
        expect(second.outcome).toBe('created');
        expect(second.added).toEqual([]);
        expect(second.removed).toEqual([]);
        expect((await new Store(dir).eventLists(112)).map((m) => `${m.from}_${m.to}`)).toEqual([
          '1861-03-17_2026-10-01',
          '2026-01-01_2026-09-30',
        ]);

        // A later overlapping list where ISTAT dropped one event and added a past-dated one.
        const [dropped] = recent;
        if (dropped === undefined) throw new Error('empty fixture');
        const late: UtsEventRow = { ...dropped, date: '2025-06-30', name: 'Nuova' };
        const third = await new Store(dir).putEventList(112, '2025-01-01', '2026-10-08', {
          fetchedAt: '2026-10-08',
          rows: [...recent.slice(1), late],
        });
        expect(third.added).toEqual([late]);
        expect(third.removed).toEqual([dropped]);

        // The newest list wins on the dates it covers; older lists still answer elsewhere.
        const known = await new Store(dir).eventRows(112, '1861-03-17', '2026-10-08');
        expect(byCanonical(known)).toEqual(
          byCanonical([...full.filter((r) => r.date < '2025-01-01'), ...recent.slice(1), late]),
        );
        expect((await store.getEventList(112, '2026-01-01', '2026-09-30'))?.rows).toHaveLength(recent.length);
      });
    });
  });

  it('ignores lists of another projection version', async () => {
    await withSources(async ({ situasPublic }) => {
      const recent = (await situasPublic.fetchEventList('province', 113, '2026-01-01', '2026-09-30')).data;
      await withTempDir(async (dir) => {
        await new Store(dir).putEventList(113, '2026-01-01', '2026-09-30', { fetchedAt: '2026-10-01', rows: recent });
        const store = new Store(dir, { projectionVersions: bumped((v) => (v.events[113] = 2)) });
        expect(await store.eventLists(113)).toEqual([]);
        expect(await store.eventRows(113, '2026-01-01', '2026-09-30')).toEqual([]);
        expect(await store.getEventList(113, '2026-01-01', '2026-09-30')).toBeUndefined();
        const put = await store.putEventList(113, '2026-01-01', '2026-09-30', {
          fetchedAt: '2026-10-08',
          rows: recent,
        });
        expect(put.outcome).toBe('reprojected');
        expect(put.added).toHaveLength(recent.length);
      });
    });
  });
});

describe('internal reports', () => {
  it('stores a report under the hash of its normalised, unencoded URL', async () => {
    await withSources(async ({ situasInternal }) => {
      const query = { code: '312', name: 'Sassari', type: 'metropolitan_city' } as const;
      const events = (await situasInternal.utsEvents(query)).data;
      const url = reportUrls.utsEvents(query);
      await withTempDir(async (dir) => {
        const store = new Store(dir);
        const put = await store.putInternalReport(5, url, { fetchedAt: '2026-09-30', rows: events });
        const key = sha256(normaliseUrl(url));
        expect(put.manifest).toMatchObject({ report: 5, endpoint: 'r5:uts-events', report_url: url, key });
        const text = await readFile(join(dir, 'internal', 'reports', 'r5', `${key}.json`), 'utf8');
        expect(text.endsWith('}\n')).toBe(true);

        // Parameter order does not change the key.
        const reordered = 'var_get_ua_uts_lov_rs?&uts_tipo=3&coduts=312&uts=Sassari';
        const stored = await new Store(dir).getInternalReport(5, reordered);
        expect(byCanonical(stored?.rows ?? [])).toEqual(byCanonical(events));
        expect(await store.getInternalReport(5, reportUrls.utsEvents({ ...query, code: '090' }))).toBeUndefined();
        expect(() => store.putInternalReport(4, url, { fetchedAt: '2026-09-30', rows: [] })).toThrow(RangeError);
      });
    });
  });

  it('ignores reports of another projection version', async () => {
    await withTempDir(async (dir) => {
      const url = reportUrls.municipalityList();
      await new Store(dir).putInternalReport(3, url, {
        fetchedAt: '2026-09-30',
        rows: [{ code: '001001', name: 'A' }],
      });
      const store = new Store(dir, { projectionVersions: bumped((v) => (v.internal[3] = 2)) });
      expect(await store.getInternalReport(3, url)).toBeUndefined();
    });
  });
});

describe('counts', () => {
  it('stores one manifest per request, writes nothing for the same count, keeps history', async () => {
    await withTempDir(async (dir) => {
      const store = new Store(dir);
      const first = await store.putCount(61, '2026-10-01', { fetchedAt: '2026-10-01', rows: [{ count: 7894 }] });
      expect(first.outcome).toBe('created');
      expect(first.manifest).toMatchObject({ pfun: 61, date: '2026-10-01', projection_version: 1 });
      const path = join(dir, 'counts', 'pfun-61', '2026-10-01.json');
      const written = (await stat(path)).mtimeMs;
      const same = await store.putCount(61, '2026-10-01', { fetchedAt: '2026-10-02', rows: [{ count: 7894 }] });
      expect(same.outcome).toBe('unchanged');
      expect((await stat(path)).mtimeMs).toBe(written);
      const changed = await store.putCount(61, '2026-10-01', { fetchedAt: '2026-10-03', rows: [{ count: 7895 }] });
      expect(changed.outcome).toBe('changed');
      expect(changed.manifest.history).toEqual([
        { fetched_at: '2026-10-01', content_hash: first.manifest.content_hash },
      ]);
      expect((await new Store(dir).getCount(61, '2026-10-01'))?.rows).toEqual([{ count: 7895 }]);
      expect(await store.getCount(61, '2026-10-02')).toBeUndefined();
      await store.putCount(64, '2026-10-01', { fetchedAt: '2026-10-01', rows: [{ count: 107 }] });
      expect((await store.countManifests()).map((m) => [m.pfun, m.date])).toEqual([
        [61, '2026-10-01'],
        [64, '2026-10-01'],
      ]);
      const bumpedStore = new Store(dir, { projectionVersions: bumped((v) => (v.counts = 2)) });
      expect(await bumpedStore.getCount(61, '2026-10-01')).toBeUndefined();
      expect(await bumpedStore.countManifests()).toEqual([]);
    });
  });
});

describe('ANPR', () => {
  it('stores the rows without lines, deduplicated, and writes nothing for the same content', async () => {
    await withSources(async ({ anpr }) => {
      const { data } = await anpr.fetchAnpr();
      const rows = data.rows.slice(0, 50).map(anprRecord);
      await withTempDir(async (dir) => {
        const store = new Store(dir);
        const put = await store.putAnpr({ fetchedAt: '2026-09-30', rows, adapterStats: { row_issues: [] } });
        expect(put.outcome).toBe('created');
        expect(put.manifest).toMatchObject({ endpoint: 'anpr:archivio-comuni', projection_version: 1 });
        const stored = await new Store(dir).getAnpr();
        expect(byCanonical(stored?.rows ?? [])).toEqual(byCanonical(rows));
        expect(stored?.rows.every((r) => !('line' in r))).toBe(true);

        // The same rows in another order (lines shifted by an insertion) are the same content.
        const again = await store.putAnpr({ fetchedAt: '2026-10-07', rows: [...rows].reverse() });
        expect(again.outcome).toBe('unchanged');
        expect(await lines(join(dir, 'anpr', 'rows.ndjson'))).toHaveLength(new Set(byCanonical(rows)).size);

        const changed = await store.putAnpr({ fetchedAt: '2026-10-14', rows: rows.slice(1) });
        expect(changed.outcome).toBe('changed');
        expect(changed.manifest.history).toHaveLength(1);
        expect(await new Store(dir, { projectionVersions: bumped((v) => (v.anpr = 2)) }).getAnpr()).toBeUndefined();
      });
    });
  });
});
