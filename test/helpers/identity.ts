import { AnomalyCollector } from '../../src/anomalies.ts';
import { storeSnapshotProvider } from '../../src/completeness/index.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { canonicalJson } from '../../src/http/index.ts';
import {
  buildIdentityGraph,
  internalIdentity,
  type IdentityGraph,
  type IdentitySource,
  type InternalIdentity,
} from '../../src/identity/index.ts';
import type { Level } from '../../src/model/common.ts';
import { buildIntervalIndex, type IntervalIndex } from '../../src/resolve/index.ts';
import type {
  InternalMunicipalityEvent,
  InternalRegionEvent,
  InternalUtsEvent,
  UtsListRecord,
} from '../../src/sources/situas-internal/index.ts';
import type { SituasPublicSource } from '../../src/sources/situas-public/index.ts';
import { Store } from '../../src/store/index.ts';
import { withTempDir } from './http.ts';
import { decodedRows } from './internal.ts';

/**
 * With `codes`, a reduced world: its non-consecutive dates must not hide changes of the kept codes
 * that the test does not expect.
 */
export async function snapshotIndex<L extends Level>(
  source: SituasPublicSource,
  level: L,
  dates: readonly IsoDate[],
  codes?: readonly string[],
): Promise<IntervalIndex<L>> {
  return withTempDir(async (dir) => {
    const store = new Store(dir);
    const provider = storeSnapshotProvider({ store, source, mustRefresh: () => false });
    const snapshots = [];
    for (const date of dates) {
      await provider.snapshot(level, date);
      const stored = await store.getSnapshotEntries(level, date);
      if (stored === undefined) throw new Error(`no ${level} snapshot for ${date}`);
      snapshots.push({ date, rows: stored.rows.filter((r) => codes === undefined || codes.includes(r.row.code)) });
    }
    const anomalies = new AnomalyCollector();
    const index = await buildIntervalIndex({ level, snapshots, anomalies });
    if (anomalies.list().length > 0) throw new Error(`index anomalies: ${JSON.stringify(anomalies.list())}`);
    return index;
  });
}

const utsList = await decodedRows('utsList', 'r2-uts-list/all.json');

/** As `[code, type, fixture file]`. */
export async function utsIdentity(
  records: readonly [string, UtsListRecord['type'], string][],
  complete = true,
): Promise<InternalIdentity> {
  return internalIdentity(await utsGraph(records), complete, (e) => ({ ...e, recordId: e.utsId }), 'r5:uts-events');
}

/** As `[code, type, fixture file]`. */
export async function utsGraph(
  records: readonly [string, UtsListRecord['type'], string][],
): Promise<IdentityGraph<InternalUtsEvent>> {
  const sources: IdentitySource<InternalUtsEvent>[] = [];
  for (const [code, type, file] of records) {
    const listed = utsList.find((r) => r.code === code && r.type === type);
    if (listed === undefined) throw new Error(`UTS ${code} (${type}) not listed by r2`);
    sources.push({ listed, events: await decodedRows('utsEvents', `r5-uts-events/${file}`) });
  }
  return buildIdentityGraph<InternalUtsEvent>({
    level: 'province',
    sources,
    pointer: (e) => ({ id: e.utsId, originId: e.originId }),
    record: (e) => ({ id: e.utsId, code: e.code, name: e.name, type: e.type }),
    date: (e) => e.date,
    eventKey: canonicalJson,
    anomalies: new AnomalyCollector(),
  });
}

/** Never complete. */
export async function municipalityIdentity(files: readonly string[]): Promise<InternalIdentity> {
  return internalIdentity(
    await municipalityGraph(files),
    false,
    (e) => ({ ...e, recordId: e.originId }),
    'r6:municipality-events',
  );
}

export async function municipalityGraph(files: readonly string[]): Promise<IdentityGraph<InternalMunicipalityEvent>> {
  const sources: IdentitySource<InternalMunicipalityEvent>[] = [];
  for (const file of files) {
    const events = await decodedRows('municipalityEvents', `r6-municipality-events/${file}`);
    const [first] = events;
    if (first === undefined) throw new Error(`${file} has no events`);
    sources.push({ listed: { code: first.currentCode, name: first.currentName, type: null, originId: null }, events });
  }
  return buildIdentityGraph<InternalMunicipalityEvent>({
    level: 'municipality',
    sources,
    pointer: (e) => ({ id: e.originId, originId: e.originId }),
    record: (e) => ({ id: e.originId, code: e.code, name: e.name, type: null }),
    date: (e) => e.date,
    eventKey: canonicalJson,
    anomalies: new AnomalyCollector(),
  });
}

/** Never complete. */
export async function piemonteIdentity(): Promise<InternalIdentity> {
  return regionIdentity([
    ['01', 'compartment', '01_1_piemonte.json'],
    ['01', 'region', '01_2_piemonte.json'],
  ]);
}

/** As `[code, type, fixture file]`; never complete. */
export async function regionIdentity(
  records: readonly [string, InternalRegionEvent['type'], string][],
): Promise<InternalIdentity> {
  return internalIdentity(
    await regionGraph(records),
    false,
    (e) => ({ ...e, recordId: e.originId }),
    'r4:region-events',
  );
}

/** As `[code, type, fixture file]`. */
export async function regionGraph(
  records: readonly [string, InternalRegionEvent['type'], string][],
): Promise<IdentityGraph<InternalRegionEvent>> {
  const regionList = await decodedRows('regionList', 'r1-region-list/all.json');
  const sources: IdentitySource<InternalRegionEvent>[] = [];
  for (const [code, type, file] of records) {
    const listed = regionList.find((r) => r.code === code && r.type === type);
    if (listed === undefined) throw new Error(`region ${code} (${type}) not listed by r1`);
    sources.push({ listed, events: await decodedRows('regionEvents', `r4-region-events/${file}`) });
  }
  return buildIdentityGraph<InternalRegionEvent>({
    level: 'region',
    sources,
    pointer: (e) => ({ id: e.originId, originId: e.originId }),
    record: (e) => ({ id: e.originId, code: e.code, name: e.name, type: e.type }),
    date: (e) => e.date,
    eventKey: canonicalJson,
    anomalies: new AnomalyCollector(),
  });
}
