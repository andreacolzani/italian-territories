/**
 * The emitter on real SITUAS fixtures (§6.12, §9, Step 16): byte-identical output across two runs,
 * every file valid against its model and the public files against the JSON Schema they publish
 * (Ajv), the §4.4 example (Siamanna) reproduced, the cessions of 1947-09-16 and Sardinia 2026.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { deriveFields } from '../../src/derive/index.ts';
import { emitDataset, loadPublishedDataset, type EmitWorld, type PublishedDataset } from '../../src/emit/index.ts';
import { generateJsonSchemas } from '../../src/model/json-schema.ts';
import type { Municipality } from '../../src/model/public.ts';
import { withTempDir } from '../helpers/http.ts';
import { municipalityGraph, utsGraph } from '../helpers/identity.ts';
import { publishedSchemaViolations } from '../helpers/json-schema.ts';
import { fixtureWorld, type BuiltVariations } from '../helpers/variations.ts';
import { entityAt } from '../helpers/versions.ts';

function derived(built: BuiltVariations): EmitWorld {
  const anomalies = new AnomalyCollector();
  const { entities, variations } = built;
  return {
    entities: {
      region: deriveFields({ level: 'region', entities: entities.region, variations, anomalies }),
      province: deriveFields({ level: 'province', entities: entities.province, variations, anomalies }),
      municipality: deriveFields({ level: 'municipality', entities: entities.municipality, variations, anomalies }),
    },
    variations,
  };
}

/** The non-blocking anomalies of the world's builders, in the order they were reported. */
function anomaliesOf(built: BuiltVariations) {
  return [...built.anomalies.list(), ...built.variationAnomalies.list()].filter((a) => a.level !== 'blocking');
}

async function filesOf(dir: string): Promise<Map<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = new Map<string, string>();
  for (const e of entries.filter((x) => x.isFile()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(e.parentPath, e.name);
    files.set(path.slice(dir.length + 1).replaceAll('\\', '/'), await readFile(path, 'utf8'));
  }
  return files;
}

/** Emits `world` twice (the second time with the anomalies in reverse order) and reads it back. */
async function emitTwice(built: BuiltVariations, today: IsoDate): Promise<PublishedDataset> {
  return withTempDir(async (dir) => {
    const world = derived(built);
    const anomalies = anomaliesOf(built);
    const run = (out: string, list: typeof anomalies) =>
      emitDataset({
        dirs: { dist: join(dir, out, 'dist'), reports: join(dir, out, 'reports') },
        world,
        anomalies: list,
        previous: null,
        generatedAt: `${today}T04:00:00Z`,
        today,
        sources: {
          'situas-public-snapshots': null,
          'situas-public-reports': null,
          'situas-internal': null,
          anpr: null,
        },
      });
    await run('a', anomalies);
    await run('b', [...anomalies].reverse());
    const a = await filesOf(join(dir, 'a'));
    expect(a).toEqual(await filesOf(join(dir, 'b')));
    for (const [name, schema] of Object.entries(generateJsonSchemas())) {
      expect(JSON.parse(a.get(`dist/schema/${name}`) ?? '')).toEqual(schema);
    }
    expect(await publishedSchemaViolations(join(dir, 'a', 'dist'))).toEqual([]);
    const dataset = await loadPublishedDataset({ dist: join(dir, 'a', 'dist'), reports: join(dir, 'a', 'reports') });
    if (dataset === null) throw new Error('nothing published');
    return dataset;
  });
}

function byCode(municipalities: readonly Municipality[], code: string): Municipality {
  const found = municipalities.find((m) => m.versions.some((v) => v.istat_code === code));
  if (found === undefined) throw new Error(`no municipality ${code}`);
  return found;
}

describe('§4.4: Siamanna (golden-3)', async () => {
  const built = await fixtureWorld(
    ['1947-11-27', '1947-11-28', '1974-08-20', '1974-09-13', '2025-12-31', '2026-01-01'],
    {
      codes: {
        region: ['20'],
        province: ['092', '095', '115'],
        municipality: ['092128', '095057', '115064', '092167', '095072', '115085', '095076'],
      },
      provinces: {
        graph: await utsGraph([
          ['092', 'province', '092_1_cagliari.json'],
          ['115', 'province', '115_1_oristano.json'],
        ]),
      },
      municipalities: await municipalityGraph(['115064_siamanna.json']),
    },
  );
  const dataset = await emitTwice(built, '2026-01-01');

  it('reproduces the published example', () => {
    const siamanna = byCode(dataset.municipalities, '115064');
    const villaurbana = entityAt(built.entities.municipality, '092167', '1947-11-28').id;
    const cagliari = entityAt(built.entities.province, '092', '1947-11-28').id;
    const oristano = entityAt(built.entities.province, '115', '2026-01-01').id;
    const sardegna = entityAt(built.entities.region, '20', '2026-01-01').id;
    // Without the r6 of Villaurbana its `CECS` row matches no act, but its link is already in the
    // variation of the act of Siamanna's `CS`: explained by it, no `nk:` variation (§4.3, D43).
    const acts = dataset.variations.filter((v) => v.date === '1947-11-28').map((v) => v.istat_act_id);
    expect(acts).toHaveLength(1);
    expect(acts[0]).not.toBeNull();
    const explained = dataset.anomalies.find((a) => a.code === 'link-explained-by-act')?.context as
      { items: { event: string; entityId: string; date: string }[] } | undefined;
    expect(explained?.items.map((i) => [i.date, i.event, i.entityId])).toContainEqual([
      '1947-11-28',
      'CECS',
      villaurbana,
    ]);
    expect(siamanna.id).toMatch(/^mun-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(siamanna).toEqual({
      id: siamanna.id,
      status: 'active',
      is_former_italian: false,
      partially_ceded: false,
      predecessors: [{ id: villaurbana, kind: 'detached_into', date: '1947-11-28' }],
      successors: [],
      current_successors: [],
      versions: [
        ['1947-11-28', '1974-08-19', '092128', 'I719', 'Siamanna-Siapiccia', cagliari],
        ['1974-08-20', '1974-09-12', '095057', 'I719', 'Siamanna-Siapiccia', oristano],
        ['1974-09-13', '2025-12-31', '095057', 'I718', 'Siamanna', oristano],
        ['2026-01-01', null, '115064', 'I718', 'Siamanna', oristano],
      ].map(([validFrom, validUntil, code, cadastral, name, province]) => ({
        valid_from: validFrom,
        valid_until: validUntil,
        istat_code: code,
        cadastral_code: cadastral,
        official_name: name,
        italian_name: name,
        foreign_name: null,
        province_id: province,
        region_id: sardegna,
      })),
    });
    expect(JSON.stringify(Object.keys(siamanna))).toBe(
      JSON.stringify([
        'id',
        'status',
        'is_former_italian',
        'partially_ceded',
        'predecessors',
        'successors',
        'current_successors',
        'versions',
      ]),
    );
  });
});

describe('the cessions of 1947-09-16 (golden 9, 18, 19)', async () => {
  const built = await fixtureWorld(['1947-09-15', '1947-09-16']);
  const dataset = await emitTwice(built, '1947-09-16');

  it('publishes Tenda ceded abroad, with its domestic links', () => {
    const tenda = byCode(dataset.municipalities, '004820');
    expect(tenda).toMatchObject({ status: 'suppressed', is_former_italian: true });
    expect(tenda.versions.at(-1)?.valid_until).toBe('1947-09-15');
    const variation = dataset.variations.find((v) =>
      v.participants.some((p) => p.level === 'municipality' && p.territory_id === tenda.id && p.role === 'ceded'),
    );
    expect(variation?.participants.find((p) => p.territory_id === tenda.id)).toMatchObject({
      istat_events: ['AS', 'CE', 'CECS'],
      abroad: true,
      version_after: null,
    });
  });

  it('publishes the participants of every variation in level and id order', () => {
    for (const v of dataset.variations) {
      const keys = v.participants.map(
        (p) => `${['region', 'province', 'municipality'].indexOf(p.level)}:${p.territory_id}`,
      );
      const sorted = [...v.participants]
        .sort(
          (a, b) =>
            ['region', 'province', 'municipality'].indexOf(a.level) -
              ['region', 'province', 'municipality'].indexOf(b.level) ||
            (a.territory_id < b.territory_id ? -1 : a.territory_id > b.territory_id ? 1 : 0),
        )
        .map((p) => `${['region', 'province', 'municipality'].indexOf(p.level)}:${p.territory_id}`);
      expect(keys).toEqual(sorted);
    }
    expect(dataset.meta.counts.variations).toBe(dataset.variations.length);
  });
});

describe('Sardinia 2026 (golden-4)', async () => {
  const built = await fixtureWorld(['2025-12-31', '2026-01-01'], {
    codes: {
      region: ['20'],
      province: ['090', '091', '092', '095', '111', '292', '113', '114', '115', '116', '117', '119', '312', '318'],
      municipality: ['090003', '112001', '095057', '115064', '111001', '119001'],
    },
    provinces: {
      graph: await utsGraph([
        ['090', 'province', '090_1_sassari.json'],
        ['312', 'metropolitan_city', '312_3_sassari.json'],
        ['092', 'province', '092_1_cagliari.json'],
        ['318', 'metropolitan_city', '318_3_cagliari.json'],
        ['111', 'province', '111_1_sud-sardegna.json'],
        ['113', 'province', '113_1_gallura-nord-est-sardegna.json'],
        ['114', 'province', '114_1_nuoro.json'],
        ['115', 'province', '115_1_oristano.json'],
        ['116', 'province', '116_1_ogliastra.json'],
        ['117', 'province', '117_1_medio-campidano.json'],
        ['119', 'province', '119_1_sulcis-iglesiente.json'],
      ]),
      details: ['126_ES_6151.json'],
    },
    municipalities: await municipalityGraph(['115064_siamanna.json']),
  });
  const dataset = await emitTwice(built, '2026-01-01');

  it('publishes SU for Sud Sardegna until 2025-12-31 and for Sulcis Iglesiente from 2026-01-01', () => {
    const su = dataset.provinces.flatMap((p) => p.versions).filter((v) => v.abbreviation === 'SU');
    expect(su.map((v) => [v.istat_code, v.valid_from, v.valid_until])).toEqual(
      expect.arrayContaining([
        ['111', expect.any(String), '2025-12-31'],
        ['119', '2026-01-01', null],
      ]),
    );
  });
});
