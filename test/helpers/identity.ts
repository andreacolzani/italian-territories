/** Worlds for identity tests: interval indexes of real snapshots, optionally reduced to some codes. */
import { AnomalyCollector } from '../../src/anomalies.ts';
import { storeSnapshotProvider } from '../../src/completeness/index.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { canonicalJson } from '../../src/http/index.ts';
import {
  buildIdentityGraph,
  internalIdentity,
  type IdentitySource,
  type InternalIdentity,
} from '../../src/identity/index.ts';
import type { Level } from '../../src/model/common.ts';
import { buildIntervalIndex, type IntervalIndex } from '../../src/resolve/index.ts';
import type {
  InternalMunicipalityEvent,
  InternalUtsEvent,
  UtsListRecord,
} from '../../src/sources/situas-internal/index.ts';
import type { SituasPublicSource } from '../../src/sources/situas-public/index.ts';
import { Store } from '../../src/store/index.ts';
import { withTempDir } from './http.ts';
import { decodedRows } from './internal.ts';

/**
 * Interval index of the real snapshots of `dates`. With `codes`, only the rows of those codes are
 * kept: a reduced world, whose non-consecutive dates must not hide changes of the kept codes
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

/** Internal UTS identity from r5 fixtures, as `[code, type, fixture file]`. */
export async function utsIdentity(
  records: readonly [string, UtsListRecord['type'], string][],
  complete = true,
): Promise<InternalIdentity> {
  const sources: IdentitySource<InternalUtsEvent>[] = [];
  for (const [code, type, file] of records) {
    const listed = utsList.find((r) => r.code === code && r.type === type);
    if (listed === undefined) throw new Error(`UTS ${code} (${type}) not listed by r2`);
    sources.push({ listed, events: await decodedRows('utsEvents', `r5-uts-events/${file}`) });
  }
  const graph = buildIdentityGraph<InternalUtsEvent>({
    level: 'province',
    sources,
    pointer: (e) => ({ id: e.utsId, originId: e.originId }),
    record: (e) => ({ id: e.utsId, code: e.code, name: e.name, type: e.type }),
    date: (e) => e.date,
    eventKey: canonicalJson,
    anomalies: new AnomalyCollector(),
  });
  return internalIdentity(graph, complete, (e) => ({ ...e, recordId: e.utsId }), 'r5:uts-events');
}

/** Internal municipality identity from r6 fixtures (file names); never complete. */
export async function municipalityIdentity(files: readonly string[]): Promise<InternalIdentity> {
  const sources: IdentitySource<InternalMunicipalityEvent>[] = [];
  for (const file of files) {
    const events = await decodedRows('municipalityEvents', `r6-municipality-events/${file}`);
    const [first] = events;
    if (first === undefined) throw new Error(`${file} has no events`);
    sources.push({ listed: { code: first.currentCode, name: first.currentName, type: null, originId: null }, events });
  }
  const graph = buildIdentityGraph<InternalMunicipalityEvent>({
    level: 'municipality',
    sources,
    pointer: (e) => ({ id: e.originId, originId: e.originId }),
    record: (e) => ({ id: e.originId, code: e.code, name: e.name, type: null }),
    date: (e) => e.date,
    eventKey: canonicalJson,
    anomalies: new AnomalyCollector(),
  });
  return internalIdentity(graph, false, (e) => ({ ...e, recordId: e.originId }), 'r6:municipality-events');
}
