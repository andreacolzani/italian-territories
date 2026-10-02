/** SITUAS internal fixtures as raw items and decoded rows, and a transport for crawl tests. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from '../../src/http/transport.ts';
import { INTERNAL_ENDPOINTS, INTERNAL_REPORTS } from '../../src/sources/situas-internal/index.ts';
import { createFixtureTransport, FIXTURES_ROOT } from './fixtures.ts';

type RawItem = Record<string, unknown>;

/** Items of an internal fixture (`situas-internal/<path>`), parsed once more when double-encoded. */
export async function rawItems(path: string): Promise<RawItem[]> {
  let document = JSON.parse(await readFile(join(FIXTURES_ROOT, 'situas-internal', path), 'utf8')) as unknown;
  if (typeof document === 'string') document = JSON.parse(document);
  return (document as { items: RawItem[] }).items;
}

/** Decoded rows of an internal fixture through the endpoint's own decoder. */
export async function decodedRows<K extends keyof typeof INTERNAL_ENDPOINTS>(
  endpoint: K,
  path: string,
): Promise<ReturnType<(typeof INTERNAL_ENDPOINTS)[K]['decode']>> {
  const body = await readFile(join(FIXTURES_ROOT, 'situas-internal', path), 'utf8');
  return INTERNAL_ENDPOINTS[endpoint].decode({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
  }) as ReturnType<(typeof INTERNAL_ENDPOINTS)[K]['decode']>;
}

/** The report number of an internal request (`ReportByUrl` body). */
export function reportOf(request: HttpRequest): number | undefined {
  const url = (request.body as { url?: string } | undefined)?.url ?? '';
  const name = url.slice(0, url.indexOf('?'));
  const entry = Object.entries(INTERNAL_REPORTS).find(([, r]) => r.report === name);
  return entry === undefined ? undefined : Number(entry[0]);
}

export function reportUrlOf(request: HttpRequest): string {
  return (request.body as { url: string }).url;
}

export const EMPTY_INTERNAL: HttpResponse = {
  status: 200,
  headers: { 'content-type': 'text/plain' },
  body: '{"items":[]}',
};

export function internalItems(items: readonly RawItem[]): HttpResponse {
  // Served double-encoded, as the real API does for non-empty results (§3.3).
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(JSON.stringify({ items })),
  };
}

export interface InternalWorldOptions {
  /** Items of r1, r2, r3 (normally subsets of the real lists, never stored as fixtures). */
  lists: { 1?: RawItem[]; 2?: RawItem[]; 3?: RawItem[] };
  /** Responses that take precedence over the fixtures, by unencoded report URL. */
  responses?: Record<string, HttpResponse>;
  /** Every internal request fails with a connection error. */
  offline?: boolean;
}

/**
 * r6 responses of the real fixtures by every `(code, name)` pair their history mentions (at an
 * event or as current pair): any historical pair of a municipality returns its full history
 * (§3.3 report 6).
 */
async function municipalityHistories(): Promise<Map<string, HttpResponse>> {
  const dir = 'r6-municipality-events';
  const histories = new Map<string, HttpResponse>();
  for (const file of await readdir(join(FIXTURES_ROOT, 'situas-internal', dir))) {
    const body = await readFile(join(FIXTURES_ROOT, 'situas-internal', dir, file), 'utf8');
    const response: HttpResponse = { status: 200, headers: { 'content-type': 'application/json' }, body };
    for (const item of await rawItems(`${dir}/${file}`)) {
      histories.set(`${String(item['codice Istat'])}|${String(item.denominazione)}`, response);
      histories.set(`${String(item['codice comune corrente'])}|${String(item['denominazione corrente'])}`, response);
    }
  }
  return histories;
}

/**
 * Lists from `lists`, other reports from the real fixtures; r6 answers every historical pair of
 * a fixture's municipality. Details reports (r7, r8) without a fixture are served empty, as the
 * API does for events without associated territories; any other unknown request fails loudly.
 */
export async function internalWorld(options: InternalWorldOptions): Promise<Transport> {
  const fixtures = await createFixtureTransport();
  const histories = await municipalityHistories();
  return async (request, transportOptions) => {
    if (options.offline === true) throw new NetworkError('offline');
    const url = reportUrlOf(request);
    const response = options.responses?.[url];
    if (response !== undefined) return response;
    const report = reportOf(request);
    if (report === 6) {
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      const history = histories.get(`${query.get('procom') ?? ''}|${query.get('com') ?? ''}`);
      if (history !== undefined) return history;
    }
    if (report === 1 || report === 2 || report === 3) {
      const items = options.lists[report];
      if (items === undefined) throw new Error(`no list r${report} in this world`);
      return internalItems(items);
    }
    try {
      return await fixtures(request, transportOptions);
    } catch (error) {
      if (report === 7 || report === 8) return EMPTY_INTERNAL;
      throw error;
    }
  };
}
