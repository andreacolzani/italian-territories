/**
 * A published dataset read back from a directory (the previous release, §9): every file validated
 * with its public model. A directory without `meta.json` holds no release.
 */
import { join } from 'node:path';
import type { z } from 'zod';
import { PUBLIC_FILE_MODELS, schemaFileName, type PublicFileName } from '../model/json-schema.ts';
import type { Anomaly, Changes, Meta } from '../model/public.ts';
import { readTextIfExists } from '../store/index.ts';
import { EmitError } from './errors.ts';
import type { PublicData } from './public.ts';

export interface PublishedDataset extends PublicData {
  meta: Meta;
  anomalies: Anomaly[];
  changes: Changes;
  /** The published JSON Schema files, by file name (`regions.schema.json`), as text. */
  schemas: Record<string, string>;
}

export async function loadPublishedDataset(dir: string): Promise<PublishedDataset | null> {
  const metaText = await readTextIfExists(join(dir, 'meta.json'));
  if (metaText === undefined) return null;
  const read = async <N extends PublicFileName>(name: N): Promise<z.output<(typeof PUBLIC_FILE_MODELS)[N]>> => {
    const path = join(dir, `${name}.json`);
    const text = name === 'meta' ? metaText : await readTextIfExists(path);
    if (text === undefined) throw new EmitError(`${path}: missing from the published dataset`);
    return parsePublicFile(name, JSON.parse(text) as unknown, path);
  };
  return {
    meta: await read('meta'),
    regions: await read('regions'),
    provinces: await read('provinces'),
    municipalities: await read('municipalities'),
    variations: await read('variations'),
    anomalies: await read('anomalies'),
    changes: await read('changes'),
    schemas: await readSchemas(dir),
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

/** Validates `value` with the public model of `name`; a violation is an `EmitError`. */
export function parsePublicFile<N extends PublicFileName>(
  name: N,
  value: unknown,
  where = `${name}.json`,
): z.output<(typeof PUBLIC_FILE_MODELS)[N]> {
  const result = PUBLIC_FILE_MODELS[name].safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new EmitError(`${where} violates its public model (${result.error.issues.length} issues): ${issues}`);
  }
  return result.data as z.output<(typeof PUBLIC_FILE_MODELS)[N]>;
}
