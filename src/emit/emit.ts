/**
 * §6.12, §9. Only the public files decide the release. An `unchanged` release writes no report either:
 * the reports describe the build of the published data. A `schemas` release exists so the published
 * schemas never lag behind the generator. `reports/meta.json` is written last, so a release with a
 * new meta is complete.
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
  dirs: ReleaseDirs;
  world: EmitWorld;
  anomalies: readonly InternalAnomaly[];
  previous: PublishedDataset | null;
  /** ISO 8601 UTC. */
  generatedAt: string;
  today: IsoDate;
  sources: SourceSummaries;
}

export type EmitResult =
  | { kind: 'unchanged'; data: PublicData; variations: Variation[]; anomalies: Anomaly[] }
  | {
      kind: 'schemas' | 'data';
      data: PublicData;
      variations: Variation[];
      anomalies: Anomaly[];
      changes: Changes;
      meta: Meta;
      /** Relative to `dist/`; reports as `reports/<name>`. */
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
