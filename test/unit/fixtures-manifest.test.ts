import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { describeRequest, FIXTURES_ROOT, loadManifest, subsetBasePath, type Manifest } from '../helpers/fixtures.ts';

const PLAN_PATH = resolve(FIXTURES_ROOT, '../../docs/GENERATOR_IMPLEMENTATION_PLAN.md');

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'));
}

/** Text of a markdown section: from its heading to the next heading of the same or higher level. */
function section(markdown: string, heading: RegExp): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) throw new Error(`Section ${heading} not found in the plan`);
  const depth = /^#+/.exec(lines[start] ?? '')?.[0].length ?? 0;
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && (/^#+/.exec(l)?.[0].length ?? 0) <= depth);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function numberedItems(text: string): Set<number> {
  return new Set([...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])));
}

describe('fixture manifest (§11.1)', () => {
  let manifest: Manifest;
  let files: string[];

  beforeAll(async () => {
    manifest = await loadManifest();
    files = (await listFiles(FIXTURES_ROOT)).filter((f) => f !== 'manifest.json');
  });

  it('has exactly one entry per fixture file and vice versa', () => {
    const paths = manifest.fixtures.map((e) => e.path);
    const duplicates = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(duplicates).toEqual([]);
    expect([...paths].sort()).toEqual([...files].sort());
  });

  it('stores every fixture at the path derived from its request', () => {
    for (const entry of manifest.fixtures) {
      const expected = describeRequest(entry.request, { downloadDate: entry.fetched_at });
      const actual = entry.completeness === 'subset' ? subsetBasePath(entry.path) : entry.path;
      expect(actual, entry.path).toBe(expected.path);
      expect(entry.source, entry.path).toBe(expected.source);
      expect(entry.endpoint, entry.path).toBe(expected.endpoint);
    }
  });

  it('marks subsets consistently with their file names', () => {
    for (const entry of manifest.fixtures) {
      expect(entry.path.includes('__subset-'), entry.path).toBe(entry.completeness === 'subset');
    }
  });

  it('references only golden cases and quirks that exist in the plan', async () => {
    const plan = await readFile(PLAN_PATH, 'utf8');
    const golden = numberedItems(section(plan, /^## 11\. /));
    const quirks = numberedItems(section(plan, /^### 3\.5 /));
    expect(golden.size).toBeGreaterThan(0);
    expect(quirks.size).toBeGreaterThan(0);
    for (const entry of manifest.fixtures) {
      for (const ref of entry.used_by) {
        const [kind, n] = ref.split('-') as ['golden' | 'quirk', string];
        const known = kind === 'golden' ? golden : quirks;
        expect(known.has(Number(n)), `${entry.path}: ${ref}`).toBe(true);
      }
    }
  });
});
