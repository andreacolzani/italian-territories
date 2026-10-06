import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import {
  Registry,
  REGISTRY_ANOMALIES,
  RegistryError,
  type AssignOptions,
  type EntityKeyInput,
} from '../../src/identity/index.ts';
import { withTempDir } from '../helpers/http.ts';

function options(recordedOn = '2026-10-04'): AssignOptions & { anomalies: AnomalyCollector } {
  return { recordedOn, anomalies: new AnomalyCollector() };
}

/** An entity input whose first interval is the one of its `nk:<level>:<code>:<date>` fallback key. */
function entity(key: string, fallbackKey: string, members: number[]): EntityKeyInput {
  const [, , firstCode = '', firstValidFrom = ''] = fallbackKey.split(':');
  return { key, fallbackKey, members, firstCode, firstValidFrom };
}

async function readJson(dir: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown;
}

describe('id registry (§5.3)', () => {
  it('assigns ids by first interval and writes sorted, deterministic files', async () => {
    await withTempDir(async (dir) => {
      const registry = await Registry.load(dir);
      const { ids } = registry.assignEntities(
        'province',
        [
          entity('istat:9', 'nk:province:015:1861-03-17', [119, 9]),
          entity('nk:province:801:1920-01-01', 'nk:province:801:1920-01-01', []),
        ],
        options(),
      );
      expect([...ids]).toEqual([
        ['istat:9', 1],
        ['nk:province:801:1920-01-01', 2],
      ]);
      await registry.save();
      const text = await readFile(join(dir, 'provinces.json'), 'utf8');
      expect(JSON.parse(text)).toEqual({
        kind: 'province',
        next_id: 3,
        entries: { 'istat:9': { id: 1, members: [9, 119] }, 'nk:province:801:1920-01-01': { id: 2, members: [] } },
      });
      expect(text.endsWith('}\n')).toBe(true);

      const reloaded = await Registry.load(dir);
      await reloaded.save();
      expect(await readFile(join(dir, 'provinces.json'), 'utf8')).toBe(text);
    });
  });

  it('re-keys an nk: entity that gains its origin id, keeping the id (not retroactive)', async () => {
    await withTempDir(async (dir) => {
      const first = await Registry.load(dir);
      const nk = 'nk:municipality:041060:1861-03-17';
      first.assignEntities('municipality', [entity(nk, nk, [])], options());
      await first.save();

      const second = await Registry.load(dir);
      const run = options('2026-10-11');
      const assignment = second.assignEntities('municipality', [entity('istat:4450', nk, [4450])], run);
      expect(assignment.ids.get('istat:4450')).toBe(1);
      expect(assignment.retroactive).toBe(false);
      expect(run.anomalies.list().map((a) => [a.level, a.code])).toEqual([
        ['info', REGISTRY_ANOMALIES.originIdAvailable],
      ]);
      await second.save();
      expect(await readJson(dir, 'remaps.json')).toEqual([
        {
          kind: 'municipality',
          from_key: nk,
          to_key: 'istat:4450',
          id: 1,
          reason: 'origin-id-available',
          recorded_on: '2026-10-11',
        },
      ]);
      expect(await readJson(dir, 'municipalities.json')).toMatchObject({
        entries: { 'istat:4450': { id: 1, members: [4450] } },
      });
    });
  });

  it('reuses the id of a component whose root changed (retroactive)', async () => {
    await withTempDir(async (dir) => {
      const first = await Registry.load(dir);
      first.assignEntities(
        'province',
        [
          entity('istat:9', 'nk:province:015:1861-03-17', [9, 119]),
          entity('istat:20', 'nk:province:020:1861-03-17', [20]),
        ],
        options(),
      );
      await first.save();

      const second = await Registry.load(dir);
      const run = options();
      const assignment = second.assignEntities(
        'province',
        [
          entity('istat:7', 'nk:province:007:1850-01-01', [7, 9, 119]),
          entity('istat:20', 'nk:province:020:1861-03-17', [20]),
        ],
        run,
      );
      expect([...assignment.ids]).toEqual([
        ['istat:20', 2],
        ['istat:7', 1],
      ]);
      expect(assignment.retroactive).toBe(true);
      expect(second.retroactive).toBe(true);
      expect(run.anomalies.list().map((a) => [a.level, a.code])).toEqual([['warning', REGISTRY_ANOMALIES.rootChanged]]);
    });
  });

  it('never re-keys a registered istat: entity to nk: when its internal history is missing (blocking)', async () => {
    await withTempDir(async (dir) => {
      const first = await Registry.load(dir);
      const nk = 'nk:municipality:090003:1861-03-17';
      first.assignEntities(
        'municipality',
        [entity('istat:2610', nk, [2610]), entity('istat:4450', 'nk:municipality:041060:1861-03-17', [4450])],
        options(),
      );
      await first.save();

      // Alghero's r6 is missing: the same intervals come back under the fallback key.
      const second = await Registry.load(dir);
      const run = options();
      second.assignEntities(
        'municipality',
        [entity(nk, nk, []), entity('istat:4450', 'nk:municipality:041060:1861-03-17', [4450])],
        run,
      );
      expect(run.anomalies.list().map((a) => [a.level, a.code, a.context])).toEqual([
        [
          'blocking',
          'internal-data-required',
          { level: 'municipality', count: 1, entities: [{ key: 'istat:2610', id: 2, members: [2610] }] },
        ],
      ]);
    });
  });

  it('a registered istat: entity whose members are in another component is a root change, not a lost history', async () => {
    await withTempDir(async (dir) => {
      const first = await Registry.load(dir);
      first.assignEntities('province', [entity('istat:9', 'nk:province:015:1861-03-17', [9, 119])], options());
      await first.save();
      const second = await Registry.load(dir);
      const run = options();
      second.assignEntities('province', [entity('istat:7', 'nk:province:007:1850-01-01', [7, 9, 119])], run);
      expect(run.anomalies.list().map((a) => a.code)).toEqual([REGISTRY_ANOMALIES.rootChanged]);
    });
  });

  it('moved-key rule: a version whose start moved keeps its id (retroactive)', async () => {
    await withTempDir(async (dir) => {
      const first = await Registry.load(dir);
      first.assignVersions(
        'municipality',
        [
          { entityId: 5, validFrom: '1900-01-01', validTo: '1950-01-01' },
          { entityId: 5, validFrom: '1950-01-01', validTo: null },
        ],
        options(),
      );
      await first.save();

      const second = await Registry.load(dir);
      const run = options();
      const assignment = second.assignVersions(
        'municipality',
        [
          { entityId: 5, validFrom: '1901-06-01', validTo: '1950-01-01' },
          { entityId: 5, validFrom: '1950-01-01', validTo: '2000-01-01' },
          { entityId: 5, validFrom: '2000-01-01', validTo: null },
        ],
        run,
      );
      expect([...assignment.ids]).toEqual([
        ['5:1950-01-01', 2],
        ['5:1901-06-01', 1],
        ['5:2000-01-01', 3],
      ]);
      expect(assignment.remaps).toEqual([
        expect.objectContaining({
          kind: 'municipality-version',
          from_key: '5:1900-01-01',
          to_key: '5:1901-06-01',
          reason: 'key-moved',
          retroactive: true,
        }),
      ]);
      expect(run.anomalies.list().map((a) => [a.level, a.code])).toEqual([['warning', REGISTRY_ANOMALIES.keyMoved]]);
      await second.save();
      expect(await readJson(dir, 'municipality-versions.json')).toEqual({
        kind: 'municipality-version',
        next_id: 4,
        entries: {
          '5:1901-06-01': { id: 1, valid_to: '1950-01-01' },
          '5:1950-01-01': { id: 2, valid_to: '2000-01-01' },
          '5:2000-01-01': { id: 3, valid_to: null },
        },
      });
    });
  });

  it('never reuses the id of a key that disappeared without an overlapping successor', async () => {
    await withTempDir(async (dir) => {
      const registry = await Registry.load(dir);
      registry.assignVersions('region', [{ entityId: 1, validFrom: '1900-01-01', validTo: '1910-01-01' }], options());
      const { ids, remaps } = registry.assignVersions(
        'region',
        [{ entityId: 1, validFrom: '1920-01-01', validTo: null }],
        options(),
      );
      expect(ids.get('1:1920-01-01')).toBe(2);
      expect(remaps).toEqual([]);
      expect(registry.get('region-version', '1:1900-01-01')).toBe(1);
    });
  });

  it('appends the remaps of a run sorted by kind, then by from_key', async () => {
    await withTempDir(async (dir) => {
      const first = await Registry.load(dir);
      for (const key of ['nk:region:02:1861-03-17', 'nk:region:01:1861-03-17']) {
        first.assignEntities('region', [entity(key, key, [])], options());
      }
      first.assignEntities(
        'municipality',
        [entity('nk:municipality:001001:1861-03-17', 'nk:municipality:001001:1861-03-17', [])],
        options(),
      );
      await first.save();

      const second = await Registry.load(dir);
      second.assignEntities(
        'region',
        [entity('istat:2', 'nk:region:02:1861-03-17', [2]), entity('istat:1', 'nk:region:01:1861-03-17', [1])],
        options(),
      );
      second.assignEntities('municipality', [entity('istat:10', 'nk:municipality:001001:1861-03-17', [10])], options());
      await second.save();
      const remaps = (await readJson(dir, 'remaps.json')) as { kind: string; from_key: string }[];
      expect(remaps.map((r) => [r.kind, r.from_key])).toEqual([
        ['municipality', 'nk:municipality:001001:1861-03-17'],
        ['region', 'nk:region:01:1861-03-17'],
        ['region', 'nk:region:02:1861-03-17'],
      ]);
    });
  });

  it('assigns variation ids by date, then natural key', async () => {
    await withTempDir(async (dir) => {
      const registry = await Registry.load(dir);
      const { ids } = registry.assignVariations(
        [
          { key: 'nk:1929-05-14:municipality:4', date: '1929-05-14' },
          { key: 'act:6151:2026-01-01', date: '2026-01-01' },
        ],
        options(),
      );
      expect([...ids]).toEqual([
        ['nk:1929-05-14:municipality:4', 1],
        ['act:6151:2026-01-01', 2],
      ]);
      const again = registry.assignVariations([{ key: 'act:6151:2026-01-01', date: '2026-01-01' }], options());
      expect(again.ids.get('act:6151:2026-01-01')).toBe(2);
    });
  });

  it('assigns the same ids whatever the order of the input', async () => {
    const entities = [
      entity('istat:20', 'nk:province:020:1861-03-17', [20]),
      entity('istat:9', 'nk:province:015:1861-03-17', [9, 119]),
      entity('istat:126', 'nk:province:111:2016-04-28', [126]),
      entity('nk:province:801:1920-01-01', 'nk:province:801:1920-01-01', []),
    ];
    const versions = [
      { entityId: 2, validFrom: '1861-03-17', validTo: '1927-01-12' },
      { entityId: 1, validFrom: '1861-03-17', validTo: null },
      { entityId: 2, validFrom: '1927-01-12', validTo: null },
    ];
    const variations = [
      { key: 'act:6151:2026-01-01', date: '2026-01-01' },
      { key: 'act:2767:1927-01-12', date: '1927-01-12' },
      { key: 'inferred:1927-01-12:province:2', date: '1927-01-12' },
    ];
    const registryFiles = async (reverse: boolean): Promise<string[]> =>
      withTempDir(async (dir) => {
        const order = <T>(items: T[]): T[] => (reverse ? [...items].reverse() : items);
        const registry = await Registry.load(dir);
        registry.assignEntities('province', order(entities), options());
        registry.assignVersions('province', order(versions), options());
        registry.assignVariations(order(variations), options());
        await registry.save();
        return Promise.all(
          ['provinces.json', 'province-versions.json', 'variations.json'].map((f) => readFile(join(dir, f), 'utf8')),
        );
      });
    const forward = await registryFiles(false);
    expect(await registryFiles(true)).toEqual(forward);
    expect(JSON.parse(forward[0] ?? '')).toMatchObject({
      entries: {
        'istat:9': { id: 1 },
        'istat:20': { id: 2 },
        'nk:province:801:1920-01-01': { id: 3 },
        'istat:126': { id: 4 },
      },
    });
  });

  it('rejects a natural key given twice in one call', async () => {
    await withTempDir(async (dir) => {
      const registry = await Registry.load(dir);
      expect(() =>
        registry.assignVariations(
          [
            { key: 'act:1:1900-01-01', date: '1900-01-01' },
            { key: 'act:1:1900-01-01', date: '1900-01-01' },
          ],
          options(),
        ),
      ).toThrow(/duplicate natural key/);
    });
  });

  it('rejects inconsistent files', async () => {
    const cases: [string, unknown][] = [
      [
        'provinces.json',
        { kind: 'province', next_id: 3, entries: { a: { id: 1, members: [] }, b: { id: 1, members: [] } } },
      ],
      ['provinces.json', { kind: 'province', next_id: 2, entries: { a: { id: 2, members: [] } } }],
      ['provinces.json', { kind: 'province', next_id: 2, entries: { a: { id: 1, members: [119, 9] } } }],
      ['region-versions.json', { kind: 'region', next_id: 2, entries: {} }],
      [
        'remaps.json',
        [{ kind: 'region', from_key: 'a', to_key: 'b', id: 1, reason: 'guess', recorded_on: '2026-10-04' }],
      ],
    ];
    for (const [file, content] of cases) {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, file), JSON.stringify(content), 'utf8');
        await expect(Registry.load(dir)).rejects.toBeInstanceOf(RegistryError);
      });
    }
  });
});
