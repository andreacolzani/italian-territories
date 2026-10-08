/**
 * A release read back (the previous release, §9): the public files of `dist/` and the internal
 * reports of `reports/`, every file validated with its model. A release without
 * `reports/meta.json` does not exist.
 */
import { join } from 'node:path';
import type { z } from 'zod';
import {
  PUBLIC_FILE_MODELS,
  RELEASE_FILE_MODELS,
  REPORT_FILE_MODELS,
  schemaFileName,
  type PublicFileName,
  type ReleaseFileName,
} from '../model/json-schema.ts';
import type { Anomaly, Changes, Meta, Variation } from '../model/reports.ts';
import { readTextIfExists } from '../store/index.ts';
import { EmitError } from './errors.ts';
import type { PublicData } from './public.ts';

/** Where a release lives: the published files and the internal reports (§9). */
export interface ReleaseDirs {
  /** `paths.dist`. */
  dist: string;
  /** `paths.releaseReports`. */
  reports: string;
}

export interface PublishedDataset extends PublicData {
  variations: Variation[];
  meta: Meta;
  anomalies: Anomaly[];
  changes: Changes;
  /** The published JSON Schema files, by file name (`regions.schema.json`), as text. */
  schemas: Record<string, string>;
}

export async function loadPublishedDataset(dirs: ReleaseDirs): Promise<PublishedDataset | null> {
  const metaPath = join(dirs.reports, 'meta.json');
  const metaText = await readTextIfExists(metaPath);
  if (metaText === undefined) return null;
  const read = async <N extends ReleaseFileName>(name: N): Promise<z.output<(typeof RELEASE_FILE_MODELS)[N]>> => {
    const path = join(name in REPORT_FILE_MODELS ? dirs.reports : dirs.dist, `${name}.json`);
    const text = name === 'meta' ? metaText : await readTextIfExists(path);
    if (text === undefined) throw new EmitError(`${path}: missing from the release`);
    return parseReleaseFile(name, JSON.parse(text) as unknown, path);
  };
  return {
    meta: await read('meta'),
    regions: await read('regions'),
    provinces: await read('provinces'),
    municipalities: await read('municipalities'),
    variations: await read('variations'),
    anomalies: await read('anomalies'),
    changes: await read('changes'),
    schemas: await readSchemas(dirs.dist),
  };
}

/** The schema files of the current generator found in `dir/schema/` (missing ones are left out). */
async function readSchemas(dir: string): Promise<Record<string, string>> {
  const schemas: Record<string, string> = {};
  for (const name of Object.keys(PUBLIC_FILE_MODELS) as PublicFileName[]) {
    const file = schemaFileName(name);
    const text = await readTextIfExists(join(dir, 'schema', file));
    if (text !== undefined) schemas[file] = text;
  }
  return schemas;
}

/** Validates `value` with the model of the release file `name`; a violation is an `EmitError`. */
export function parseReleaseFile<N extends ReleaseFileName>(
  name: N,
  value: unknown,
  where = `${name}.json`,
): z.output<(typeof RELEASE_FILE_MODELS)[N]> {
  const result = RELEASE_FILE_MODELS[name].safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new EmitError(`${where} violates its model (${result.error.issues.length} issues): ${issues}`);
  }
  return result.data as z.output<(typeof RELEASE_FILE_MODELS)[N]>;
}
