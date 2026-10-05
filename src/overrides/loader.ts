/**
 * Override loader (§6.10): every `*.json` file of the overrides directory (other files, such as
 * `.gitkeep`, are ignored), validated with the zod schema and converted to the internal model
 * (camelCase, half-open target interval).
 *
 * The overrides are curated repository content, so a problem with them is a defect of the
 * repository, not of the data: an unreadable or invalid file, a key used twice, or two overrides of
 * the same field and code over overlapping periods throw `OverrideFileError` instead of becoming
 * anomalies.
 */
import { join } from 'node:path';
import { compareDates, overlaps, toExclusiveEnd, type HalfOpenInterval } from '../dates/index.ts';
import { listFiles, readTextIfExists } from '../store/index.ts';
import { overrideFileSchema, type OverrideEntry, type OverrideField } from './schema.ts';

export interface Override {
  key: string;
  /** File name inside the overrides directory. */
  file: string;
  level: OverrideEntry['target']['level'];
  istatCode: string;
  /** The target period, half-open. */
  target: HalfOpenInterval;
  field: OverrideField;
  value: string;
  reason: string;
  source: string;
  sourceUrl: string | null;
}

export class OverrideFileError extends Error {
  readonly file: string;

  constructor(message: string, file: string) {
    super(`${message} (${file})`);
    this.name = 'OverrideFileError';
    this.file = file;
  }
}

/** The overrides of `dir`, sorted by key (none if the directory does not exist). */
export async function loadOverrides(dir: string): Promise<Override[]> {
  const files = (await listFiles(dir)).filter((name) => name.endsWith('.json')).sort();
  const overrides: Override[] = [];
  for (const file of files) {
    const text = await readTextIfExists(join(dir, file));
    if (text === undefined) throw new OverrideFileError('file disappeared while loading', file);
    overrides.push(...parseOverrideFile(file, text));
  }
  return checkConsistency(overrides).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The overrides of one file's text. */
export function parseOverrideFile(file: string, text: string): Override[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new OverrideFileError(`invalid JSON: ${(error as Error).message}`, file);
  }
  const parsed = overrideFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new OverrideFileError(`invalid overrides: ${issues}`, file);
  }
  return parsed.data.map((entry) => toOverride(file, entry));
}

function toOverride(file: string, entry: OverrideEntry): Override {
  return {
    key: entry.key,
    file,
    level: entry.target.level,
    istatCode: entry.target.istat_code,
    target: { validFrom: entry.target.date_from, validTo: toExclusiveEnd(entry.target.date_to) },
    field: entry.field,
    value: entry.value,
    reason: entry.reason,
    source: entry.source,
    sourceUrl: entry.source_url,
  };
}

function checkConsistency(overrides: Override[]): Override[] {
  const byKey = new Map<string, Override>();
  for (const override of overrides) {
    const previous = byKey.get(override.key);
    if (previous !== undefined) {
      throw new OverrideFileError(`key ${override.key} already used in ${previous.file}`, override.file);
    }
    byKey.set(override.key, override);
  }
  const subject = (o: Override): string => `${o.level}:${o.field}:${o.istatCode}`;
  const sorted = [...overrides].sort((a, b) => compareDates(a.target.validFrom, b.target.validFrom));
  sorted.forEach((a, i) => {
    const conflict = sorted.slice(i + 1).find((b) => subject(b) === subject(a) && overlaps(a.target, b.target));
    if (conflict !== undefined) {
      throw new OverrideFileError(
        `overrides ${a.key} and ${conflict.key} change ${a.field} of ${a.level} ${a.istatCode} on overlapping periods`,
        conflict.file,
      );
    }
  });
  return overrides;
}
