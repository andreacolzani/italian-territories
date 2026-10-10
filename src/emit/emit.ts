/**
 * Emit (§6.12, §9, Step 16): writes a release, the public files into `dist/` and the internal
 * reports into `reports/` (D39).
 *
 * - Every file is built in its model and validated before anything is written (`EmitError`
 *   otherwise).
 * - Whether a release happens is decided by the **public** files only:
 *   - `unchanged`: the three data files (regions, provinces, municipalities) and the JSON Schemas are
 *     identical to the previous release: nothing is written, the reports included (they describe
 *     the build of the published release, even when, e.g., only the description of an act changed);
 *     the caller reports the current anomalies (run summary, Step 17).
 *   - `schemas`: same data files, different JSON Schemas (a generator change): `schema/*.schema.json`,
 *     an empty, non-retroactive `reports/changes.json` and `reports/meta.json` are written, so the
 *     published schemas never lag behind the generator. The data files and the other reports stay
 *     those of the previous release, and so does its meta (`data_version` identifies the data
 *     content) except `schema_version` and `generated_at`.
 *   - `data`: the data files, the schemas and every report are written.
 *
 * `reports/meta.json` is always written last (each file atomically), so a release with a new meta
 * is complete. `generatedAt` is passed in: the emitter never reads the clock (§12.0).
 */
import { join } from 'node:path';
import type { IsoDate } from '../dates/index.ts';
import { generateJsonSchemas } from '../model/json-schema.ts';
import type { Anomaly as InternalAnomaly } from '../model/internal.ts';
import type { Anomaly, Changes, Meta, Variation } from '../model/reports.ts';
import { writeFileAtomic } from '../store/index.ts';
import { computeChanges } from './changes.ts';
import { parseReleaseFile, type PublishedDataset, type ReleaseDirs } from './dataset.ts';
import { serialize } from './format.ts';
import { buildMeta, SCHEMA_VERSION, type SourceSummaries } from './meta.ts';
import { toPublicData, toReportAnomalies, toReportVariations, type EmitWorld, type PublicData } from './public.ts';

const DATA_FILES = ['regions', 'provinces', 'municipalities'] as const satisfies (keyof PublicData)[];

export interface EmitOptions {
  /** Output directories (`paths.dist`, `paths.releaseReports`). */
  dirs: ReleaseDirs;
  world: EmitWorld;
  /** Every anomaly of the run; a blocking one is an `EmitError`. */
  anomalies: readonly InternalAnomaly[];
  /** The previous release, or null for the first one. */
  previous: PublishedDataset | null;
  /** Wall-clock time of the build, ISO 8601 UTC (read by the caller). */
  generatedAt: string;
  today: IsoDate;
  sources: SourceSummaries;
}

/** What the run published: nothing, only the schemas (non-retroactive) or new data. */
export type ReleaseKind = 'unchanged' | 'schemas' | 'data';

export type EmitResult =
  | { kind: 'unchanged'; data: PublicData; variations: Variation[]; anomalies: Anomaly[] }
  | {
      kind: 'schemas' | 'data';
      data: PublicData;
      variations: Variation[];
      anomalies: Anomaly[];
      changes: Changes;
      meta: Meta;
      /** Written files, relative to `dist/` or `reports/` (`reports/<name>`). */
      files: string[];
    };

export async function emitDataset(options: EmitOptions): Promise<EmitResult> {
  const { dirs, previous } = options;
  const data = toPublicData(options.world);
  const variations = parseReleaseFile('variations', toReportVariations(options.world.variations));
  const anomalies = parseReleaseFile('anomalies', toReportAnomalies(options.anomalies));
  for (const name of DATA_FILES) parseReleaseFile(name, data[name]);
  const texts = Object.fromEntries(DATA_FILES.map((name) => [name, serialize(data[name])])) as Record<
    (typeof DATA_FILES)[number],
    string
  >;
  const schemas = Object.entries(generateJsonSchemas()).map(([name, schema]): [string, string] => [
    `schema/${name}`,
    serialize(schema),
  ]);

  const sameData = previous !== null && DATA_FILES.every((name) => serialize(previous[name]) === texts[name]);
  const sameSchemas =
    previous !== null && schemas.every(([path, text]) => previous.schemas[path.slice('schema/'.length)] === text);
  if (sameData && sameSchemas) return { kind: 'unchanged', data, variations, anomalies };

  // A schema release keeps the meta of the release that produced the data (`data_version`, sources,
  // counts, anomalies): only `schema_version` and `generated_at` change.
  const schemasOnly = sameData ? previous : null;
  const kind = schemasOnly === null ? 'data' : 'schemas';
  const meta = parseReleaseFile(
    'meta',
    schemasOnly === null
      ? buildMeta({
          data,
          variations,
          anomalies,
          generatedAt: options.generatedAt,
          today: options.today,
          sources: options.sources,
        })
      : { ...schemasOnly.meta, schema_version: SCHEMA_VERSION, generated_at: options.generatedAt },
  );
  const to = { data_version: meta.data_version, generated_at: meta.generated_at };
  const current = schemasOnly ?? { ...data, variations };
  const changes = parseReleaseFile('changes', computeChanges(previous, current, to));

  const dist: [string, string][] = [
    ...(kind === 'data' ? DATA_FILES.map((name): [string, string] => [`${name}.json`, texts[name]]) : []),
    ...schemas,
  ];
  const reports: [string, string][] = [
    ...(kind === 'data'
      ? [
          ['variations.json', serialize(variations)] as [string, string],
          ['anomalies.json', serialize(anomalies)] as [string, string],
        ]
      : []),
    ['changes.json', serialize(changes)],
    ['meta.json', serialize(meta)],
  ];
  for (const [path, text] of dist) await writeFileAtomic(join(dirs.dist, path), text);
  for (const [path, text] of reports) await writeFileAtomic(join(dirs.reports, path), text);
  return {
    kind,
    data,
    variations,
    anomalies,
    changes,
    meta,
    files: [...dist.map(([path]) => path), ...reports.map(([path]) => `reports/${path}`)],
  };
}
