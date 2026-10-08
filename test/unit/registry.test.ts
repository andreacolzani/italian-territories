import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import {
  candidateEntityId,
  ID_WINDOWS,
  Registry,
  REGISTRY_ANOMALIES,
  RegistryError,
  type AssignOptions,
  type EntityKeyInput,
} from '../../src/identity/index.ts';
import { ENTITY_ID_PATTERN } from '../../src/model/common.ts';
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

/**
 * Two municipality keys whose window-0 ids collide (found by search): `mun-5M3RPW`. Their window-1
 * ids differ.
 */
const COLLIDING = { first: 'istat:9872', second: 'istat:10467', id: 'mun-5M3RPW' } as const;

describe('entity ids (§5.3, D42)', () => {
  it('are <prefix>-<6 Crockford base32 characters> from the SHA-256 of <level>|<natural key>', () => {
    expect(candidateEntityId('region', 'istat:9', 0)).toBe('reg-X0RQAP');
    expect(candidateEntityId('province', 'istat:9', 0)).toBe('prv-08A1MY');
    for (let window = 0; window < ID_WINDOWS; window++) {
      expect(candidateEntityId('municipality', 'istat:10704', window)).toMatch(ENTITY_ID_PATTERN);
    }
    expect(ID_WINDOWS).toBe(8);
    expect(() => candidateEntityId('region', 'istat:9', ID_WINDOWS)).toThrow(RangeError);
  });

  it('the level is part of the hashed string: the same key gives different codes at different levels', () => {
    const code = (id: string) => id.slice(4);
    expect(code(candidateEntityId('region', 'istat:9', 0))).not.toBe(code(candidateEntityId('province', 'istat:9', 0)));
  });

  it('the two test keys really collide in window 0', () => {
    expect(candidateEntityId('municipality', COLLIDING.first, 0)).toBe(COLLIDING.id);
    expect(candidateEntityId('municipality', COLLIDING.second, 0)).toBe(COLLIDING.id);
  });
});

describe('id registry (§5.3)', () => {
  it('assigns hashed ids and writes sorted, deterministic files', async () => {
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
      const nk = candidateEntityId('province', 'nk:province:801:1920-01-01', 0);
      expect([...ids]).toEqual([
        ['istat:9', 'prv-08A1MY'],
        ['nk:province:801:1920-01-01', nk],
      ]);
      await registry.save();
      const text = await readFile(join(dir, 'provinces.json'), 'utf8');
      expect(JSON.parse(text)).toEqual({
        kind: 'province',
        entries: {
          'istat:9': { id: 'prv-08A1MY', members: [9, 119] },
          'nk:province:801:1920-01-01': { id: nk, members: [] },
        },
      });
      expect(text.endsWith('}\n')).toBe(true);

      const reloaded = await Registry.load(dir);
      await reloaded.save();
      expect(await readFile(join(dir, 'provinces.json'), 'utf8')).toBe(text);
    });
  });

  it('on a collision with a registered key takes the next window; the other key keeps its id', async () => {
    await withTempDir(async (dir) => {
      const first = await Registry.load(dir);
      first.assignEntities(
        'municipality',
        [entity(COLLIDING.first, 'nk:municipality:000001:1861-03-17', [1])],
        options(),
      );
      await first.save();
      const second = await Registry.load(dir);
      const { ids } = second.assignEntities(
        'municipality',
        [
          entity(COLLIDING.first, 'nk:municipality:000001:1861-03-17', [1]),
          entity(COLLIDING.second, 'nk:municipality:000002:1861-03-17', [2]),
        ],
        options(),
      );
      expect(ids.get(COLLIDING.first)).toBe(COLLIDING.id);
      expect(ids.get(COLLIDING.second)).toBe(candidateEntityId('municipality', COLLIDING.second, 1));
    });
  });

  it('two new keys colliding in one run: the first in the assignment order takes window 0, in both input orders', async () => {
    const run = async (reverse: boolean) =>
      withTempDir(async (dir) => {
        const inputs = [
          entity(COLLIDING.second, 'nk:municipality:000002:1861-03-17', [2]),
          entity(COLLIDING.first, 'nk:municipality:000001:1900-01-01', [1]),
        ];
        const registry = await Registry.load(dir);
        return [...registry.assignEntities('municipality', reverse ? inputs.reverse() : inputs, options()).ids];
      });
    const forward = await run(false);
    // COLLIDING.second has the earlier first validFrom: it comes first in the total order.
    expect(new Map(forward).get(COLLIDING.second)).toBe(COLLIDING.id);
    expect(new Map(forward).get(COLLIDING.first)).toBe(candidateEntityId('municipality', COLLIDING.first, 1));
    expect(new Map(await run(true))).toEqual(new Map(forward));
  });

  it('re-keys an nk: entity that gains its origin id, keeping the id derived from the nk: key (not retroactive)', async () => {
    await withTempDir(async (dir) => {
      const first = await Registry.load(dir);
      const nk = 'nk:municipality:041060:1861-03-17';
      first.assignEntities('municipality', [entity(nk, nk, [])], options());
      await first.save();
      const id = candidateEntityId('municipality', nk, 0);

      const second = await Registry.load(dir);
      const run = options('2026-10-11');
      const assignment = second.assignEntities('municipality', [entity('istat:4450', nk, [4450])], run);
      expect(assignment.ids.get('istat:4450')).toBe(id);
      expect(id).not.toBe(candidateEntityId('municipality', 'istat:4450', 0));
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
          id,
          reason: 'origin-id-available',
          recorded_on: '2026-10-11',
        },
      ]);
      expect(await readJson(dir, 'municipalities.json')).toMatchObject({
        entries: { 'istat:4450': { id, members: [4450] } },
      });
      // Stable afterwards: a later run keeps the stored id.
      const third = await Registry.load(dir);
      expect(
        third.assignEntities('municipality', [entity('istat:4450', nk, [4450])], options()).ids.get('istat:4450'),
      ).toBe(id);
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
      expect(new Map(assignment.ids)).toEqual(
        new Map([
          ['istat:20', candidateEntityId('province', 'istat:20', 0)],
          ['istat:7', candidateEntityId('province', 'istat:9', 0)],
        ]),
      );
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
          {
            level: 'municipality',
            cause: 'absent',
            count: 1,
            entities: [{ key: 'istat:2610', id: candidateEntityId('municipality', 'istat:2610', 0), members: [2610] }],
          },
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
          { key: 'nk:1929-05-14:municipality:mun-000004', date: '1929-05-14' },
          { key: 'act:6151:2026-01-01', date: '2026-01-01' },
        ],
        options(),
      );
      expect([...ids]).toEqual([
        ['nk:1929-05-14:municipality:mun-000004', 1],
        ['act:6151:2026-01-01', 2],
      ]);
      const again = registry.assignVariations([{ key: 'act:6151:2026-01-01', date: '2026-01-01' }], options());
      expect(again.ids.get('act:6151:2026-01-01')).toBe(2);
      expect(registry.variationId('act:6151:2026-01-01')).toBe(2);
    });
  });

  it('assigns the same ids whatever the order of the input', async () => {
    const entities = [
      entity('istat:20', 'nk:province:020:1861-03-17', [20]),
      entity('istat:9', 'nk:province:015:1861-03-17', [9, 119]),
      entity('istat:126', 'nk:province:111:2016-04-28', [126]),
      entity('nk:province:801:1920-01-01', 'nk:province:801:1920-01-01', []),
    ];
    const variations = [
      { key: 'act:6151:2026-01-01', date: '2026-01-01' },
      { key: 'act:2767:1927-01-12', date: '1927-01-12' },
      { key: 'inferred:1927-01-12:province:prv-000002', date: '1927-01-12' },
    ];
    const registryFiles = async (reverse: boolean): Promise<string[]> =>
      withTempDir(async (dir) => {
        const order = <T>(items: T[]): T[] => (reverse ? [...items].reverse() : items);
        const registry = await Registry.load(dir);
        registry.assignEntities('province', order(entities), options());
        registry.assignVariations(order(variations), options());
        await registry.save();
        return Promise.all(['provinces.json', 'variations.json'].map((f) => readFile(join(dir, f), 'utf8')));
      });
    const forward = await registryFiles(false);
    expect(await registryFiles(true)).toEqual(forward);
    expect(JSON.parse(forward[1] ?? '')).toMatchObject({
      next_id: 4,
      entries: {
        'act:2767:1927-01-12': { id: 1 },
        'inferred:1927-01-12:province:prv-000002': { id: 2 },
        'act:6151:2026-01-01': { id: 3 },
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
        {
          kind: 'province',
          entries: { a: { id: 'prv-000001', members: [] }, b: { id: 'prv-000001', members: [] } },
        },
      ],
      ['provinces.json', { kind: 'province', entries: { a: { id: 'reg-000001', members: [] } } }],
      ['provinces.json', { kind: 'province', entries: { a: { id: 2, members: [] } } }],
      ['provinces.json', { kind: 'province', entries: { a: { id: 'prv-000001', members: [119, 9] } } }],
      ['provinces.json', { kind: 'province', next_id: 2, entries: {} }],
      ['variations.json', { kind: 'variation', next_id: 2, entries: { a: { id: 2 } } }],
      [
        'remaps.json',
        [
          {
            kind: 'region',
            from_key: 'a',
            to_key: 'b',
            id: 'reg-000001',
            reason: 'key-moved',
            recorded_on: '2026-10-04',
          },
        ],
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
