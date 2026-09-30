/**
 * Fixture conventions of §11.1: request → path mapping, manifest model and a mock transport
 * that serves recorded responses.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { HttpRequest, HttpResponse, Transport } from '../../src/http/transport.ts';

export const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
export const MANIFEST_PATH = join(FIXTURES_ROOT, 'manifest.json');

const SITUAS_PUBLIC_URL = 'https://situas-servizi.istat.it/publish/reportspooljson';
const SITUAS_INTERNAL_URL = 'https://situas.istat.it/ShibO2Module/api/Report/ReportByUrl';
const ANPR_URL = 'https://www.anagrafenazionale.interno.it/wp-content/uploads/ANPR_archivio_comuni.csv';

type Level = 'regions' | 'provinces' | 'municipalities';
export type FixtureSource = 'situas-public' | 'situas-internal' | 'anpr';

/** Snapshot pfun ids by level (§3.2). */
const SNAPSHOT_PFUN: Record<number, Level> = {
  44: 'regions',
  46: 'regions',
  68: 'regions',
  48: 'provinces',
  49: 'provinces',
  64: 'provinces',
  51: 'municipalities',
  50: 'municipalities',
  61: 'municipalities',
};

/** Event list pfun ids by level (§3.2). */
const EVENTS_PFUN: Record<number, Level> = {
  106: 'regions',
  107: 'regions',
  108: 'regions',
  112: 'provinces',
  113: 'provinces',
  114: 'provinces',
  98: 'municipalities',
  100: 'municipalities',
  103: 'municipalities',
  104: 'municipalities',
  105: 'municipalities',
};

interface InternalReport {
  n: number;
  name: string;
  /** File name (without extension) built from the report parameters. */
  file: (p: Params) => string;
}

/** Internal reports 1–9 (§3.3), keyed by report name. */
const INTERNAL_REPORTS: Record<string, InternalReport> = {
  var_get_ua_reg_lov_diffusione: { n: 1, name: 'region-list', file: () => 'all' },
  var_get_ua_uts_lov_diffusione: { n: 2, name: 'uts-list', file: () => 'all' },
  var_get_ua_comuni_lov_diffusione: { n: 3, name: 'municipality-list', file: () => 'all' },
  var_get_ua_reg_lov_rs: {
    n: 4,
    name: 'region-events',
    file: (p) => [p.req('codreg'), p.req('reg_tipo'), slugify(p.req('reg'))].join('_'),
  },
  var_get_ua_uts_lov_rs: {
    n: 5,
    name: 'uts-events',
    file: (p) => [p.req('coduts'), p.req('uts_tipo'), slugify(p.req('uts'))].join('_'),
  },
  var_get_ua_comuni_lov_rs: {
    n: 6,
    name: 'municipality-events',
    file: (p) => [p.req('procom'), slugify(p.req('com'))].join('_'),
  },
  var_get_ua_reg_lov_rs_dett_ass: {
    n: 7,
    name: 'region-event-details',
    file: (p) => [p.req('id_regione_origine'), p.req('mcrvar'), p.req('idprovv')].join('_'),
  },
  var_get_ua_uts_lov_rs_dett_ass: {
    n: 8,
    name: 'uts-event-details',
    file: (p) => [p.req('id_uts_origine'), p.req('mcrvar'), p.req('idprovv')].join('_'),
  },
  var_get_ua_comuni_lov_rs_dett_ass: {
    n: 9,
    name: 'municipality-event-details',
    file: (p) => [p.req('idcomuneorig'), p.req('mcrvar'), p.req('idprovv')].join('_'),
  },
};

interface Params {
  get: (name: string) => string | undefined;
  req: (name: string) => string;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** Parses a query string that may be encoded or not (request URLs are stored unencoded, §11.1). */
function parseQuery(query: string, context: string): Params {
  const map = new Map<string, string>();
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = decode(eq < 0 ? part : part.slice(0, eq));
    map.set(key, eq < 0 ? '' : decode(part.slice(eq + 1)));
  }
  return {
    get: (name) => map.get(name),
    req: (name) => {
      const value = map.get(name);
      if (value === undefined || value === '') throw new Error(`${context}: missing parameter '${name}'`);
      return value;
    },
  };
}

function splitUrl(url: string): { base: string; query: string } {
  const q = url.indexOf('?');
  return q < 0 ? { base: url, query: '' } : { base: url.slice(0, q), query: url.slice(q + 1) };
}

/** Lowercase ASCII slug: accents stripped, runs of other characters collapsed to `-`. */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `DD/MM/YYYY` → `YYYY-MM-DD`. */
function situasDateToIso(value: string, context: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) throw new Error(`${context}: invalid date '${value}' (expected DD/MM/YYYY)`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export interface FixtureOptions {
  /** Download date (`YYYY-MM-DD`) of an ANPR CSV; the ANPR request carries no parameters. */
  downloadDate?: string;
}

export interface FixtureDescription {
  path: string;
  source: FixtureSource;
  endpoint: string;
}

/** Maps a request to its conventional fixture path, source and endpoint id (§11.1). Pure. */
export function describeRequest(request: HttpRequest, options: FixtureOptions = {}): FixtureDescription {
  const { base, query } = splitUrl(request.url);

  if (base === SITUAS_PUBLIC_URL) {
    const ctx = `situas-public ${request.url}`;
    const p = parseQuery(query, ctx);
    const pfun = Number(p.req('pfun'));
    const snapshotLevel = SNAPSHOT_PFUN[pfun];
    if (snapshotLevel !== undefined) {
      return {
        path: `situas-public/snapshots/${snapshotLevel}/pfun-${pfun}_${situasDateToIso(p.req('pdata'), ctx)}.json`,
        source: 'situas-public',
        endpoint: `snapshot:pfun-${pfun}`,
      };
    }
    const eventsLevel = EVENTS_PFUN[pfun];
    if (eventsLevel !== undefined) {
      const from = situasDateToIso(p.req('pdatada'), ctx);
      const to = situasDateToIso(p.req('pdataa'), ctx);
      return {
        path: `situas-public/events/${eventsLevel}/pfun-${pfun}_${from}_${to}.json`,
        source: 'situas-public',
        endpoint: `events:pfun-${pfun}`,
      };
    }
    throw new Error(`${ctx}: unknown pfun ${pfun}`);
  }

  if (base === SITUAS_INTERNAL_URL) {
    const body = request.body as { url?: unknown } | undefined;
    if (typeof body?.url !== 'string') throw new Error(`situas-internal: request body has no 'url'`);
    const report = splitUrl(body.url);
    const ctx = `situas-internal ${body.url}`;
    const def = INTERNAL_REPORTS[report.base];
    if (def === undefined) throw new Error(`${ctx}: unknown report '${report.base}'`);
    return {
      path: `situas-internal/r${def.n}-${def.name}/${def.file(parseQuery(report.query, ctx))}.json`,
      source: 'situas-internal',
      endpoint: `r${def.n}:${def.name}`,
    };
  }

  if (base === ANPR_URL) {
    if (options.downloadDate === undefined) throw new Error('anpr: a download date is required');
    return {
      path: `anpr/anpr-archivio-comuni_${options.downloadDate}.csv`,
      source: 'anpr',
      endpoint: 'anpr:archivio-comuni',
    };
  }

  throw new Error(`No fixture convention for ${request.method} ${request.url}`);
}

export function fixturePath(request: HttpRequest, options: FixtureOptions = {}): string {
  return describeRequest(request, options).path;
}

/** Strips the `__subset-<description>` marker: `a/b__subset-x.json` → `a/b.json`. */
export function subsetBasePath(path: string): string {
  return path.replace(/__subset-[^/]*?(\.[a-z]+)$/, '$1');
}

export const manifestEntrySchema = z.strictObject({
  path: z.string().min(1),
  source: z.enum(['situas-public', 'situas-internal', 'anpr']),
  endpoint: z.string().min(1),
  request: z.strictObject({
    method: z.enum(['GET', 'POST']),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  }),
  fetched_at: z.iso.date(),
  completeness: z.enum(['full', 'subset']),
  note: z.string().nullable(),
  used_by: z.array(z.string().regex(/^(golden|quirk)-\d+$/)).min(1),
});

export const manifestSchema = z.strictObject({
  $comment: z.string().optional(),
  manifest_version: z.literal(1),
  fixtures: z.array(manifestEntrySchema),
});

export type ManifestEntry = z.output<typeof manifestEntrySchema>;
export type Manifest = z.output<typeof manifestSchema>;

export async function loadManifest(path: string = MANIFEST_PATH): Promise<Manifest> {
  return manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export interface FixtureTransportOptions {
  root?: string;
  manifest?: Manifest;
  /** ANPR download date to serve; defaults to the most recent full ANPR fixture. */
  anprDownloadDate?: string;
}

/**
 * Mock transport serving full fixtures by their conventional path. Requests without a
 * matching full fixture (unknown, subset-only or method mismatch) fail loudly.
 */
export async function createFixtureTransport(options: FixtureTransportOptions = {}): Promise<Transport> {
  const root = options.root ?? FIXTURES_ROOT;
  const manifest = options.manifest ?? (await loadManifest(join(root, 'manifest.json')));
  const full = new Map(manifest.fixtures.filter((e) => e.completeness === 'full').map((e) => [e.path, e]));
  const anprDownloadDate =
    options.anprDownloadDate ??
    [...full.values()]
      .filter((e) => e.source === 'anpr')
      .map((e) => e.fetched_at)
      .sort()
      .at(-1);

  return async (request: HttpRequest): Promise<HttpResponse> => {
    const fail = (reason: string): never => {
      throw new Error(
        `Fixture transport: ${reason} for ${request.method} ${request.url} ${JSON.stringify(request.body ?? null)}`,
      );
    };
    let path: string;
    try {
      path = fixturePath(request, anprDownloadDate === undefined ? {} : { downloadDate: anprDownloadDate });
    } catch (error) {
      return fail((error as Error).message);
    }
    const entry = full.get(path);
    if (entry === undefined) return fail(`no full fixture at '${path}'`);
    if (entry.request.method !== request.method) return fail(`method mismatch with fixture '${path}'`);
    const body = await readFile(join(root, path), 'utf8');
    const contentType = path.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
    return { status: 200, headers: { 'content-type': contentType }, body };
  };
}
