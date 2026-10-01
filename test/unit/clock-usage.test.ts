import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..', 'src');

/**
 * Files allowed to read the clock (§12.0 Determinism): the date library that wraps it, the CLI
 * boundary (default of `dates.today`) and the HTTP client (`fetched_at`, cache freshness).
 */
const ALLOWED = new Set(['dates/calendar-date.ts', 'cli.ts', 'http/clock.ts', 'http/client.ts']);

const CLOCK_READS = /\bnew Date\(|\bDate\.now\(|\bcurrentDate\(|\bperformance\.now\(/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => relative(SRC, join(e.parentPath, e.name)).split(sep).join('/'));
}

describe('clock usage', () => {
  it('is confined to the CLI boundary, the date library and the HTTP client', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      if (ALLOWED.has(file)) continue;
      const text = await readFile(join(SRC, file), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (CLOCK_READS.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
