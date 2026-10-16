import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import {
  crawlInternal,
  INTERNAL_CRAWL_ANOMALIES,
  saveEventCodeSummary,
  type CrawlItem,
  type InternalCrawlResult,
} from '../../src/enrich/index.ts';
import type { HttpRequest, HttpResponse, Transport } from '../../src/http/index.ts';
import type { Level } from '../../src/model/common.ts';
import { reportUrls } from '../../src/sources/situas-internal/index.ts';
import { Store } from '../../src/store/index.ts';
import { withTempDir } from '../helpers/http.ts';
import { EMPTY_INTERNAL, internalItems, internalWorld, rawItems, reportOf, reportUrlOf } from '../helpers/internal.ts';
import { withSources } from '../helpers/sources.ts';

const regionList = await rawItems('r1-region-list/all.json');
const utsList = await rawItems('r2-uts-list/all.json');
const municipalityList = await rawItems('r3-municipality-list/all.json');

/** Records of the real r2 list that have an r5 fixture. */
const UTS_RECORDS: [string, number][] = [
  ['015', 1],
  ['090', 1],
  ['092', 1],
  ['111', 1],
  ['114', 1],
  ['116', 1],
  ['117', 1],
  ['119', 1],
  ['215', 3],
  ['312', 3],
  ['318', 3],
];

const LISTS = {
  1: regionList.filter((r) => r.cod_regione === '01'),
  2: UTS_RECORDS.map(([code, type]) => {
    const item = utsList.find((r) => r.cod_uts === code && r['tipo uts'] === type);
    if (item === undefined) throw new Error(`r2 has no ${code}/${type}`);
    return item;
  }),
  3: municipalityPairs([
    ['099031', 'Sassofeltrio'],
    ['041060', 'Sassofeltrio'],
    ['115064', 'Siamanna'],
    ['095057', 'Siamanna'],
    ['095057', 'Siamanna-Siapiccia'],
    ['092128', 'Siamanna-Siapiccia'],
  ]),
};

const COURMAYEUR = municipalityPairs([
  ['007022', 'Courmayeur'],
  ['007022', 'Cormaiore'],
  ['001894', 'Courmayeur'],
]);

function municipalityPairs(pairs: [string, string][]): Record<string, unknown>[] {
  return pairs.map(([code, name]) => {
    const item = municipalityList.find((r) => r.pro_com_t === code && r.comune === name);
    if (item === undefined) throw new Error(`r3 has no ${code} ${name}`);
    return item;
  });
}

interface Run {
  result: InternalCrawlResult;
  anomalies: AnomalyCollector;
  calls: HttpRequest[];
}

async function crawl(
  storeDir: string,
  transport: Transport,
  options: { mustRefresh?: (item: CrawlItem) => boolean; concurrency?: number; levels?: Level[] } = {},
): Promise<Run> {
  return withSources(
    async ({ situasInternal, calls }) => {
      const anomalies = new AnomalyCollector();
      const result = await crawlInternal({
        source: situasInternal,
        store: new Store(storeDir),
        anomalies,
        concurrency: options.concurrency ?? 1,
        ...(options.mustRefresh === undefined ? {} : { mustRefresh: options.mustRefresh }),
        ...(options.levels === undefined ? {} : { levels: options.levels }),
      });
      return { result, anomalies, calls: [...calls] };
    },
    { transport, http: { maxAttempts: 2, circuitBreakerThreshold: 1000 } },
  );
}

const refreshLists = (item: CrawlItem): boolean => item.report <= 3;

function urls(calls: readonly HttpRequest[], report: number): string[] {
  return calls.filter((c) => reportOf(c) === report).map(reportUrlOf);
}

function component(result: InternalCrawlResult, level: 'region' | 'province' | 'municipality', id: number) {
  const found = result[level]?.graph.byId.get(id);
  if (found === undefined) throw new Error(`no ${level} component for ${id}`);
  return found;
}

describe('internal crawl (§6.8)', () => {
  it('crawls every listed record, its details, and builds the identity graphs', async () => {
    await withTempDir(async (dir) => {
      const { result, anomalies, calls } = await crawl(dir, await internalWorld({ lists: LISTS }));

      expect(anomalies.list()).toEqual([]);
      expect(result.region?.complete).toBe(true);
      expect(result.province?.complete).toBe(true);
      expect(result.municipality?.complete).toBe(true);

      expect(component(result, 'region', 14)).toMatchObject({ root: 14 });
      expect(component(result, 'province', 119)).toMatchObject({ root: 9, ids: [9, 119] });
      expect(component(result, 'province', 127)).toMatchObject({ root: 59, ids: [59, 127] });
      expect(component(result, 'province', 143)).toMatchObject({ root: 58, ids: [58, 143] });
      expect(component(result, 'province', 146).ids).toEqual([146]);
      expect(component(result, 'province', 144).ids).toEqual([144]);
      expect(component(result, 'municipality', 4450)).toMatchObject({ root: 4450, ids: [4450] });
      expect(result.municipality?.graph.components.map((c) => c.root)).toEqual([4450, 10704]);

      // r4/r5 once per listed record.
      expect(urls(calls, 4)).toHaveLength(LISTS[1].length);
      expect(urls(calls, 5)).toHaveLength(LISTS[2].length);
      // One r6 per entity, in pair order: every other pair is covered by the history of the first.
      expect(urls(calls, 6)).toEqual([
        reportUrls.municipalityEvents({ code: '041060', name: 'Sassofeltrio' }),
        reportUrls.municipalityEvents({ code: '092128', name: 'Siamanna-Siapiccia' }),
      ]);
      // No municipality event is ambiguous: no r9.
      expect(urls(calls, 9)).toEqual([]);
    });
  });

  it('asks r9 only for the events of one entity with the same date and code under several acts', async () => {
    await withTempDir(async (dir) => {
      const lists = { 3: municipalityPairs([['092092', 'Riola Sardo']]) };
      const first = await crawl(dir, await internalWorld({ lists }), { levels: ['municipality'] });

      expect(first.anomalies.list()).toEqual([]);
      // Riola Sardo: two CECS of 1946-02-07, acts 5831 and 5841 (golden-21).
      expect(urls(first.calls, 9)).toEqual(
        [5831, 5841].map((actId) => reportUrls.municipalityEventDetails({ originId: 7543, actId, event: 'CECS' })),
      );
      const details = (actId: number) =>
        component(first.result, 'municipality', 7543)
          .events.find((e) => e.event.actId === actId)
          ?.details?.map((d) => d.related?.code);
      expect([details(5831), details(5841)]).toEqual([['092014'], ['092074']]);
      expect(component(first.result, 'municipality', 7543).events.filter((e) => e.details !== null)).toHaveLength(2);

      // Stored like every internal report: the next run reads them back without requests.
      const second = await crawl(dir, await internalWorld({ lists, offline: true }), { levels: ['municipality'] });
      expect(second.calls).toEqual([]);
      expect(second.result.municipality?.graph.components).toEqual(first.result.municipality?.graph.components);
    });
  });

  it('asks details for every distinct event except PV, CD and RN, with the event origin id', async () => {
    await withTempDir(async (dir) => {
      const { result, calls } = await crawl(dir, await internalWorld({ lists: LISTS }), {
        levels: ['region', 'province'],
      });

      const details = [...urls(calls, 7), ...urls(calls, 8)];
      expect(details.some((u) => /mcrvar=(PV|CD|RN)\b/.test(u))).toBe(false);
      expect(new Set(details).size).toBe(details.length);
      expect(urls(calls, 7)).toContain(
        reportUrls.regionEventDetails({ originId: 14, regionType: 'compartment', actId: 6109, event: 'CS' }),
      );
      // The Milano metropolitan city (`id_uts` 119) is asked with its origin id 9.
      expect(urls(calls, 8)).toContain(
        reportUrls.utsEventDetails({ originId: 9, utsType: 'metropolitan_city', actId: 6029, event: 'CSCT' }),
      );

      const sudSardegna = component(result, 'province', 126).events.find((e) => e.event.event === 'ES');
      expect(sudSardegna?.details?.map((d) => d.related?.code).sort()).toEqual(['114', '116', '117', '119', '318']);
      const milano = component(result, 'province', 9).events;
      expect(milano.find((e) => e.event.event === 'ESCT')?.details).toMatchObject([
        { related: { code: '215', type: 'metropolitan_city' } },
      ]);
      expect(milano.find((e) => e.event.event === 'PV')?.details).toBeNull();
      const piemonte = component(result, 'region', 14).events;
      expect(piemonte.find((e) => e.event.event === 'CS')?.details).toMatchObject([{ related: { code: '81' } }]);
    });
  });

  it('summarises the observed (level, event code) pairs and writes them outside the store', async () => {
    await withTempDir(async (dir) => {
      const { result } = await crawl(join(dir, 'store'), await internalWorld({ lists: LISTS }));
      expect(result.eventCodes).toEqual({
        region: { CS: 1, CSCT: 1, AQ: 2, CE: 1, ES: 1 },
        province: { PV: 3, CS: 5, CSCT: 3, AQES: 4, AQ: 1, CE: 5, CECS: 13, RN: 2, ES: 1, ESCT: 3 },
        municipality: { PV: 1, CS: 2, AP: 2, CD: 1, RN: 1, ES: 1, CECS: 1 },
      });
      const path = await saveEventCodeSummary(join(dir, 'reports'), result.eventCodes);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(result.eventCodes);
    });
  });

  it('gives the same graphs whatever the concurrency', async () => {
    await withTempDir(async (dir) => {
      // In parallel, pairs may be asked before the history covering them arrives.
      const sequential = await crawl(join(dir, 'a'), await internalWorld({ lists: LISTS }));
      const parallel = await crawl(join(dir, 'b'), await internalWorld({ lists: LISTS }), { concurrency: 8 });
      for (const level of ['region', 'province', 'municipality'] as const) {
        expect(parallel.result[level]?.graph.components).toEqual(sequential.result[level]?.graph.components);
      }
    });
  });
});

describe('incremental crawl', () => {
  it('reads stored reports without network and only sends requests for new pairs', async () => {
    await withTempDir(async (dir) => {
      const first = await crawl(dir, await internalWorld({ lists: LISTS }));
      const lists = { ...LISTS, 3: [...LISTS[3], ...COURMAYEUR] };
      const second = await crawl(dir, await internalWorld({ lists }), { mustRefresh: refreshLists });

      expect(second.anomalies.list()).toEqual([]);
      expect(second.calls.map(reportOf)).toEqual([1, 2, 3, 6]);
      expect(urls(second.calls, 6)).toEqual([reportUrls.municipalityEvents({ code: '001894', name: 'Courmayeur' })]);
      expect(component(second.result, 'municipality', 396).records.map((r) => `${r.code} ${r.name}`)).toEqual([
        '001894 Courmayeur',
        '007022 Cormaiore',
        '007022 Courmayeur',
      ]);
      for (const level of ['region', 'province'] as const) {
        expect(second.result[level]?.graph.components).toEqual(first.result[level]?.graph.components);
      }
    });
  });

  it('refreshes a stored record when required, even if another history covers it', async () => {
    await withTempDir(async (dir) => {
      await crawl(dir, await internalWorld({ lists: LISTS }));
      const siamanna = { code: '115064', name: 'Siamanna' };
      const { calls } = await crawl(dir, await internalWorld({ lists: LISTS }), {
        mustRefresh: (item) => item.report === 6 && item.record.code === siamanna.code,
      });
      expect(calls.map(reportUrlOf)).toEqual([reportUrls.municipalityEvents(siamanna)]);
    });
  });
});

describe('refreshed histories', () => {
  it('replace the stored ones of the same entity instead of being merged with them', async () => {
    await withTempDir(async (dir) => {
      await crawl(dir, await internalWorld({ lists: LISTS }));
      // ISTAT corrects the 2026 renumbering of Siamanna: the stored history (read for another
      // pair of the entity) must not keep the old row.
      const siamanna = { code: '115064', name: 'Siamanna' };
      const items = await rawItems('r6-municipality-events/115064_siamanna.json');
      const corrected = items.map((i) => (i['tipo variazione'] === 'RN' ? { ...i, 'data evento': '02/01/2026' } : i));
      const { result } = await crawl(
        dir,
        await internalWorld({
          lists: LISTS,
          responses: { [reportUrls.municipalityEvents(siamanna)]: internalItems(corrected) },
        }),
        { mustRefresh: (item) => item.report === 6 && item.record.code === siamanna.code },
      );
      const renumberings = component(result, 'municipality', 10704).events.filter((e) => e.event.event === 'RN');
      expect(renumberings.map((e) => e.event.date)).toEqual(['2026-01-02']);
    });
  });

  it('replace the stored events of the same UTS record queried under another code', async () => {
    await withTempDir(async (dir) => {
      const cagliari292 = utsList.find((r) => r.cod_uts === '292' && r['tipo uts'] === 3);
      if (cagliari292 === undefined) throw new Error('r2 has no 292/3');
      const lists = { ...LISTS, 2: [...LISTS[2], cagliari292] };
      const record292 = { code: '292', name: 'Cagliari', type: 'metropolitan_city' } as const;
      const record318 = { code: '318', name: 'Cagliari', type: 'metropolitan_city' } as const;
      const original = await rawItems('r5-uts-events/318_3_cagliari.json');
      const responses = { [reportUrls.utsEvents(record292)]: internalItems(original) };
      await crawl(dir, await internalWorld({ lists, responses }), { levels: ['province'] });

      const corrected = original.filter((i) => i['tipo variazione'] !== 'AQES');
      const { result } = await crawl(
        dir,
        await internalWorld({ lists, responses: { [reportUrls.utsEvents(record318)]: internalItems(corrected) } }),
        { mustRefresh: (item) => item.report === 5 && item.record.code === '318', levels: ['province'] },
      );
      const cagliari = result.province?.graph.byId.get(127);
      expect(cagliari?.events.filter((e) => e.event.utsId === 127).map((e) => e.event.event)).toEqual(['CSCT', 'RN']);
      expect(cagliari?.records.map((r) => r.code)).toEqual(['092', '292', '318']);
    });
  });
});

describe('internal crawl anomalies', () => {
  it('blocks a listed record whose events report is empty, and keeps the endpoint enabled', async () => {
    await withTempDir(async (dir) => {
      const empty = { code: '119', name: 'Sulcis Iglesiente', type: 'province' } as const;
      const emptyPair = { code: '095057', name: 'Siamanna' };
      const transport = await internalWorld({
        lists: {
          ...LISTS,
          3: municipalityPairs([
            ['095057', 'Siamanna'],
            ['099031', 'Sassofeltrio'],
          ]),
        },
        responses: {
          [reportUrls.utsEvents(empty)]: EMPTY_INTERNAL,
          [reportUrls.municipalityEvents(emptyPair)]: EMPTY_INTERNAL,
        },
      });
      const { result, anomalies, calls } = await crawl(dir, transport);

      expect(anomalies.list()).toMatchObject([
        {
          level: 'blocking',
          code: INTERNAL_CRAWL_ANOMALIES.emptyEvents,
          context: { level: 'province', record: empty },
        },
        {
          level: 'blocking',
          code: INTERNAL_CRAWL_ANOMALIES.emptyEvents,
          context: { level: 'municipality', record: emptyPair },
        },
      ]);
      // Later r5 and r6 requests are still sent.
      expect(urls(calls, 5)).toHaveLength(LISTS[2].length);
      expect(urls(calls, 6)).toHaveLength(2);
      expect(component(result, 'municipality', 4450).root).toBe(4450);
    });
  });

  it('reports missing internal data as a warning per report when no copy exists', async () => {
    await withTempDir(async (dir) => {
      const { result, anomalies } = await crawl(dir, await internalWorld({ lists: LISTS, offline: true }));
      expect(result).toMatchObject({ region: null, province: null, municipality: null, eventCodes: {} });
      expect(anomalies.has('blocking')).toBe(false);
      expect(anomalies.list()).toMatchObject(
        ['r1:region-list', 'r2:uts-list', 'r3:municipality-list'].map((report) => ({
          level: 'warning',
          code: INTERNAL_CRAWL_ANOMALIES.unavailable,
          context: { report },
        })),
      );
    });
  });

  it('marks a level incomplete when some record cannot be obtained', async () => {
    await withTempDir(async (dir) => {
      const transport = await internalWorld({ lists: LISTS });
      const sassari = { code: '312', name: 'Sassari', type: 'metropolitan_city' } as const;
      const flaky: Transport = (request, options) =>
        reportUrlOf(request) === reportUrls.utsEvents(sassari)
          ? Promise.resolve({ status: 503, headers: {}, body: '' })
          : transport(request, options);
      const { result, anomalies } = await crawl(dir, flaky, { levels: ['province'] });
      expect(result.province?.complete).toBe(false);
      expect(result.province?.graph.byId.has(143)).toBe(false);
      expect(anomalies.list()).toMatchObject([
        {
          level: 'warning',
          code: INTERNAL_CRAWL_ANOMALIES.unavailable,
          context: { report: 'r5:uts-events', requests: [{ ...sassari }] },
        },
      ]);
    });
  });

  it('falls back to stored data when a mandatory refresh fails (one warning per report)', async () => {
    await withTempDir(async (dir) => {
      const first = await crawl(dir, await internalWorld({ lists: LISTS }));
      const { result, anomalies } = await crawl(dir, await internalWorld({ lists: LISTS, offline: true }), {
        mustRefresh: (item) => item.report <= 5,
      });
      expect(anomalies.has('blocking')).toBe(false);
      expect(anomalies.list().map((a) => [a.level, a.code, a.context.report])).toEqual(
        ['r1:region-list', 'r2:uts-list', 'r3:municipality-list', 'r4:region-events', 'r5:uts-events'].map((r) => [
          'warning',
          INTERNAL_CRAWL_ANOMALIES.stale,
          r,
        ]),
      );
      expect(result.stale).toHaveLength(3 + LISTS[1].length + LISTS[2].length);
      for (const level of ['region', 'province', 'municipality'] as const) {
        expect(result[level]?.graph.components).toEqual(first.result[level]?.graph.components);
      }
    });
  });

  it('blocks schema violations and rejected requests without falling back to stored data', async () => {
    await withTempDir(async (dir) => {
      await crawl(dir, await internalWorld({ lists: LISTS }), { levels: ['region'] });
      const broken = LISTS[1].map((r) => ({ ...r, 'tipo regione': 9 }));
      const piemonte = { code: '01', name: 'Piemonte', type: 'region' } as const;
      const rejected: HttpResponse = { status: 404, headers: {}, body: '' };
      const listTransport = await internalWorld({ lists: { 1: broken } });
      const { result, anomalies } = await crawl(dir, listTransport, { mustRefresh: refreshLists, levels: ['region'] });
      expect(result.region).toBeNull();
      expect(anomalies.list()).toMatchObject([
        { level: 'blocking', code: INTERNAL_CRAWL_ANOMALIES.schemaViolation, context: { report: 'r1:region-list' } },
      ]);

      const recordTransport = await internalWorld({
        lists: LISTS,
        responses: { [reportUrls.regionEvents(piemonte)]: rejected },
      });
      const second = await crawl(dir, recordTransport, { mustRefresh: () => true, levels: ['region'] });
      expect(second.anomalies.list()).toMatchObject([
        {
          level: 'blocking',
          code: INTERNAL_CRAWL_ANOMALIES.rejected,
          context: { report: 'r4:region-events', requests: [{ ...piemonte }] },
        },
      ]);
      expect(second.result.region?.complete).toBe(false);
    });
  });

  it('serves lists double-encoded like the real API', () => {
    const response = internalItems([{ a: 1 }]);
    expect(JSON.parse(JSON.parse(response.body) as string)).toEqual({ items: [{ a: 1 }] });
  });
});
