/**
 * The declarative world of the command tests (`test/helpers/world.ts`) answers in the raw formats of
 * the real sources: every kind of generated row has the field set of a real row of the fixtures,
 * and every response decodes with the production adapters.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/http/index.ts';
import { reportUrls } from '../../src/sources/situas-internal/index.ts';
import { FIXTURES_ROOT } from '../helpers/fixtures.ts';
import { withSources } from '../helpers/sources.ts';
import {
  ANPR_HEADER,
  anprCsv,
  baseWorld,
  eventListRows,
  municipalityEventItems,
  municipalityListItems,
  municipalitySnapshotRows,
  regionEventItems,
  regionListItems,
  regionSnapshotRows,
  respond,
  utsEventItems,
  utsListItems,
  utsSnapshotRows,
  withSettevilleFusion,
  worldTransport,
} from '../helpers/world.ts';

const world = withSettevilleFusion(baseWorld(), '2024-01-22');

async function publicRows(path: string): Promise<Record<string, unknown>[]> {
  return (JSON.parse(await readFile(join(FIXTURES_ROOT, path), 'utf8')) as { resultset: Record<string, unknown>[] })
    .resultset;
}

async function internalItems(path: string): Promise<Record<string, unknown>[]> {
  const text = JSON.parse(await readFile(join(FIXTURES_ROOT, 'situas-internal', path), 'utf8')) as string;
  return (JSON.parse(text) as { items: Record<string, unknown>[] }).items;
}

const keys = (row: Record<string, unknown>) => canonicalJson(Object.keys(row).sort());
/** JSON types of the values, by field: numbers stay numbers, strings stay strings. */
const types = (row: Record<string, unknown>) =>
  canonicalJson(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v])));

/** Some real row has exactly the fields (and value types) of every generated row. */
function expectShapes(generated: readonly Record<string, unknown>[], real: readonly Record<string, unknown>[]): void {
  expect(generated.length).toBeGreaterThan(0);
  const shapes = new Set(real.map((r) => `${keys(r)}${types(r)}`));
  for (const row of generated) expect([...shapes]).toContain(`${keys(row)}${types(row)}`);
}

describe('world formats: field sets of real rows', () => {
  it('snapshots (pfun 68, 64, 61)', async () => {
    expectShapes(
      regionSnapshotRows(world, '2026-01-01'),
      await publicRows('situas-public/snapshots/regions/pfun-68_2026-10-01.json'),
    );
    expectShapes(
      utsSnapshotRows(world, '2026-01-01'),
      await publicRows('situas-public/snapshots/provinces/pfun-64_2026-10-01.json'),
    );
    expectShapes(
      municipalitySnapshotRows(world, '2026-01-01'),
      await publicRows('situas-public/snapshots/municipalities/pfun-61_2026-10-01.json'),
    );
  });

  it('event lists: suppressions (98), establishments with COD_VARIAZIONE_M (100), renames without a code (104)', async () => {
    const all = (pfun: number) => eventListRows(world, pfun, '2000-01-01', '2026-10-01');
    expectShapes(all(98), await publicRows('situas-public/events/municipalities/pfun-98_1861-03-17_2026-09-30.json'));
    expectShapes(all(100), await publicRows('situas-public/events/municipalities/pfun-100_1861-03-17_2026-10-01.json'));
    expectShapes(all(104), await publicRows('situas-public/events/municipalities/pfun-104_1861-03-17_2026-09-30.json'));
    expect(all(100).every((r) => 'COD_VARIAZIONE_M' in r && !('COD_VARIAZIONE' in r))).toBe(true);
    expect(all(104).every((r) => !('COD_VARIAZIONE' in r))).toBe(true);
  });

  it('internal reports r1–r6', async () => {
    expectShapes(regionListItems(world), await internalItems('r1-region-list/all.json'));
    expectShapes(utsListItems(world), await internalItems('r2-uts-list/all.json'));
    expectShapes(municipalityListItems(world), await internalItems('r3-municipality-list/all.json'));
    expectShapes(regionEventItems(world, '05'), await internalItems('r4-region-events/01_2_piemonte.json'));
    expectShapes(utsEventItems(world, '025'), await internalItems('r5-uts-events/312_3_sassari.json'));
    const r6 = await Promise.all(
      ['025042_quero.json', '025070_quero-vas.json', '025002_alano-di-piave.json', '025075_setteville.json'].map((f) =>
        internalItems(`r6-municipality-events/${f}`),
      ),
    );
    expectShapes(
      [
        ...municipalityEventItems(world, '025070', 'Quero Vas'),
        ...municipalityEventItems(world, '025075', 'Setteville'),
        ...municipalityEventItems(world, '028001', 'Abano Terme'),
      ],
      r6.flat(),
    );
  });

  it('the ANPR archive: header, quoting and CRLF', async () => {
    const real = await readFile(join(FIXTURES_ROOT, 'anpr', 'anpr-archivio-comuni_2026-09-30.csv'), 'utf8');
    const [header] = real.split('\r\n');
    expect(ANPR_HEADER).toBe(header);
    const csv = anprCsv(world);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(
      csv
        .split('\r\n')
        .slice(1, -1)
        .every((l) => l.split(',').length === ANPR_HEADER.split(',').length),
    ).toBe(true);
  });

  it('internal bodies: double-encoded JSON, text/plain when empty; `ND` for a missing cadastral code', () => {
    const request = (url: string) => ({
      method: 'POST' as const,
      url: 'https://situas.istat.it/ShibO2Module/api/Report/ReportByUrl',
      body: { url },
    });
    const listed = respond(world, request(reportUrls.regionList()));
    expect(listed.headers['content-type']).toMatch(/^application\/json/);
    expect(typeof JSON.parse(listed.body)).toBe('string');
    const empty = respond(world, request(reportUrls.municipalityEvents({ code: '999999', name: 'Nessuno' })));
    expect(empty).toMatchObject({
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: '{\n"items":[\n]\n}',
    });
    expect(municipalitySnapshotRows(world, '2026-01-01').find((r) => r.PRO_COM_T === '091099')?.COD_CATASTO).toBe('ND');
  });
});

describe('world formats: decoded by the production adapters', () => {
  it('serves every request of a run', async () => {
    await withSources(
      async ({ situasPublic, situasInternal, anpr }) => {
        const municipalities = (await situasPublic.fetchSnapshot('municipality', '2024-01-22')).data.snapshot.rows;
        expect(municipalities.find((r) => r.code === '091099')?.cadastralCode).toBeNull();
        expect(municipalities.map((r) => r.code)).toContain('025075');
        expect((await situasPublic.fetchSnapshot('province', '2024-01-22')).data.snapshot.rows).toHaveLength(4);
        expect((await situasPublic.fetchSnapshot('region', '2024-01-22')).data.snapshot.rows).toHaveLength(2);
        expect((await situasPublic.fetchCount(61, { date: '2024-01-22' })).data).toBe(municipalities.length);
        const established = (await situasPublic.fetchEventList('municipality', 100, '2000-01-01', '2026-10-01')).data;
        expect(established.map((r) => [r.event, r.code, r.related?.code])).toEqual([
          ['CS', '025070', '025042'],
          ['CS', '025070', '025064'],
          ['CS', '025075', '025070'],
          ['CS', '025075', '025002'],
        ]);
        const renames = (await situasPublic.fetchEventList('municipality', 104, '2000-01-01', '2026-10-01')).data;
        expect(renames.map((r) => [r.event, r.name, r.related?.name])).toEqual([['CD', 'Abano', 'Abano Terme']]);
        expect((await situasPublic.fetchEventList('province', 112, '2000-01-01', '2026-10-01')).data).toEqual([]);

        const regions = (await situasInternal.regionList()).data;
        expect(regions.map((r) => [r.code, r.type, r.originId])).toEqual([
          ['05', 'region', 9],
          ['20', 'region', 23],
        ]);
        expect((await situasInternal.regionEvents({ code: '05', name: 'Veneto', type: 'region' })).data).toHaveLength(
          1,
        );
        expect((await situasInternal.utsList()).data).toHaveLength(4);
        expect((await situasInternal.utsEvents({ code: '091', name: 'Nuoro', type: 'province' })).data).toMatchObject([
          { event: 'PV', utsId: 59, originId: 59 },
        ]);
        expect((await situasInternal.municipalityList()).data).toContainEqual({ code: '028001', name: 'Abano' });
        const queroVas = (await situasInternal.municipalityEvents({ code: '025070', name: 'Quero Vas' })).data;
        expect(queroVas.map((e) => [e.event, e.date, e.actId, e.originId])).toEqual([
          ['CS', '2013-12-28', 5964, 11188],
          ['ES', '2024-01-22', 6141, 11188],
        ]);
        expect((await situasInternal.municipalityEvents({ code: '999999', name: 'Nessuno' })).data).toEqual([]);

        const archive = (await anpr.fetchAnpr()).data;
        expect(archive.issues).toEqual([]);
        expect(archive.rows.find((r) => r.istatCode === '091099')?.cadastralCode).toBeNull();
        expect(archive.rows.find((r) => r.istatCode === '025070')).toMatchObject({
          validFrom: '2013-12-28',
          validTo: '2024-01-22',
          status: 'C',
        });
      },
      { transport: worldTransport(world).transport },
    );
  });
});
