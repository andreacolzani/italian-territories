/**
 * Release tooling (§9): the CHANGELOG entry of a release, the checks of the release
 * workflows and the staging of the npm package.
 *
 * Usage: npm run release -- <command>
 *
 * - `changelog`: adds the CHANGELOG entry of `reports/meta.json`, unless the first entry already
 *   describes it, and writes the date of the data in the README (between its `data-version`
 *   markers, when they exist). Run after a build that changed the public files.
 * - `check`: the first CHANGELOG entry (and the README date) match `reports/meta.json`.
 * - `version`: prints the version of the first entry (after `check`).
 * - `notes`: prints the first entry without its heading (the GitHub Release notes).
 * - `pack <dir>`: stages the npm package in `<dir>` (empty or missing): the published files of
 *   `dist/` (data and JSON Schemas), their TypeScript declarations in `types/` (generated from
 *   the schemas), `README.md`, the data licence as `LICENSE` and a generated `package.json` (with the description and keywords of the dataset, not those of the generator) whose
 *   `exports` map each data file to its declarations. No executable code. The root
 *   `package.json` stays private: only the staged directory is published.
 * - `target <exit-code> <allow-main> <open-prs>`: where the output of a data run goes (`none`,
 *   `main` or `pr`, §10.3), decided by `dist/` only: `reports/`, `registry/` and the CHANGELOG
 *   are delivered only together with a change of `dist/`.
 *
 * The npm version is `MAJOR.YYYYMMDD.PATCH`: MAJOR is the major of `schema_version`, `YYYYMMDD`
 * the `data_version`, PATCH 0 for the first release of a `MAJOR.YYYYMMDD`, then incremented (a
 * schemas release, or a rebuild that changes the data without changing `data_version`).
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PUBLIC_FILE_MODELS, schemaFileName, type PublicFileName } from '../src/model/json-schema.ts';
import { changesSchema, metaSchema, type Changes, type Meta } from '../src/model/reports.ts';
import { typeDeclarations } from '../src/model/typescript.ts';

export const CHANGELOG_FILE = 'CHANGELOG.md';
export const README_FILE = 'README.md';
export const DATA_LICENSE_FILE = 'LICENSE-DATA';
/** The description of the npm package: the dataset, not the generator of the root `package.json`. */
export const DATA_DESCRIPTION =
  'Day-accurate historical dataset of Italian regions, provinces and municipalities from 1861 to today, from ISTAT SITUAS, with TypeScript types.';
/** The keywords of the npm package. */
export const DATA_KEYWORDS = [
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
];
/** The licence of the published data (SPDX). */
export const DATA_LICENSE = 'CC-BY-4.0';

export class ReleaseError extends Error {
  override readonly name = 'ReleaseError';
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

export interface Version {
  major: number;
  date: string;
  patch: number;
}

const VERSION_PATTERN = /^(\d+)\.(\d{8})\.(\d+)$/;

export function parseVersion(text: string): Version {
  const match = VERSION_PATTERN.exec(text);
  if (match === null) throw new ReleaseError(`not a release version (MAJOR.YYYYMMDD.PATCH): ${text}`);
  return { major: Number(match[1]), date: match[2] ?? '', patch: Number(match[3]) };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.date}.${v.patch}`;
}

/** The `MAJOR.YYYYMMDD` of a release: major of `schema_version`, `data_version` without dots. */
function versionBase(meta: ReleaseMeta): Omit<Version, 'patch'> {
  return { major: Number(meta.schema_version.split('.')[0]), date: meta.data_version.replaceAll('.', '') };
}

/** `YYYY.MM.DD` → `YYYY-MM-DD`. */
function isoDate(dataVersion: string): string {
  return dataVersion.replaceAll('.', '-');
}

// ---------------------------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------------------------

/** What a CHANGELOG entry records of `reports/meta.json`, in a comment, to recognise its release. */
const releaseMetaSchema = z.strictObject({
  schema_version: z.string(),
  data_version: z.string(),
  generated_at: z.string(),
});
export type ReleaseMeta = z.output<typeof releaseMetaSchema>;

export interface ChangelogEntry {
  version: string;
  /** Null for an entry written by hand (no release comment). */
  meta: ReleaseMeta | null;
  /** The entry without its heading and its release comment. */
  body: string;
}

const ENTRY_HEADING = /^## \[([^\]]+)\]/;
const RELEASE_COMMENT = /^<!-- release (\{.*\}) -->$/;

/** The entries of a CHANGELOG, first (latest) first. */
export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: { version: string; lines: string[] } | null = null;
  const close = () => {
    if (current === null) return;
    let meta: ReleaseMeta | null = null;
    const body: string[] = [];
    for (const line of current.lines) {
      const comment = RELEASE_COMMENT.exec(line);
      if (comment !== null && meta === null) meta = releaseMetaSchema.parse(JSON.parse(comment[1] ?? ''));
      else body.push(line);
    }
    entries.push({ version: current.version, meta, body: body.join('\n').trim() });
  };
  for (const line of text.split('\n')) {
    const heading = ENTRY_HEADING.exec(line);
    if (heading !== null) {
      close();
      current = { version: heading[1] ?? '', lines: [] };
    } else {
      current?.lines.push(line);
    }
  }
  close();
  return entries;
}

function sameRelease(a: ReleaseMeta | null, b: ReleaseMeta): boolean {
  return (
    a !== null &&
    a.schema_version === b.schema_version &&
    a.data_version === b.data_version &&
    a.generated_at === b.generated_at
  );
}

/** The version of a new release: PATCH = the highest PATCH of the same `MAJOR.YYYYMMDD` + 1, else 0. */
export function nextVersion(meta: ReleaseMeta, entries: readonly ChangelogEntry[]): string {
  const base = versionBase(meta);
  const patches = entries.flatMap((e) => {
    const match = VERSION_PATTERN.exec(e.version);
    if (match === null) return [];
    const v = parseVersion(e.version);
    return v.major === base.major && v.date === base.date ? [v.patch] : [];
  });
  return formatVersion({ ...base, patch: patches.length === 0 ? 0 : Math.max(...patches) + 1 });
}

const LEVEL_LABELS = [
  ['regions', 'Regions'],
  ['provinces', 'Provinces (UTS)'],
  ['municipalities', 'Municipalities'],
] as const;

/**
 * The entry of a release: a schemas release (same `data_version` as the previous entry, no
 * change) or a data release with its change counts per level (variations are internal, D39).
 */
export function renderEntry(version: string, meta: Meta, changes: Changes, previous: ChangelogEntry | null): string {
  const counts = LEVEL_LABELS.map(([level, label]) => {
    const { entities, versions } = changes[level];
    return { label, entities, versions };
  });
  const empty = counts.every(
    (c) =>
      c.entities.added.length + c.entities.updated.length + c.entities.removed.length === 0 &&
      c.versions.added.length + c.versions.updated.length + c.versions.removed.length === 0,
  );
  const schemas = empty && previous?.meta?.data_version === meta.data_version;
  const record: ReleaseMeta = {
    schema_version: meta.schema_version,
    data_version: meta.data_version,
    generated_at: meta.generated_at,
  };
  const lines = [
    `## [${version}] - ${isoDate(meta.data_version)}`,
    '',
    `<!-- release ${JSON.stringify(record)} -->`,
    '',
  ];
  if (schemas) {
    lines.push(
      `Schemas release: JSON Schemas ${meta.schema_version}; the data files are those of ${isoDate(meta.data_version)}.`,
    );
  } else {
    lines.push(`Data as of ${isoDate(meta.data_version)} (JSON Schemas ${meta.schema_version}).`, '');
    if (changes.from === null) lines.push('First release.', '');
    lines.push(
      '| Level | Entities added | Entities updated | Entities removed | Versions added | Versions updated | Versions removed |',
      '|---|---:|---:|---:|---:|---:|---:|',
      ...counts.map(
        ({ label, entities: e, versions: v }) =>
          `| ${label} | ${e.added.length} | ${e.updated.length} | ${e.removed.length} | ${v.added.length} | ${v.updated.length} | ${v.removed.length} |`,
      ),
    );
    if (changes.retroactive && changes.from !== null) {
      lines.push(
        '',
        `Retroactive: some changes affect days before ${isoDate(changes.from.data_version)}, the date of the previous release.`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Inserts an entry before the first one (after the introduction). */
export function insertEntry(changelog: string, entry: string): string {
  const lines = changelog.split('\n');
  const first = lines.findIndex((l) => ENTRY_HEADING.test(l));
  if (first === -1) return `${changelog.trimEnd()}\n\n${entry}`;
  return [...lines.slice(0, first), ...entry.split('\n'), ...lines.slice(first)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// README date
// ---------------------------------------------------------------------------------------------

const README_DATE = /(<!-- data-version -->)([^<]*)(<!-- \/data-version -->)/;

/** The date between the README markers, or `null` without markers. */
export function readmeDate(readme: string): string | null {
  return README_DATE.exec(readme)?.[2] ?? null;
}

/** The README with `date` between its markers (unchanged without markers). */
export function withReadmeDate(readme: string, date: string): string {
  return readme.replace(README_DATE, `$1${date}$3`);
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function readIfExists(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}

async function releaseFiles(root: string): Promise<{ meta: Meta; changes: Changes }> {
  return {
    meta: await readJson(join(root, 'reports', 'meta.json'), metaSchema),
    changes: await readJson(join(root, 'reports', 'changes.json'), changesSchema),
  };
}

/** Adds the entry of `reports/meta.json` unless the first entry describes it; returns its version. */
export async function changelog(root: string): Promise<{ version: string; added: boolean }> {
  const { meta, changes } = await releaseFiles(root);
  const path = join(root, CHANGELOG_FILE);
  const text = (await readIfExists(path)) ?? '# Changelog\n';
  const entries = parseChangelog(text);
  const first = entries[0] ?? null;
  let result: { version: string; added: boolean };
  if (first !== null && sameRelease(first.meta, meta)) {
    result = { version: first.version, added: false };
  } else {
    const version = nextVersion(meta, entries);
    await writeFile(path, insertEntry(text, renderEntry(version, meta, changes, first)), 'utf8');
    result = { version, added: true };
  }
  const readmePath = join(root, README_FILE);
  const readme = await readIfExists(readmePath);
  if (readme !== null && readmeDate(readme) !== null) {
    const updated = withReadmeDate(readme, isoDate(meta.data_version));
    if (updated !== readme) await writeFile(readmePath, updated, 'utf8');
  }
  return result;
}

/** The first entry of the CHANGELOG, checked against `reports/meta.json` and the README date. */
export async function check(root: string): Promise<ChangelogEntry> {
  const { meta } = await releaseFiles(root);
  const text = await readIfExists(join(root, CHANGELOG_FILE));
  const entries = parseChangelog(text ?? '');
  const first = entries[0];
  const fix = 'run npm run release -- changelog';
  if (first === undefined) throw new ReleaseError(`${CHANGELOG_FILE} has no entry: ${fix}`);
  if (!sameRelease(first.meta, meta)) {
    throw new ReleaseError(
      `the first entry of ${CHANGELOG_FILE} (${first.version}) does not describe reports/meta.json ` +
        `(${meta.schema_version}, ${meta.data_version}, ${meta.generated_at}): ${fix}`,
    );
  }
  const version = parseVersion(first.version);
  const base = versionBase(meta);
  if (version.major !== base.major || version.date !== base.date) {
    throw new ReleaseError(`version ${first.version} does not match ${base.major}.${base.date} of reports/meta.json`);
  }
  if (entries.filter((e) => e.version === first.version).length > 1) {
    throw new ReleaseError(`version ${first.version} appears twice in ${CHANGELOG_FILE}`);
  }
  const readme = await readIfExists(join(root, README_FILE));
  const date = readme === null ? null : readmeDate(readme);
  if (date !== null && date !== isoDate(meta.data_version)) {
    throw new ReleaseError(`the README date (${date}) is not ${isoDate(meta.data_version)}: ${fix}`);
  }
  return first;
}

/** Stages the npm package in `dir` (empty or missing); returns its version. */
export async function pack(root: string, dir: string): Promise<string> {
  const { version } = await check(root);
  const readme = await readIfExists(join(root, README_FILE));
  if (readme === null) throw new ReleaseError(`${README_FILE} is missing: the npm package needs it`);
  const licence = await readIfExists(join(root, DATA_LICENSE_FILE));
  if (licence === null) throw new ReleaseError(`${DATA_LICENSE_FILE} is missing: the npm package needs it`);
  const existing = await readdir(dir).catch(() => []);
  if (existing.length > 0) throw new ReleaseError(`${dir} is not empty`);

  const project = await readJson(
    join(root, 'package.json'),
    z.looseObject({
      name: z.string(),
      repository: z.unknown(),
      homepage: z.string(),
      bugs: z.unknown(),
    }),
  );
  const names = Object.keys(PUBLIC_FILE_MODELS) as PublicFileName[];
  const files = await Promise.all(
    names.map(async (name) => {
      const data = join('dist', `${name}.json`);
      const schema = join('dist', 'schema', schemaFileName(name));
      for (const path of [data, schema]) {
        if ((await readIfExists(join(root, path))) === null) throw new ReleaseError(`${path} is missing`);
      }
      const schemaText = await readFile(join(root, schema), 'utf8');
      return {
        name,
        data,
        schema,
        json: JSON.parse(schemaText) as Record<string, unknown>,
      };
    }),
  );
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'dist', 'schema'), { recursive: true });
  await mkdir(join(dir, 'types'));
  for (const file of files) {
    await cp(join(root, file.data), join(dir, file.data));
    await cp(join(root, file.schema), join(dir, file.schema));
    await writeFile(join(dir, 'types', `${file.name}.d.mts`), typeDeclarations(file.name, file.json, 'esm'), 'utf8');
    await writeFile(join(dir, 'types', `${file.name}.d.cts`), typeDeclarations(file.name, file.json, 'cjs'), 'utf8');
  }
  await writeFile(join(dir, README_FILE), readme, 'utf8');
  await writeFile(join(dir, 'LICENSE'), licence, 'utf8');
  const manifest = {
    name: project.name,
    version,
    description: DATA_DESCRIPTION,
    keywords: DATA_KEYWORDS,
    license: DATA_LICENSE,
    repository: project.repository,
    homepage: project.homepage,
    bugs: project.bugs,
    files: ['dist/', 'types/'],
    exports: {
      ...Object.fromEntries(
        names.map((name) => [
          `./${name}.json`,
          {
            types: { import: `./types/${name}.d.mts`, require: `./types/${name}.d.cts` },
            default: `./dist/${name}.json`,
          },
        ]),
      ),
      './schema/*.json': './dist/schema/*.json',
      './package.json': './package.json',
    },
  };
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return version;
}

/** Where the output of a data run goes (§10.3): nothing, a commit to `main`, or the `data-update` PR. */
export type DeliveryTarget = 'none' | 'main' | 'pr';

/** Whether the working tree of `root` changes `dist/` (tracked or untracked files). */
export async function distChanged(root: string): Promise<boolean> {
  const { stdout } = await promisify(execFile)('git', ['status', '--porcelain', '--', 'dist'], { cwd: root });
  return stdout.trim() !== '';
}

/**
 * The delivery of a data run that ended with exit 0 or 2: only a change of `dist/` is delivered
 * (`reports/`, `registry/` and the CHANGELOG go with it, never alone); exit 0 goes to `main` when
 * allowed and no `data-update` PR is open, anything else to the PR.
 */
export async function deliveryTarget(
  root: string,
  options: { exitCode: number; allowMain: boolean; openPrs: number },
): Promise<DeliveryTarget> {
  if (options.exitCode !== 0 && options.exitCode !== 2) {
    throw new ReleaseError(`no delivery for exit code ${options.exitCode} (only 0 or 2)`);
  }
  if (!(await distChanged(root))) return 'none';
  return options.allowMain && options.exitCode === 0 && options.openPrs === 0 ? 'main' : 'pr';
}

const USAGE =
  'usage: npm run release -- changelog | check | version | notes | pack <dir> | target <exit-code> <allow-main> <open-prs>';

function integerArg(text: string | undefined): number {
  if (text === undefined || !/^\d+$/.test(text)) throw new ReleaseError(USAGE);
  return Number(text);
}

export async function main(argv: readonly string[], root: string, out: (text: string) => void): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case 'changelog': {
      const { version, added } = await changelog(root);
      out(`${added ? 'added' : 'already present'}: ${version}\n`);
      return;
    }
    case 'check':
      out(`ok: ${(await check(root)).version}\n`);
      return;
    case 'version':
      out(`${(await check(root)).version}\n`);
      return;
    case 'notes':
      out(`${(await check(root)).body}\n`);
      return;
    case 'pack': {
      const [dir] = args;
      if (dir === undefined) throw new ReleaseError(USAGE);
      out(`staged ${await pack(root, resolve(dir))} in ${resolve(dir)}\n`);
      return;
    }
    case 'target': {
      const [exitCode, allowMain, openPrs] = args;
      if (allowMain !== 'true' && allowMain !== 'false') throw new ReleaseError(USAGE);
      const target = await deliveryTarget(root, {
        exitCode: integerArg(exitCode),
        allowMain: allowMain === 'true',
        openPrs: integerArg(openPrs),
      });
      out(`${target}\n`);
      return;
    }
    default:
      throw new ReleaseError(USAGE);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    await main(process.argv.slice(2), process.cwd(), (text) => process.stdout.write(text));
  } catch (error) {
    process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
