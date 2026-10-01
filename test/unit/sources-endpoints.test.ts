/**
 * Every fixture request is answered by an adapter endpoint whose id is the one of the fixture
 * convention (§11.1) and whose family is the one of the §6.1 scope table.
 */
import { describe, expect, it } from 'vitest';
import type { Endpoint, Family } from '../../src/http/decode.ts';
import type { HttpRequest } from '../../src/http/transport.ts';
import { ANPR_ENDPOINT } from '../../src/sources/anpr/index.ts';
import { INTERNAL_ENDPOINTS, INTERNAL_REPORTS } from '../../src/sources/situas-internal/index.ts';
import {
  countEndpoint,
  describeSnapshotPfun,
  eventListEndpoint,
  isEventListPfun,
  snapshotEndpoint,
  type SnapshotPfun,
} from '../../src/sources/situas-public/index.ts';
import { describeRequest, loadManifest } from '../helpers/fixtures.ts';

const INTERNAL_BY_REPORT = new Map<string, Endpoint<unknown>>(
  Object.values(INTERNAL_ENDPOINTS).map((endpoint) => {
    const report = Object.values(INTERNAL_REPORTS).find((r) => r.endpoint === endpoint.id);
    if (report === undefined) throw new Error(`no report for ${endpoint.id}`);
    return [report.report, endpoint];
  }),
);

/** The adapter endpoint that serves a request. */
function adapterEndpoint(request: HttpRequest): Endpoint<unknown> {
  const url = new URL(request.url);
  if (url.host === 'www.anagrafenazionale.interno.it') return ANPR_ENDPOINT;
  if (url.host === 'situas.istat.it') {
    const reportUrl = (request.body as { url: string }).url;
    const endpoint = INTERNAL_BY_REPORT.get(reportUrl.split('?', 1)[0] ?? '');
    if (endpoint === undefined) throw new Error(`no internal endpoint for ${reportUrl}`);
    return endpoint;
  }
  const pfun = Number(url.searchParams.get('pfun'));
  if (url.pathname.endsWith('/reportspooljsoncount')) {
    if (describeSnapshotPfun(pfun) === undefined && !isEventListPfun(pfun)) throw new Error(`unknown pfun ${pfun}`);
    return countEndpoint(pfun as SnapshotPfun);
  }
  if (describeSnapshotPfun(pfun) !== undefined) return snapshotEndpoint(pfun as SnapshotPfun);
  if (isEventListPfun(pfun)) return eventListEndpoint(pfun);
  throw new Error(`no endpoint for ${request.url}`);
}

/** §6.1 scope table: family of each endpoint kind. */
function expectedFamily(endpointId: string): Family {
  if (endpointId.startsWith('snapshot:')) return 'situas-public-snapshots';
  if (endpointId.startsWith('events:') || endpointId.startsWith('count:')) return 'situas-public-reports';
  if (/^r[1-9]:/.test(endpointId)) return 'situas-internal';
  if (endpointId.startsWith('anpr:')) return 'anpr';
  throw new Error(`unknown endpoint kind ${endpointId}`);
}

describe('adapter endpoints (§6.1, §11.1)', () => {
  it('declare the fixture endpoint id and the family of the scope table for every fixture request', async () => {
    const manifest = await loadManifest();
    for (const entry of manifest.fixtures) {
      const endpoint = adapterEndpoint(entry.request);
      const { endpoint: expected } = describeRequest(entry.request, { downloadDate: entry.fetched_at });
      expect(endpoint.id, entry.path).toBe(expected);
      expect(endpoint.family, entry.path).toBe(expectedFamily(expected));
    }
  });

  it('use the long timeout only for municipality snapshots', () => {
    expect([51, 50, 61].map((p) => snapshotEndpoint(p as SnapshotPfun).timeoutClass)).toEqual([
      'snapshot',
      'snapshot',
      'snapshot',
    ]);
    expect([44, 46, 68, 48, 49, 64].map((p) => snapshotEndpoint(p as SnapshotPfun).timeoutClass)).toEqual(
      Array(6).fill('default'),
    );
    expect(eventListEndpoint(103).timeoutClass).toBe('default');
    expect(INTERNAL_ENDPOINTS.municipalityList.timeoutClass).toBe('default');
  });
});
