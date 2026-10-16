/**
 * Code resolver on real SITUAS fixtures (§6.6): golden-6 (same-day suppressions) and the
 * Sud Sardegna / Ogliastra side rule of golden-4 (§3.5 item 6).
 */
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { storeSnapshotProvider } from '../../src/completeness/index.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { canonicalJson } from '../../src/http/index.ts';
import { buildIdentityGraph, type IdentitySource } from '../../src/identity/index.ts';
import type { Level } from '../../src/model/common.ts';
import {
  CodeResolver,
  internalAliases,
  loadIntervalIndex,
  municipalityAliases,
  ResolutionError,
  type ResolutionSide,
  type ResolveQuery,
} from '../../src/resolve/index.ts';
import type { InternalUtsEvent, UtsListRecord } from '../../src/sources/situas-internal/index.ts';
import type { EventRowByLevel } from '../../src/sources/situas-public/index.ts';
import { Store } from '../../src/store/index.ts';
import { withTempDir } from '../helpers/http.ts';
import { decodedRows } from '../helpers/internal.ts';
import { withSources } from '../helpers/sources.ts';

/** Days of the same-day suppressions and the day before each (golden-6). */
const SAME_DAY_DATES = ['1923-02-08', '1927-01-12', '1936-06-04'] as const;
const MUNICIPALITY_DATES: IsoDate[] = [
  '1923-02-07',
  '1923-02-08',
  '1927-01-11',
  '1927-01-12',
  '1936-06-03',
  '1936-06-04',
];
const PROVINCE_DATES: IsoDate[] = ['2025-12-31', '2026-01-01'];

const world = await withSources(({ situasPublic }) =>
  withTempDir(async (dir) => {
    const store = new Store(dir);
    const provider = storeSnapshotProvider({ store, source: situasPublic, mustRefresh: () => false });
    for (const date of MUNICIPALITY_DATES) await provider.snapshot('municipality', date);
    for (const date of PROVINCE_DATES) await provider.snapshot('province', date);
    const anomalies = new AnomalyCollector();
    return {
      anomalies,
      municipalities: await loadIntervalIndex(store, 'municipality', MUNICIPALITY_DATES, anomalies),
      provinces: await loadIntervalIndex(store, 'province', PROVINCE_DATES, anomalies),
      suppressions: (await situasPublic.fetchEventList('municipality', 98, '1861-03-17', '2026-09-30')).data,
      codeChanges: (await situasPublic.fetchEventList('municipality', 105, '1861-03-17', '2026-09-30')).data,
      utsSuppressions: (await situasPublic.fetchEventList('province', 112, '2026-01-01', '2026-09-30')).data,
      utsEstablishments: (await situasPublic.fetchEventList('province', 113, '2026-01-01', '2026-09-30')).data,
    };
  }),
);

const utsList = await decodedRows('utsList', 'r2-uts-list/all.json');

async function utsSource(code: string, type: UtsListRecord['type'], fixture: string) {
  const listed = utsList.find((r) => r.code === code && r.type === type);
  if (listed === undefined) throw new Error(`UTS ${code} (${type}) not listed by r2`);
  return { listed, events: await decodedRows('utsEvents', `r5-uts-events/${fixture}`) };
}

const utsSources: IdentitySource<InternalUtsEvent>[] = [
  await utsSource('090', 'province', '090_1_sassari.json'),
  await utsSource('312', 'metropolitan_city', '312_3_sassari.json'),
  await utsSource('092', 'province', '092_1_cagliari.json'),
  await utsSource('318', 'metropolitan_city', '318_3_cagliari.json'),
  await utsSource('111', 'province', '111_1_sud-sardegna.json'),
  await utsSource('114', 'province', '114_1_nuoro.json'),
  await utsSource('116', 'province', '116_1_ogliastra.json'),
  await utsSource('117', 'province', '117_1_medio-campidano.json'),
  await utsSource('119', 'province', '119_1_sulcis-iglesiente.json'),
];
const utsGraph = buildIdentityGraph<InternalUtsEvent>({
  level: 'province',
  sources: utsSources,
  pointer: (e) => ({ id: e.utsId, originId: e.originId }),
  record: (e) => ({ id: e.utsId, code: e.code, name: e.name, type: e.type }),
  date: (e) => e.date,
  eventKey: canonicalJson,
  anomalies: new AnomalyCollector(),
});

const resolver = new CodeResolver({ municipality: world.municipalities, province: world.provinces }, [
  ...municipalityAliases(world.codeChanges),
  ...internalAliases(utsGraph, (e) => ({ ...e, recordId: e.utsId }), 'r5:uts-events'),
]);

function sides(event: string): { subject: ResolutionSide; related: ResolutionSide } {
  return ['ES', 'ESCT', 'AS'].includes(event)
    ? { subject: 'predecessor', related: 'successor' }
    : { subject: 'successor', related: 'predecessor' };
}

function resolveRow<L extends Level>(level: L, row: EventRowByLevel[L], part: 'subject' | 'related') {
  const query: ResolveQuery<L> = {
    level,
    code: part === 'subject' ? row.code : (row.related?.code ?? ''),
    date: row.date,
    side: sides(row.event)[part],
    cadastralCode:
      level === 'municipality'
        ? part === 'subject'
          ? (row as EventRowByLevel['municipality']).cadastralCode
          : (row as EventRowByLevel['municipality']).related?.cadastralCode
        : null,
  };
  return resolver.resolve(query);
}

describe('interval index on real snapshots', () => {
  it('indexes the stored snapshots without anomalies', () => {
    expect(world.anomalies.list()).toEqual([]);
  });

  it('keeps one interval while a code identifies the same row, and splits it when the row changes', () => {
    // Chignolo Po: the same row in every snapshot, across the 1927 regime boundary.
    expect(world.municipalities.at('018048', '1936-06-04')).toMatchObject({
      validFrom: '1923-02-07',
      validTo: null,
      row: { officialName: 'Chignolo Po' },
    });
    // Cantonale (015992) disappears on the day of its same-day code change and suppression.
    expect(world.municipalities.intervals('015992').map((i) => [i.validFrom, i.validTo])).toEqual([
      ['1923-02-07', '1936-06-04'],
    ]);
  });
});

describe('golden-6: same-day suppressions', () => {
  const rows = world.suppressions.filter((r) => (SAME_DAY_DATES as readonly string[]).includes(r.date));

  it('resolves every suppression of those days, 20 of them through a same-day alias', () => {
    const subjects = rows.map((row) => ({ row, resolution: resolveRow('municipality', row, 'subject') }));
    const viaAlias = subjects
      .filter((s) => s.resolution.path === 'alias')
      .map(({ row, resolution }) => [
        row.date,
        row.code,
        resolution.interval.code,
        resolution.interval.row.officialName,
      ]);
    expect(viaAlias).toEqual(
      expect.arrayContaining([
        ['1927-01-12', '009813', '010877', 'Finalborgo'],
        ['1927-01-12', '009814', '010878', 'Finale Marina'],
        ['1927-01-12', '009815', '010879', 'Finale Pia'],
        ['1927-01-12', '031804', '030876', 'Lucinico'],
        ['1936-06-04', '018816', '015992', 'Cantonale'],
      ]),
    );
    expect(viaAlias).toHaveLength(20);
    expect(viaAlias.filter(([date]) => date === '1927-01-12')).toHaveLength(17);
    expect(viaAlias.filter(([date]) => date === '1923-02-08')).toHaveLength(2);
    // Every alias reaches the suppressed municipality itself, under its code of the day before.
    for (const { row, resolution } of subjects.filter((s) => s.resolution.path === 'alias')) {
      expect(resolution.interval.row.officialName).toBe(row.name);
    }
    expect(subjects.filter((s) => s.resolution.path === 'cadastral')).toEqual([]);
  });

  it('resolves every absorbing municipality directly, 15 of them under a code assigned that day', () => {
    const related = rows.filter((r) => r.related?.code != null);
    const resolutions = related.map((row) => resolveRow('municipality', row, 'related'));
    expect(resolutions.every((r) => r.path === 'direct')).toBe(true);
    expect(resolutions.find((r) => r.interval.code === '009029')?.interval.row.officialName).toBe('Finale Ligure');

    const sameDayCodes = new Set(world.codeChanges.map((c) => `${c.date}|${c.related?.code}`));
    const sameDayAliases = rows.filter((r) => sameDayCodes.has(`${r.date}|${r.code}`));
    expect(sameDayAliases.filter((r) => sameDayCodes.has(`${r.date}|${r.related?.code}`))).toHaveLength(15);
  });

  it('cannot resolve the new code of a same-day code change of a municipality suppressed that day', () => {
    // The `AP` of Finalborgo to Savona: its new code never appears in a snapshot (D15).
    const query: ResolveQuery = { level: 'municipality', code: '009813', date: '1927-01-12', side: 'successor' };
    expect(() => resolver.resolve(query)).toThrow(ResolutionError);
    const anomalies = new AnomalyCollector();
    expect(resolver.resolveOrReport(query, anomalies, { source: 'events:pfun-105' })).toBeNull();
    expect(anomalies.list()).toMatchObject([
      {
        level: 'blocking',
        code: 'code-unresolved',
        context: { source: 'events:pfun-105', code: '009813', lookup_date: '1927-01-12', alias_codes: [] },
      },
    ]);
  });
});

describe('golden-4: side rule of the related territory (Sud Sardegna ES, Ogliastra CS)', () => {
  it('resolves Nuoro as a successor by 114 on the event day and as a predecessor by 091 the day before', () => {
    const suppression = world.utsSuppressions.find((r) => r.code === '111' && r.related?.code === '114');
    const establishment = world.utsEstablishments.find((r) => r.code === '116' && r.related?.code === '091');
    if (suppression === undefined || establishment === undefined) throw new Error('rows missing from the fixtures');

    expect(resolveRow('province', suppression, 'related')).toMatchObject({
      intervalKey: '114@2026-01-01',
      path: 'direct',
      interval: { row: { name: 'Nuoro' } },
    });
    expect(resolveRow('province', establishment, 'related')).toMatchObject({
      intervalKey: '091@2025-12-31',
      path: 'direct',
      interval: { row: { name: 'Nuoro' } },
    });
  });

  it('resolves every 2026 row of pfun 112 and 113 directly on its side', () => {
    const rows = [...world.utsSuppressions, ...world.utsEstablishments];
    const paths = rows.flatMap((row) => [
      resolveRow('province', row, 'subject').path,
      resolveRow('province', row, 'related').path,
    ]);
    expect(paths).toHaveLength(2 * rows.length);
    expect(new Set(paths)).toEqual(new Set(['direct']));
  });

  it('reaches the other code through the internal RN and type change aliases on the wrong side', () => {
    const resolve = (code: string, side: ResolutionSide) =>
      resolver.resolve({ level: 'province', code, date: '2026-01-01', side });
    expect(resolve('091', 'successor')).toMatchObject({ intervalKey: '114@2026-01-01', path: 'alias' });
    expect(resolve('114', 'predecessor')).toMatchObject({ intervalKey: '091@2025-12-31', path: 'alias' });
    expect(resolve('090', 'successor')).toMatchObject({ intervalKey: '312@2026-01-01', path: 'alias' });
    expect(resolve('318', 'predecessor')).toMatchObject({ intervalKey: '292@2025-12-31', path: 'alias' });
  });
});
