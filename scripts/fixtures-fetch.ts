/**
 * Downloads the §11.2 fixtures through the HTTP client (encoded, rate-limited, cached) and
 * stores the bodies exactly as served (internal reports stay double-encoded, §3.3) at their
 * §11.1 paths, adding or replacing their manifest entries.
 *
 * Usage: npm run fixtures:fetch [-- <fixture path>...]
 *
 * With fixture paths (relative to `test/fixtures/`), only those downloads are recorded; the
 * others, whose event lists and counts depend on the download date, are left untouched.
 *
 * Bodies are only checked for content type and envelope here: the adapters' row schemas are
 * exercised by the fixture tests, so a schema problem never prevents recording the evidence.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { resolveConfig } from '../src/config.ts';
import { currentDate, type IsoDate } from '../src/dates/index.ts';
import {
  cacheKey,
  CONTENT_TYPES,
  createHttpClient,
  jsonRowsDecoder,
  ResponseCache,
  type Endpoint,
  type HttpRequest,
} from '../src/http/index.ts';
import { regionTypeFromIstat } from '../src/model/common.ts';
import { internalRequest, reportUrls } from '../src/sources/situas-internal/requests.ts';
import {
  countRequest,
  describeSnapshotPfun,
  eventListRequest,
  snapshotRequest,
  type EventListPfun,
  type SnapshotPfun,
} from '../src/sources/situas-public/pfun.ts';
import {
  describeRequest,
  FIXTURES_ROOT,
  loadManifest,
  MANIFEST_PATH,
  type ManifestEntry,
} from '../test/helpers/fixtures.ts';

interface Download {
  request: HttpRequest;
  usedBy: string[];
}

const config = resolveConfig();
const { situasPublicBaseUrl: publicBase, situasInternalReportUrl: internalUrl } = config.sources;
const today = config.dates.today ?? currentDate();
const UNIFICATION = '1861-03-17';

const snapshot = (pfun: SnapshotPfun, date: IsoDate, usedBy: string[]): Download => ({
  request: snapshotRequest(publicBase, pfun, date),
  usedBy,
});
const internal = (reportUrl: string, usedBy: string[]): Download => ({
  request: internalRequest(internalUrl, reportUrl),
  usedBy,
});

const EVENT_LIST_USED_BY: Partial<Record<EventListPfun, string[]>> = {
  100: ['golden-1', 'golden-2'],
  103: ['golden-1', 'golden-18', 'quirk-3'],
  106: ['golden-15'],
  107: ['golden-15'],
  108: ['golden-15'],
  112: ['golden-4', 'golden-9'],
  113: ['golden-4', 'golden-6', 'quirk-1'],
  114: ['golden-4'],
};

function staticDownloads(): Download[] {
  return [
    snapshot(44, '1921-06-01', ['golden-7']),
    snapshot(48, '1921-06-01', ['golden-7']),
    snapshot(46, '1942-06-01', ['golden-8']),
    snapshot(49, '1942-06-01', ['golden-8']),
    snapshot(48, '1927-01-11', ['golden-6', 'golden-16']),
    snapshot(51, '1927-01-11', ['golden-6', 'golden-16', 'quirk-3']),
    snapshot(46, '1927-01-12', ['golden-6', 'golden-16']),
    snapshot(49, '1927-01-12', ['golden-6', 'golden-16']),
    snapshot(50, '1927-01-12', ['golden-6', 'golden-16']),
    snapshot(46, '1947-12-31', ['golden-15']),
    snapshot(49, '1947-12-31', ['golden-15']),
    snapshot(68, '1948-01-01', ['golden-15']),
    snapshot(64, '1948-01-01', ['golden-15']),
    snapshot(68, '2025-12-31', ['golden-4', 'quirk-2']),
    snapshot(68, '2026-01-01', ['golden-4']),
    snapshot(44, '1923-02-07', ['golden-7']),
    snapshot(44, '1923-02-08', ['golden-7']),
    snapshot(48, '1923-02-07', ['golden-7']),
    snapshot(48, '1923-02-08', ['golden-7']),
    snapshot(51, '1923-02-07', ['golden-6', 'golden-7']),
    snapshot(51, '1923-02-08', ['golden-6', 'golden-7']),
    snapshot(50, '1936-06-03', ['golden-6']),
    snapshot(50, '1936-06-04', ['golden-6']),
    snapshot(50, '1928-05-03', ['golden-3']),
    snapshot(50, '1928-05-04', ['golden-3']),
    snapshot(50, '1929-05-13', ['golden-2']),
    snapshot(50, '1929-05-14', ['golden-2']),
    snapshot(50, '1947-11-24', ['golden-2']),
    snapshot(50, '1947-11-25', ['golden-2']),
    snapshot(50, '1947-11-27', ['golden-3']),
    snapshot(50, '1947-11-28', ['golden-3']),
    snapshot(61, '2021-06-16', ['golden-2']),
    snapshot(61, '2021-06-17', ['golden-2']),
    snapshot(61, '2025-12-31', ['golden-4']),
    snapshot(61, '2026-01-01', ['golden-4']),
    snapshot(64, '2014-12-31', ['golden-5']),
    snapshot(64, '2015-01-01', ['golden-5']),
    // Step 10: the parents of the golden worlds and the municipality snapshots of version changes.
    ...(['1929-05-13', '1929-05-14', '1947-11-24', '1947-11-25'] as const).flatMap((date) => [
      snapshot(46, date, ['golden-2']),
      snapshot(49, date, ['golden-2']),
    ]),
    ...(['2021-06-16', '2021-06-17'] as const).flatMap((date) => [
      snapshot(68, date, ['golden-2']),
      snapshot(64, date, ['golden-2']),
    ]),
    ...(['1947-11-27', '1947-11-28'] as const).flatMap((date) => [
      snapshot(46, date, ['golden-3']),
      snapshot(49, date, ['golden-3']),
    ]),
    ...(['1974-08-20', '1974-09-13'] as const).flatMap((date) => [
      snapshot(68, date, ['golden-3']),
      snapshot(64, date, ['golden-3']),
      snapshot(61, date, ['golden-3']),
    ]),
    ...(['2014-12-31', '2015-01-01'] as const).flatMap((date) => [
      snapshot(68, date, ['golden-5']),
      snapshot(61, date, ['golden-5']),
    ]),
    ...(['1936-06-04', '1939-10-21', '1946-01-30'] as const).flatMap((date) => [
      snapshot(46, date, ['golden-10']),
      snapshot(49, date, ['golden-10']),
    ]),
    snapshot(50, '1939-10-21', ['golden-10']),
    snapshot(50, '1946-01-30', ['golden-10']),
    ...(['1920-10-15', '1920-10-16'] as const).flatMap((date) => [
      snapshot(44, date, ['golden-11']),
      snapshot(48, date, ['golden-11']),
      snapshot(51, date, ['golden-11']),
    ]),
    ...(['2009-01-28', '2009-01-29'] as const).flatMap((date) => [
      snapshot(68, date, ['golden-12']),
      snapshot(64, date, ['golden-12']),
      snapshot(61, date, ['golden-12']),
    ]),
    snapshot(44, '1927-01-11', ['golden-16']),
    // Step 11: the cessions of 1947-09-16 and the act grouping the Setteville merger.
    ...(['1947-09-15', '1947-09-16'] as const).flatMap((date) => [
      snapshot(46, date, ['golden-9', 'golden-18', 'golden-19']),
      snapshot(49, date, ['golden-9', 'golden-18', 'golden-19']),
      snapshot(50, date, ['golden-9', 'golden-18', 'golden-19']),
    ]),
    internal(reportUrls.municipalityEvents({ code: '025075', name: 'Setteville' }), ['golden-1']),
    internal(reportUrls.municipalityEvents({ code: '025070', name: 'Quero Vas' }), ['golden-1']),
    internal(reportUrls.municipalityEvents({ code: '025002', name: 'Alano di Piave' }), ['golden-1']),
    // Step 13: the merger of Quero and Vas into Quero Vas (2013-12-28), first link of the chain.
    snapshot(61, '2013-12-27', ['golden-1']),
    snapshot(61, '2013-12-28', ['golden-1']),
    internal(reportUrls.municipalityEvents({ code: '025042', name: 'Quero' }), ['golden-1']),
    internal(reportUrls.municipalityEvents({ code: '025064', name: 'Vas' }), ['golden-1']),
    ...Object.entries(EVENT_LIST_USED_BY).map(([pfun, usedBy]) => ({
      request: eventListRequest(publicBase, Number(pfun) as EventListPfun, UNIFICATION, today),
      usedBy,
    })),
    ...([61, 64, 68] as const).map((pfun) => ({
      request: countRequest(publicBase, pfun, { date: today }),
      usedBy: ['golden-17'],
    })),
    // Step 15: the snapshots of the day the counts above were downloaded (2026-10-01), whose reconstruction I13 compares.
    ...([68, 64, 61] as const).map((pfun) => snapshot(pfun, '2026-10-01', ['golden-17'])),
    internal(reportUrls.regionList(), ['golden-4', 'golden-15']),
    internal(reportUrls.utsList(), ['golden-4', 'golden-15']),
    internal(reportUrls.municipalityList(), ['golden-4', 'golden-15']),
    internal(reportUrls.utsEvents({ code: '090', name: 'Sassari', type: 'province' }), ['golden-4']),
    internal(reportUrls.utsEvents({ code: '092', name: 'Cagliari', type: 'province' }), ['golden-4']),
    internal(reportUrls.utsEvents({ code: '015', name: 'Milano', type: 'province' }), ['golden-5']),
    internal(reportUrls.utsEvents({ code: '113', name: 'Gallura Nord-Est Sardegna', type: 'province' }), ['golden-4']),
    internal(reportUrls.utsEvents({ code: '115', name: 'Oristano', type: 'province' }), ['golden-4']),
    internal(reportUrls.regionEventDetails({ regionType: 'compartment', actId: 6109, event: 'CS', originId: 14 }), [
      'golden-15',
    ]),
    internal(reportUrls.utsEventDetails({ originId: 126, actId: 6151, utsType: 'province', event: 'ES' }), [
      'golden-4',
    ]),
    internal(reportUrls.utsEventDetails({ originId: 9, actId: 6029, utsType: 'province', event: 'ESCT' }), [
      'golden-5',
    ]),
  ];
}

/** Endpoint scopes of a request (§6.1) with a decoder that checks only content type and envelope. */
function rawEndpoint(request: HttpRequest): Endpoint<unknown[]> {
  const { source, endpoint } = describeRequest(request);
  if (source === 'anpr') throw new Error('ANPR fixtures are not part of §11.2');
  const internalSource = source === 'situas-internal';
  const snapshotPfun = endpoint.startsWith('snapshot:') ? Number(endpoint.slice('snapshot:pfun-'.length)) : null;
  return {
    id: endpoint,
    family: internalSource
      ? 'situas-internal'
      : snapshotPfun !== null
        ? 'situas-public-snapshots'
        : 'situas-public-reports',
    timeoutClass:
      snapshotPfun !== null && describeSnapshotPfun(snapshotPfun)?.level === 'municipality' ? 'snapshot' : 'default',
    decode: jsonRowsDecoder({
      contentTypes: internalSource ? CONTENT_TYPES.situasInternal : CONTENT_TYPES.situasPublic,
      envelope: internalSource ? 'items' : 'resultset',
      nonEmpty: false,
      row: z.unknown(),
    }),
  };
}

const client = createHttpClient(config, {
  onEvent: (event) => {
    if (event.type === 'retry') console.error(`retry ${event.endpoint} #${event.attempt}: ${event.reason}`);
    else if (event.type !== 'concurrency') console.error(`${event.type}: ${JSON.stringify(event)}`);
  },
});
const cache = new ResponseCache(config.paths.httpCache);

interface Recorded {
  entry: ManifestEntry;
  rows: unknown[];
  bytes: number;
}

async function record(download: Download): Promise<Recorded> {
  const { request } = download;
  const { data } = await client.request(rawEndpoint(request), request);
  const cached = await cache.get(cacheKey(request));
  if (cached === undefined) throw new Error(`no cache entry after fetching ${JSON.stringify(request)}`);
  const { path, source, endpoint } = describeRequest(request);
  const file = join(FIXTURES_ROOT, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, cached.body, 'utf8');
  const entry: ManifestEntry = {
    path,
    source,
    endpoint,
    request: {
      method: request.method,
      url: request.url,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
    },
    fetched_at: cached.fetched_at,
    completeness: 'full',
    note: null,
    used_by: download.usedBy,
  };
  console.error(`${path}: ${data.length} rows, ${Buffer.byteLength(cached.body, 'utf8')} bytes`);
  return { entry, rows: data, bytes: Buffer.byteLength(cached.body, 'utf8') };
}

/** r4 for every r1 record named Piemonte (compartment and region), §11.2. */
function piemonteDownloads(regions: unknown[]): Download[] {
  const records = z
    .array(
      z.looseObject({
        cod_regione: z.string(),
        'denominazione regione': z.string(),
        'tipo regione': z.coerce.number(),
      }),
    )
    .parse(regions)
    .filter((r) => r['denominazione regione'] === 'Piemonte');
  if (records.length === 0) throw new Error('r1 lists no record named Piemonte');
  return records.map((r) =>
    internal(
      reportUrls.regionEvents({
        code: r.cod_regione,
        name: r['denominazione regione'],
        type: regionTypeFromIstat(r['tipo regione']),
      }),
      ['golden-15'],
    ),
  );
}

async function main(): Promise<void> {
  const only = new Set(process.argv.slice(2));
  const selected = (d: Download): boolean => only.size === 0 || only.has(describeRequest(d.request).path);
  const downloads = staticDownloads().filter(selected);
  const unknown = [...only].filter((path) => !staticDownloads().some((d) => describeRequest(d.request).path === path));
  if (unknown.length > 0) throw new Error(`not a static download: ${unknown.join(', ')}`);
  const recorded = await Promise.all(downloads.map(record));
  if (only.size === 0) {
    const regionList = recorded.find((r) => r.entry.endpoint === 'r1:region-list');
    if (regionList === undefined) throw new Error('r1 was not downloaded');
    recorded.push(...(await Promise.all(piemonteDownloads(regionList.rows).map(record))));
  }

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as { fixtures: ManifestEntry[] };
  const byPath = new Map(manifest.fixtures.map((e, i) => [e.path, i]));
  for (const { entry } of recorded) {
    const index = byPath.get(entry.path);
    if (index === undefined) manifest.fixtures.push(entry);
    else manifest.fixtures[index] = entry;
  }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await loadManifest();

  console.log(`Recorded ${recorded.length} fixtures:`);
  for (const r of recorded) console.log(`${String(r.bytes).padStart(10)}  ${r.entry.path}`);
}

await main();
