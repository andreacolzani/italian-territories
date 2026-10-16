import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { generateJsonSchemas } from '../../src/model/json-schema.ts';
import type { Changes, Meta } from '../../src/model/reports.ts';
import {
  changelog,
  check,
  deliveryTarget,
  nextVersion,
  pack,
  parseChangelog,
  ReleaseError,
  type ChangelogEntry,
} from '../../scripts/release.ts';
import { BUNDLER, NODE_NEXT, typeErrors } from '../helpers/typescript.ts';

const META: Meta = {
  schema_version: '1.0.0',
  data_version: '2026.10.07',
  generated_at: '2026-10-10T01:07:36Z',
  sources: { 'situas-public-snapshots': null, 'situas-public-reports': null, 'situas-internal': null, anpr: null },
  counts: {
    regions: { entities: 1, active: 1, versions: 1 },
    provinces: { entities: 1, active: 1, versions: 1 },
    municipalities: { entities: 2, active: 2, versions: 2 },
    variations: 0,
  },
  anomalies: { warning: 0, info: 0 },
};

const none = () => ({ added: [], updated: [], removed: [] });

function changes(options: { from: string | null; to: Meta; retroactive?: boolean; added?: number }): Changes {
  const retroactive = options.retroactive ?? false;
  const added = Array.from({ length: options.added ?? 0 }, (_, i) => ({
    id: `mun-${String(i).padStart(6, '0')}`,
    retroactive,
  }));
  return {
    from: options.from === null ? null : { data_version: options.from, generated_at: '2026-10-01T00:00:00Z' },
    to: { data_version: options.to.data_version, generated_at: options.to.generated_at },
    retroactive,
    regions: { entities: none(), versions: none() },
    provinces: { entities: none(), versions: none() },
    municipalities: { entities: { ...none(), added }, versions: none() },
    variations: none(),
  };
}

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  roots = [];
});

async function project(options: { readme?: string | null; licence?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'it-release-'));
  roots.push(root);
  await mkdir(join(root, 'reports'));
  await mkdir(join(root, 'dist', 'schema'), { recursive: true });
  for (const name of ['regions', 'provinces', 'municipalities']) {
    await writeFile(join(root, 'dist', `${name}.json`), '[]\n');
  }
  for (const [file, schema] of Object.entries(generateJsonSchemas())) {
    await writeFile(join(root, 'dist', 'schema', file), `${JSON.stringify(schema, null, 2)}\n`);
  }
  // Not a published file: never staged.
  await writeFile(join(root, 'dist', '.gitkeep'), '');
  await writeFile(join(root, CHANGELOG), '# Changelog\n\nAll notable changes.\n');
  if (options.readme !== null) {
    await writeFile(
      join(root, 'README.md'),
      options.readme ?? '# Data\n\nData of <!-- data-version -->?<!-- /data-version -->.\n',
    );
  }
  if (options.licence !== false) await writeFile(join(root, 'LICENSE-DATA'), 'CC BY 4.0\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'italian-territories',
      version: '0.0.0',
      description: 'Territories',
      private: true,
      repository: { type: 'git', url: 'git+https://example.org/repo.git' },
      homepage: 'https://example.org',
      bugs: { url: 'https://example.org/issues' },
      dependencies: { zod: '^4' },
    }),
  );
  await release(root, META, changes({ from: null, to: META, added: 2 }));
  return root;
}

const CHANGELOG = 'CHANGELOG.md';

async function release(root: string, meta: Meta, change: Changes): Promise<void> {
  await writeFile(join(root, 'reports', 'meta.json'), JSON.stringify(meta));
  await writeFile(join(root, 'reports', 'changes.json'), JSON.stringify(change));
}

function entry(version: string): ChangelogEntry {
  return { version, meta: null, body: '' };
}

describe('nextVersion', () => {
  it('starts each MAJOR.YYYYMMDD at PATCH 0 and increments the highest PATCH', () => {
    expect(nextVersion(META, [])).toBe('1.20261007.0');
    expect(nextVersion(META, [entry('1.20261001.0'), entry('Unreleased')])).toBe('1.20261007.0');
    expect(nextVersion(META, [entry('1.20261007.2'), entry('1.20261007.0'), entry('1.20261007.1')])).toBe(
      '1.20261007.3',
    );
    // A new major with the same data_version starts again from 0.
    expect(nextVersion({ ...META, schema_version: '2.0.0' }, [entry('1.20261007.4')])).toBe('2.20261007.0');
  });
});

describe('changelog', () => {
  it('adds the entry of the release once, and writes the README date', async () => {
    const root = await project();
    expect(await changelog(root)).toEqual({ version: '1.20261007.0', added: true });
    const text = await readFile(join(root, CHANGELOG), 'utf8');
    expect(text.startsWith('# Changelog\n\nAll notable changes.\n\n## [1.20261007.0] - 2026-10-07\n')).toBe(true);
    expect(text).toContain('First release.');
    expect(text).toContain('| Municipalities | 2 | 0 | 0 | 0 | 0 | 0 |');
    expect(await readFile(join(root, 'README.md'), 'utf8')).toContain(
      '<!-- data-version -->2026-10-07<!-- /data-version -->',
    );

    expect(await changelog(root)).toEqual({ version: '1.20261007.0', added: false });
    expect(await readFile(join(root, CHANGELOG), 'utf8')).toBe(text);
    expect((await check(root)).version).toBe('1.20261007.0');
  });

  it('gives a schemas release the next PATCH, before the previous entries', async () => {
    const root = await project();
    await changelog(root);
    const meta = { ...META, schema_version: '1.1.0', generated_at: '2026-10-12T08:00:00Z' };
    await release(root, meta, changes({ from: META.data_version, to: meta }));
    expect(await changelog(root)).toEqual({ version: '1.20261007.1', added: true });
    const entries = parseChangelog(await readFile(join(root, CHANGELOG), 'utf8'));
    expect(entries.map((e) => e.version)).toEqual(['1.20261007.1', '1.20261007.0']);
    expect(entries[0]?.body).toMatch(/^Schemas release: JSON Schemas 1\.1\.0/);
    expect(entries[0]?.meta).toEqual({
      schema_version: '1.1.0',
      data_version: '2026.10.07',
      generated_at: '2026-10-12T08:00:00Z',
    });
  });

  it('reports a retroactive data release', async () => {
    const root = await project();
    await changelog(root);
    const meta = { ...META, data_version: '2026.10.14', generated_at: '2026-10-14T04:00:00Z' };
    await release(root, meta, changes({ from: META.data_version, to: meta, retroactive: true, added: 1 }));
    expect(await changelog(root)).toEqual({ version: '1.20261014.0', added: true });
    const [first] = parseChangelog(await readFile(join(root, CHANGELOG), 'utf8'));
    expect(first?.body).toContain('Data as of 2026-10-14');
    expect(first?.body).toContain('Retroactive: some changes affect days before 2026-10-07');
  });
});

describe('check', () => {
  it('fails when the first entry does not describe reports/meta.json', async () => {
    const root = await project();
    await expect(check(root)).rejects.toThrow(/has no entry/);
    await changelog(root);
    const meta = { ...META, data_version: '2026.10.14', generated_at: '2026-10-14T04:00:00Z' };
    await release(root, meta, changes({ from: META.data_version, to: meta }));
    await expect(check(root)).rejects.toThrow(ReleaseError);
    await expect(check(root)).rejects.toThrow(/does not describe reports\/meta\.json/);
  });

  it('fails when the README date is not the date of the data', async () => {
    const root = await project();
    await changelog(root);
    await writeFile(join(root, 'README.md'), 'Data of <!-- data-version -->2026-01-01<!-- /data-version -->\n');
    await expect(check(root)).rejects.toThrow(/README date \(2026-01-01\)/);
  });

  it('accepts a README without the date markers', async () => {
    const root = await project({ readme: '# Data\n' });
    await changelog(root);
    expect((await check(root)).version).toBe('1.20261007.0');
  });
});

describe('pack', () => {
  const entry = (name: string) => ({
    types: { import: `./types/${name}.d.mts`, require: `./types/${name}.d.cts` },
    default: `./dist/${name}.json`,
  });

  it('stages the published files, their type declarations, the README, the data licence and a package.json', async () => {
    const root = await project();
    await changelog(root);
    const dir = join(root, 'staged');
    expect(await pack(root, dir)).toBe('1.20261007.0');
    expect((await readdir(dir)).sort()).toEqual(['LICENSE', 'README.md', 'dist', 'package.json', 'types']);
    expect((await readdir(join(dir, 'dist'), { recursive: true })).sort()).toEqual(
      [
        'municipalities.json',
        'provinces.json',
        'regions.json',
        'schema',
        join('schema', 'municipalities.schema.json'),
        join('schema', 'provinces.schema.json'),
        join('schema', 'regions.schema.json'),
      ].sort(),
    );
    expect((await readdir(join(dir, 'types'))).sort()).toEqual([
      'municipalities.d.cts',
      'municipalities.d.mts',
      'provinces.d.cts',
      'provinces.d.mts',
      'regions.d.cts',
      'regions.d.mts',
    ]);
    expect(await readFile(join(dir, 'LICENSE'), 'utf8')).toBe('CC BY 4.0\n');
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toEqual({
      name: 'italian-territories',
      version: '1.20261007.0',
      description:
        'Day-accurate historical dataset of Italian regions, provinces and municipalities from 1861 to today, from ISTAT SITUAS, with TypeScript types.',
      keywords: [
        'italy',
        'istat',
        'municipalities',
        'comuni',
        'province',
        'regioni',
        'dataset',
        'historical',
        'codici-istat',
        'codice-catastale',
      ],
      license: 'CC-BY-4.0',
      repository: { type: 'git', url: 'git+https://example.org/repo.git' },
      homepage: 'https://example.org',
      bugs: { url: 'https://example.org/issues' },
      files: ['dist/', 'types/'],
      exports: {
        './regions.json': entry('regions'),
        './provinces.json': entry('provinces'),
        './municipalities.json': entry('municipalities'),
        './schema/*.json': './dist/schema/*.json',
        './package.json': './package.json',
      },
    });
    // Never into a directory holding something else.
    await expect(pack(root, dir)).rejects.toThrow(/not empty/);
  });

  it('serves the files and their types through exports, to import and require', async () => {
    const root = await project();
    await changelog(root);
    const consumer = join(root, 'consumer');
    await pack(root, join(consumer, 'node_modules', 'italian-territories'));
    await writeFile(join(consumer, 'package.json'), '{ "type": "module" }\n');
    await writeFile(
      join(consumer, 'esm.ts'),
      [
        "import municipalities from 'italian-territories/municipalities.json' with { type: 'json' };",
        "import provinces from 'italian-territories/provinces.json' with { type: 'json' };",
        "import regions from 'italian-territories/regions.json' with { type: 'json' };",
        "import type { Municipality, MunicipalityVersion, Link } from 'italian-territories/municipalities.json';",
        "import pkg from 'italian-territories/package.json' with { type: 'json' };",
        "import schema from 'italian-territories/schema/regions.schema.json' with { type: 'json' };",
        'const all: Municipality[] = municipalities;',
        'const version: MunicipalityVersion | undefined = all[0]?.versions[0];',
        'const until: string | null | undefined = version?.valid_until;',
        'const links: Link[] | undefined = all[0]?.successors;',
        "const type: 'province' | 'autonomous_province' | 'metropolitan_city' | 'free_municipal_consortium' | 'non_administrative_unit' | undefined = provinces[0]?.versions[0]?.type;",
        'console.log(JSON.stringify([all.length, regions.length, until ?? null, links ?? null, type ?? null, pkg.version, schema.title]));',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(consumer, 'cjs.cts'),
      [
        "import municipalities = require('italian-territories/municipalities.json');",
        'const all: municipalities.Municipality[] = municipalities;',
        'console.log(JSON.stringify([all.length]));',
        '',
      ].join('\n'),
    );
    const esm = join(consumer, 'esm.ts');
    expect(typeErrors([esm, join(consumer, 'cjs.cts')], { ...NODE_NEXT, resolveJsonModule: true })).toEqual([]);
    expect(typeErrors([esm], BUNDLER)).toEqual([]);
    // At run time Node resolves the same exports (the declarations are never loaded).
    const node = (script: string) =>
      promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: consumer });
    const { stdout } = await node(
      [
        "import m from 'italian-territories/municipalities.json' with { type: 'json' };",
        "import pkg from 'italian-territories/package.json' with { type: 'json' };",
        "import { createRequire } from 'node:module';",
        'const r = createRequire(import.meta.url);',
        "console.log(JSON.stringify([m, pkg.version, r('italian-territories/regions.json'), r('italian-territories/schema/provinces.schema.json').title]));",
      ].join('\n'),
    );
    expect(JSON.parse(stdout)).toEqual([[], '1.20261007.0', [], 'Provinces']);
    await expect(node("import 'italian-territories/types/regions.d.mts';")).rejects.toThrow(
      /not exported|NOT_EXPORTED/,
    );
  });

  it('fails without a published file', async () => {
    const root = await project();
    await changelog(root);
    await rm(join(root, 'dist', 'schema', 'provinces.schema.json'));
    await expect(pack(root, join(root, 'staged'))).rejects.toThrow(/provinces\.schema\.json is missing/);
  });

  it('fails without the README or the data licence', async () => {
    const withoutReadme = await project({ readme: null });
    await changelog(withoutReadme);
    await expect(pack(withoutReadme, join(withoutReadme, 'staged'))).rejects.toThrow(/README\.md is missing/);
    const withoutLicence = await project({ licence: false });
    await changelog(withoutLicence);
    await expect(pack(withoutLicence, join(withoutLicence, 'staged'))).rejects.toThrow(/LICENSE-DATA is missing/);
  });

  it('fails when the CHANGELOG does not describe the release', async () => {
    const root = await project();
    await expect(pack(root, join(root, 'staged'))).rejects.toThrow(/has no entry/);
  });
});

describe('deliveryTarget', () => {
  async function git(root: string, ...args: string[]): Promise<void> {
    await promisify(execFile)('git', args, { cwd: root });
  }

  /** A committed release: `dist/`, `reports/`, `registry/` and the CHANGELOG. */
  async function repository(): Promise<string> {
    const root = await project();
    await changelog(root);
    await mkdir(join(root, 'registry'));
    await writeFile(join(root, 'registry', 'regions.json'), '{}\n');
    await git(root, 'init', '--quiet');
    await git(root, 'add', '--all');
    await git(root, '-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '--quiet', '-m', 'release');
    return root;
  }

  const every = [
    { exitCode: 0, allowMain: true, openPrs: 0 },
    { exitCode: 0, allowMain: false, openPrs: 0 },
    { exitCode: 2, allowMain: true, openPrs: 1 },
  ];

  it('delivers nothing when only reports/, registry/ or the CHANGELOG changed', async () => {
    const root = await repository();
    for (const options of every) expect(await deliveryTarget(root, options)).toBe('none');
    await writeFile(join(root, 'reports', 'anomalies.json'), '[]\n');
    await writeFile(join(root, 'registry', 'regions.json'), '{"kind":"region"}\n');
    await writeFile(join(root, 'registry', 'remaps.json'), '[]\n');
    await writeFile(join(root, CHANGELOG), '# Changelog\n');
    for (const options of every) expect(await deliveryTarget(root, options)).toBe('none');
  });

  it('delivers a change of dist/ to main only with exit 0, main allowed and no open PR', async () => {
    const root = await repository();
    await writeFile(join(root, 'dist', 'regions.json'), '[{}]\n');
    expect(await deliveryTarget(root, { exitCode: 0, allowMain: true, openPrs: 0 })).toBe('main');
    expect(await deliveryTarget(root, { exitCode: 0, allowMain: true, openPrs: 1 })).toBe('pr');
    expect(await deliveryTarget(root, { exitCode: 0, allowMain: false, openPrs: 0 })).toBe('pr');
    expect(await deliveryTarget(root, { exitCode: 2, allowMain: true, openPrs: 0 })).toBe('pr');
  });

  it('sees a new file in dist/ and refuses the exit codes without delivery', async () => {
    const root = await repository();
    await writeFile(join(root, 'dist', 'schema', 'new.schema.json'), '[]\n');
    expect(await deliveryTarget(root, { exitCode: 0, allowMain: true, openPrs: 0 })).toBe('main');
    for (const exitCode of [1, 3]) {
      await expect(deliveryTarget(root, { exitCode, allowMain: true, openPrs: 0 })).rejects.toThrow(ReleaseError);
    }
  });
});
