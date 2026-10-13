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
    // The parents of the golden worlds and the municipality snapshots of version changes.
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
    // The cessions of 1947-09-16 and the act grouping the Setteville merger.
    ...(['1947-09-15', '1947-09-16'] as const).flatMap((date) => [
      snapshot(46, date, ['golden-9', 'golden-18', 'golden-19']),
      snapshot(49, date, ['golden-9', 'golden-18', 'golden-19']),
      snapshot(50, date, ['golden-9', 'golden-18', 'golden-19']),
    ]),
    internal(reportUrls.municipalityEvents({ code: '025075', name: 'Setteville' }), ['golden-1']),
    internal(reportUrls.municipalityEvents({ code: '025070', name: 'Quero Vas' }), ['golden-1']),
    internal(reportUrls.municipalityEvents({ code: '025002', name: 'Alano di Piave' }), ['golden-1']),
    // The merger of Quero and Vas into Quero Vas (2013-12-28), first link of the chain.
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
    // The snapshots of the day the counts above were downloaded (2026-10-01), whose reconstruction I13 compares.
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
    // A foreign state counterpart of `AQ` (Lombardia, 1866) and with a blank UTS type (Cuneo, 1947).
    internal(reportUrls.regionEventDetails({ regionType: 'compartment', actId: 3619, event: 'AQ', originId: 1 }), [
      'quirk-15',
    ]),
    internal(reportUrls.utsEventDetails({ originId: 3, actId: 2410, utsType: 'province', event: 'CE' }), ['quirk-15']),
    // golden-15: type changes of 1948 without `ESCT` (Venezia Tridentina → Trentino-Alto Adige).
    internal(reportUrls.regionEvents({ code: '82', name: 'Venezia Tridentina', type: 'compartment' }), ['golden-15']),
    internal(reportUrls.regionEvents({ code: '04', name: 'Trentino-Alto Adige/Südtirol', type: 'region' }), [
      'golden-15',
    ]),
    // golden-15: the pfun 106 `ESCT` rows Piemonte → Valle d'Aosta and Veneto → Friuli-Venezia Giulia
    // repeat links of act 6107 (D43): the records and the details of that act of the regions involved.
    ...(
      [
        ['02', "Valle d'Aosta", 'region'],
        ['06', 'Friuli-Venezia Giulia', 'region'],
        ['05', 'Veneto', 'compartment'],
        ['05', 'Veneto', 'region'],
        ['83', 'Venezia Giulia', 'compartment'],
      ] as const
    ).map(([code, name, type]) => internal(reportUrls.regionEvents({ code, name, type }), ['golden-15'])),
    ...(
      [
        ['region', 'CS', 25],
        ['region', 'CS', 29],
        ['region', 'CSCT', 14],
        ['region', 'CSCT', 12],
        ['compartment', 'ES', 14],
        ['compartment', 'ES', 12],
        ['compartment', 'ES', 23],
      ] as const
    ).map(([regionType, event, originId]) =>
      internal(reportUrls.regionEventDetails({ regionType, actId: 6107, event, originId }), ['golden-15']),
    ),
    // golden-20: Caserta, suppressed in 1927 and reconstituted in 1945 with the same origin.
    ...(['Terra del Lavoro', 'Caserta'] as const).map((name) =>
      internal(reportUrls.utsEvents({ code: '061', name, type: 'province' }), ['golden-20']),
    ),
    internal(reportUrls.utsEvents({ code: '062', name: 'Benevento', type: 'province' }), ['golden-20']),
    internal(reportUrls.utsEvents({ code: '063', name: 'Napoli', type: 'province' }), ['golden-20']),
    internal(reportUrls.utsEvents({ code: '070', name: 'Campobasso', type: 'province' }), ['golden-20']),
    internal(reportUrls.utsEventDetails({ originId: 35, actId: 5390, utsType: 'province', event: 'CS' }), [
      'golden-20',
    ]),
    ...[43, 36, 37].map((originId) =>
      internal(reportUrls.utsEventDetails({ originId, actId: 5390, utsType: 'province', event: 'CECS' }), [
        'golden-20',
      ]),
    ),
    // golden-21: two acts of the same day and event, told apart by their r9 details.
    internal(reportUrls.municipalityEvents({ code: '092092', name: 'Riola Sardo' }), ['golden-21']),
    ...[5831, 5841].map((actId) =>
      internal(reportUrls.municipalityEventDetails({ originId: 7543, actId, event: 'CECS' }), ['golden-21']),
    ),
    ...(['1946-02-06', '1946-02-07'] as const).flatMap((date) => [
      snapshot(46, date, ['golden-21']),
      snapshot(49, date, ['golden-21']),
      snapshot(50, date, ['golden-21']),
    ]),
    ...(['1945-08-31', '1945-09-01'] as const).flatMap((date) => [
      snapshot(46, date, ['golden-20']),
      snapshot(49, date, ['golden-20']),
      snapshot(50, date, ['golden-20']),
    ]),
    // golden-24: from 2026-10-12 pfun 105 has `RN` where r6 keeps `RNAPUTS` (act 6151, D48).
    internal(reportUrls.municipalityEvents({ code: '112001', name: 'Alghero' }), ['golden-24']),
    { request: eventListRequest(publicBase, 105, '2026-01-01', '2026-01-01'), usedBy: ['golden-24'] },
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
