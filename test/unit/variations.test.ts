/**
 * Variation builder (§4.3, Step 11) on synthetic worlds: event rules (D27), link kinds and dedup,
 * grouping by act and by connected components, effect per event, `indirect` participants,
 * `inferred` variations and unexplained boundaries, I14 accounting.
 */
import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { checkEventRules, eventRule, EVENT_RULES, type InternalVariationEvent } from '../../src/build/index.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { canonicalJson } from '../../src/http/index.ts';
import type { IdentityEvent, InternalIdentity } from '../../src/identity/index.ts';
import { ISTAT_EVENT_CODES, type IstatEventCode, type Level } from '../../src/model/common.ts';
import type {
  MunicipalitySnapshotRow,
  RegionSnapshotRow,
  SnapshotRowByLevel,
  UtsSnapshotRow,
} from '../../src/model/internal.ts';
import { buildIntervalIndex, IntervalIndex } from '../../src/resolve/index.ts';
import type { MunicipalityEventRow } from '../../src/sources/situas-public/index.ts';
import { EVENT_LISTS } from '../../src/sources/situas-public/pfun.ts';
import {
  accountViolations,
  buildVariationWorld,
  variationPropertyViolations,
  type BuiltVariations,
} from '../helpers/variations.ts';
import { entityAt } from '../helpers/versions.ts';

const D1 = '1900-01-01';
const D2 = '1910-01-01';
const D3 = '1920-01-01';

const region = (code: string): RegionSnapshotRow => ({ code, name: `Regione ${code}`, type: 'region' });

function uts(code: string, overrides: Partial<UtsSnapshotRow> = {}): UtsSnapshotRow {
  return {
    code,
    name: `UTS ${code}`,
    regionCode: '01',
    type: 'province',
    abbreviation: 'AA',
    historicalCode: code,
    ...overrides,
  };
}

function municipality(code: string, overrides: Partial<MunicipalitySnapshotRow> = {}): MunicipalitySnapshotRow {
  return {
    code,
    officialName: `Comune ${code}`,
    italianName: `Comune ${code}`,
    foreignName: null,
    cadastralCode: null,
    utsCode: '001',
    regionCode: '01',
    utsAbbreviation: 'AA',
    historicalUtsCode: '001',
    ...overrides,
  };
}

function row(
  event: IstatEventCode,
  date: IsoDate,
  code: string,
  related: string | null = null,
  overrides: Partial<MunicipalityEventRow> = {},
): MunicipalityEventRow {
  return {
    event,
    date,
    multipleSuccessors: false,
    code,
    name: `Comune ${code}`,
    foreignName: null,
    cadastralCode: null,
    utsCode: '001',
    utsAbbreviation: 'AA',
    abroad: false,
    related:
      related === null
        ? null
        : {
            code: related,
            name: `Comune ${related}`,
            foreignName: null,
            cadastralCode: null,
            utsCode: '001',
            utsAbbreviation: 'AA',
          },
    regionChanged: null,
    ...overrides,
  };
}

async function index<L extends Level>(
  level: L,
  snapshots: Record<IsoDate, SnapshotRowByLevel[L][]>,
): Promise<IntervalIndex<L>> {
  return buildIntervalIndex({
    level,
    snapshots: Object.entries(snapshots).map(([date, rows]) => ({
      date,
      rows: rows.map((r) => ({ hash: canonicalJson(r), row: r })),
    })),
    anomalies: new AnomalyCollector(),
  });
}

/** Internal identity of single-record entities, from `[root, code, events]`. */
function identity(records: [number, [IstatEventCode, IsoDate, string][]][]): InternalIdentity {
  return {
    complete: true,
    components: records.map(([root, events]) => ({
      root,
      ids: [root],
      events: events.map(([event, date, code]): IdentityEvent => ({ event, date, code, recordId: root })),
    })),
    aliases: [],
  };
}

function internalEvent(
  root: number,
  event: IstatEventCode,
  date: IsoDate,
  actId: number,
  description: string | null = null,
  code = '',
): InternalVariationEvent {
  return { root, event, date, code, actId, description, details: null };
}

interface SyntheticWorld {
  regions?: Record<IsoDate, RegionSnapshotRow[]>;
  provinces?: Record<IsoDate, UtsSnapshotRow[]>;
  municipalities: Record<IsoDate, MunicipalitySnapshotRow[]>;
  lists?: Partial<Record<98 | 100 | 103 | 104 | 105, MunicipalityEventRow[]>>;
  internal?: { province?: InternalIdentity; municipality?: InternalIdentity };
  internalEvents?: Partial<Record<Level, InternalVariationEvent[]>>;
  inferredDates?: IsoDate[];
}

async function run(world: SyntheticWorld): Promise<BuiltVariations> {
  return buildVariationWorld({
    region: {
      index:
        world.regions === undefined ? new IntervalIndex('region', new Map()) : await index('region', world.regions),
    },
    province: {
      index:
        world.provinces === undefined
          ? new IntervalIndex('province', new Map())
          : await index('province', world.provinces),
      internal: world.internal?.province ?? null,
    },
    municipality: {
      index: await index('municipality', world.municipalities),
      eventLists: world.lists ?? {},
      internal: world.internal?.municipality ?? null,
    },
    internalEvents: world.internalEvents ?? {},
    inferredDates: world.inferredDates ?? [],
  });
}

const codes = (built: BuiltVariations, level?: string) =>
  built.variationAnomalies
    .list(level as never)
    .map((a) => a.code)
    .sort();

describe('event rules (D27)', () => {
  it('cover every event code of every public list', () => {
    for (const { level, events } of Object.values(EVENT_LISTS)) {
      for (const event of events) expect(eventRule(level, event), `${level} ${event}`).toBeDefined();
    }
  });

  it('cover the internal pairs observed on every region and UTS record, CT included', () => {
    const observed: Record<'region' | 'province', IstatEventCode[]> = {
      region: ['PV', 'CS', 'CSCT', 'AN', 'ES', 'AQ', 'CE', 'AQES', 'CECS', 'CD', 'VACST'],
      province: ['PV', 'CS', 'CSCT', 'AN', 'ES', 'ESCT', 'AS', 'AQ', 'CE', 'AQES', 'CECS', 'CD', 'AP', 'RN', 'CT'],
    };
    for (const [level, events] of Object.entries(observed)) {
      for (const event of events) expect(eventRule(level as Level, event), `${level} ${event}`).toBeDefined();
    }
    expect(EVENT_RULES.province.CT?.effect).toBe('attribute');
  });

  it('a pair observed by the build without a rule is blocking', () => {
    const anomalies = new AnomalyCollector();
    checkEventRules({ municipality: { CS: 3, CSCT: 1 }, province: { CT: 2 }, region: { RN: 1 } }, anomalies);
    expect(anomalies.list().map((a) => [a.level, a.code, a.context.level, a.context.event])).toEqual([
      ['blocking', 'event-rule-missing', 'region', 'RN'],
      ['blocking', 'event-rule-missing', 'municipality', 'CSCT'],
    ]);
    const all = new AnomalyCollector();
    checkEventRules({ municipality: Object.fromEntries(ISTAT_EVENT_CODES.map((c) => [c, 1])) }, all);
    expect(all.list().map((a) => a.context.event)).toEqual(['CSCT', 'VACST', 'CT', 'ESCT']);
  });

  it('an internal event without a rule is dropped and blocking', async () => {
    const built = await run({
      municipalities: { [D1]: [municipality('001001')], [D2]: [municipality('001001')] },
      internal: { municipality: identity([[7, [['PV', D1, '001001']]]]) },
      internalEvents: { municipality: [internalEvent(7, 'PV', D1, 373), internalEvent(7, 'ESCT', D2, 9)] },
    });
    expect(built.accounts.map((a) => [a.event, a.dropped])).toEqual([
      ['PV', 'first-validity'],
      ['ESCT', 'rule-missing'],
    ]);
    expect(codes(built, 'blocking')).toEqual(['event-rule-missing']);
    expect(built.variations).toEqual([]);
  });
});

describe('links and roles (§4.3)', async () => {
  // X merges into Y; Z gives territory to Y; W is detached from Y. ISTAT reports every flow from
  // both sides (98/100 and 103).
  const built = await run({
    municipalities: {
      [D1]: [municipality('001001'), municipality('001002'), municipality('001003')],
      [D2]: [municipality('001002'), municipality('001003'), municipality('001004')],
    },
    lists: {
      98: [row('ES', D2, '001001', '001002')],
      100: [row('CS', D2, '001004', '001002')],
      103: [
        row('AQES', D2, '001002', '001001'),
        row('CE', D2, '001003', '001002'),
        row('AQ', D2, '001002', '001003'),
        row('CECS', D2, '001002', '001004'),
      ],
    },
  });
  const id = (code: string, date: IsoDate) => entityAt(built.entities.municipality, code, date).id;
  const [x, y, z, w] = [id('001001', D1), id('001002', D2), id('001003', D2), id('001004', D2)];

  it('derives the link kind from the effect, once per pair', () => {
    expect(built.variations).toHaveLength(1);
    const [variation] = built.variations;
    expect(variation?.links.map((l) => [l.from, l.to, l.kind])).toEqual(
      [
        [x, y, 'merged_into'],
        [z, y, 'transferred_to'],
        [y, w, 'detached_into'],
      ].sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number)),
    );
  });

  it('derives roles from the versions each event closes or opens', () => {
    const [variation] = built.variations;
    expect(variation?.participants.map((p) => [p.entityId, p.istatEvents, p.role, p.abroad])).toEqual(
      [
        [x, ['ES'], 'suppressed', false],
        [y, ['AQ', 'AQES', 'CECS'], 'territory_changed', false],
        [z, ['CE'], 'territory_changed', false],
        [w, ['CS'], 'established', false],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
    expect(variation?.istatActId).toBeNull();
    expect(variationPropertyViolations(built)).toEqual([]);
    expect(accountViolations(built)).toEqual([]);
    expect(codes(built)).toEqual([]);
  });

  it('a cession abroad is a role without link', async () => {
    const ceded = await run({
      municipalities: { [D1]: [municipality('001001'), municipality('001002')], [D2]: [municipality('001002')] },
      lists: { 98: [row('AS', D2, '001001', null, { abroad: true })] },
    });
    expect(ceded.variations.map((v) => [v.participants.map((p) => [p.role, p.abroad]), v.links])).toEqual([
      [[['ceded', true]], []],
    ]);
  });
});

describe('grouping (§4.3)', () => {
  it('rows without act id: one variation per connected component of the day', async () => {
    const built = await run({
      municipalities: {
        [D1]: ['001001', '001002', '001003', '001004'].map((c) => municipality(c)),
        [D2]: [municipality('001002'), municipality('001004')],
      },
      lists: { 98: [row('ES', D2, '001001', '001002'), row('ES', D2, '001003', '001004')] },
    });
    const id = (code: string) => entityAt(built.entities.municipality, code, D1).id;
    expect(built.variations.map((v) => v.participants.map((p) => p.entityId))).toEqual([
      [id('001001')],
      [id('001003')],
    ]);
    expect(
      built.variations.map((v) =>
        built.registry.get('variation', `nk:${D2}:municipality:${v.participants[0]?.entityId}`),
      ),
    ).toEqual(built.variations.map((v) => v.id));
  });

  it('one variation per act across levels; public rows take the act id and description of their event', async () => {
    const built = await run({
      regions: { [D1]: [region('01')], [D2]: [region('01')] },
      provinces: { [D1]: [uts('001')], [D2]: [uts('001', { name: 'UTS nuova' })] },
      municipalities: { [D1]: [municipality('001001')], [D2]: [municipality('001001', { officialName: 'Nuovo' })] },
      lists: { 104: [row('CD', D2, '001001', '001001')] },
      internal: {
        province: identity([
          [
            5,
            [
              ['PV', D1, '001'],
              ['CD', D2, '001'],
            ],
          ],
        ]),
        municipality: identity([[77, [['CD', D2, '001001']]]]),
      },
      internalEvents: {
        province: [internalEvent(5, 'PV', D1, 373), internalEvent(5, 'CD', D2, 9, 'RINOMINE')],
        municipality: [internalEvent(77, 'CD', D2, 9, 'RINOMINE')],
      },
    });
    expect(built.variations).toHaveLength(1);
    const [variation] = built.variations;
    expect(variation).toMatchObject({ date: D2, istatActId: 9, description: 'RINOMINE', origin: 'istat' });
    expect(variation?.participants.map((p) => [p.level, p.istatEvents, p.role])).toEqual([
      ['province', ['CD'], 'changed'],
      ['municipality', ['CD'], 'changed'],
    ]);
    expect(built.registry.get('variation', `act:9:${D2}`)).toBe(variation?.id);
    expect(built.accounts.filter((a) => a.variation !== null).map((a) => a.source)).toEqual([
      'events:pfun-104',
      'r5:uts-events',
      'r6:municipality-events',
    ]);
  });
});

describe('effect per event (§4.3)', () => {
  it('drops a same-day code change of a suppressed municipality; the participant keeps its suppression', async () => {
    const built = await run({
      municipalities: { [D1]: [municipality('001001'), municipality('001002')], [D2]: [municipality('001002')] },
      lists: { 98: [row('ES', D2, '001009', '001002')], 105: [row('AP', D2, '001001', '001009')] },
    });
    const x = entityAt(built.entities.municipality, '001001', D1).id;
    expect(built.variations.map((v) => v.participants.map((p) => [p.entityId, p.istatEvents, p.role]))).toEqual([
      [[x, ['ES'], 'suppressed']],
    ]);
    expect(built.accounts.map((a) => [a.source, a.event, a.dropped])).toEqual([
      ['events:pfun-105', 'AP', 'no-effect'],
      ['events:pfun-98', 'ES', null],
    ]);
    expect(built.variationAnomalies.list().map((a) => [a.level, a.code])).toEqual([
      ['info', 'participation-without-effect'],
    ]);
  });

  /** 001001 is renamed (act 1) and gives territory to 001002 (act 2 or `cessionAct`) on D2. */
  async function renameAndCession(cessionAct: number) {
    const built = await run({
      municipalities: {
        [D1]: [municipality('001001'), municipality('001002')],
        [D2]: [municipality('001001', { officialName: 'Nuovo', italianName: 'Nuovo' }), municipality('001002')],
      },
      lists: {
        103: [row('CE', D2, '001001', '001002'), row('AQ', D2, '001002', '001001')],
        104: [row('CD', D2, '001001', '001001')],
      },
      internal: {
        municipality: identity([
          [7, [['CD', D2, '001001']]],
          [8, [['AQ', D2, '001002']]],
        ]),
      },
      internalEvents: {
        municipality: [
          internalEvent(7, 'CD', D2, 1, 'RINOMINA'),
          internalEvent(7, 'CE', D2, cessionAct, 'CESSIONE'),
          internalEvent(8, 'AQ', D2, cessionAct, 'CESSIONE'),
        ],
      },
    });
    return { built, x: entityAt(built.entities.municipality, '001001', D2) };
  }

  it('a territorial event of another act does not claim a boundary another event explains', async () => {
    const { built, x } = await renameAndCession(2);
    const participants = built.variations.map((v) => [
      v.istatActId,
      v.participants
        .filter((p) => p.entityId === x.id)
        .map((p) => [p.istatEvents, p.role, p.versionBeforeId, p.versionAfterId]),
    ]);
    expect(participants).toEqual([
      [1, [[['CD'], 'changed', x.versions[0]?.id, x.versions[1]?.id]]],
      [2, [[['CE'], 'territory_changed', null, null]]],
    ]);
    expect(variationPropertyViolations(built)).toEqual([]);
    expect(codes(built)).toEqual([]);
  });

  it('in the same act, the rename and the cession make one changed participant', async () => {
    const { built, x } = await renameAndCession(1);
    expect(built.variations).toHaveLength(1);
    expect(built.variations[0]?.participants.find((p) => p.entityId === x.id)).toMatchObject({
      istatEvents: ['CD', 'CE'],
      role: 'changed',
      versionBeforeId: x.versions[0]?.id,
      versionAfterId: x.versions[1]?.id,
    });
  });

  it('a territorial event carried with a change of the entity claims its versions', async () => {
    const built = await run({
      municipalities: {
        [D1]: [municipality('001001'), municipality('001002')],
        [D2]: [municipality('001001', { cadastralCode: 'A001' }), municipality('001002')],
      },
      lists: { 103: [row('AQ', D2, '001001', '001002'), row('CE', D2, '001002', '001001')] },
    });
    const x = entityAt(built.entities.municipality, '001001', D2);
    expect(built.variations[0]?.participants.find((p) => p.entityId === x.id)).toMatchObject({
      istatEvents: ['AQ'],
      role: 'changed',
      versionBeforeId: x.versions[0]?.id,
      versionAfterId: x.versions[1]?.id,
    });
    expect(variationPropertyViolations(built)).toEqual([]);
  });
});

describe('version boundaries without own events (I9)', () => {
  const regions = { [D1]: [region('01'), region('02')], [D2]: [region('01'), region('02')] };

  it('a change of parent becomes an indirect participant of the variation of the parent', async () => {
    const built = await run({
      regions,
      provinces: { [D1]: [uts('001')], [D2]: [uts('001', { regionCode: '02' })] },
      municipalities: { [D1]: [municipality('001001')], [D2]: [municipality('001001', { regionCode: '02' })] },
      internal: {
        province: identity([
          [
            5,
            [
              ['PV', D1, '001'],
              ['AP', D2, '001'],
            ],
          ],
        ]),
      },
      internalEvents: { province: [internalEvent(5, 'AP', D2, 11)] },
    });
    const m = entityAt(built.entities.municipality, '001001', D2);
    expect(built.variations).toHaveLength(1);
    expect(built.variations[0]?.participants).toEqual([
      expect.objectContaining({ level: 'province', istatEvents: ['AP'], role: 'changed' }),
      {
        level: 'municipality',
        entityId: m.id,
        istatEvents: [],
        abroad: false,
        role: 'indirect',
        versionBeforeId: m.versions[0]?.id,
        versionAfterId: m.versions[1]?.id,
      },
    ]);
    expect(variationPropertyViolations(built)).toEqual([]);
    expect(codes(built)).toEqual([]);
  });

  it('a rename without event (warned upstream) gets an inferred variation', async () => {
    const built = await run({
      municipalities: {
        [D1]: [municipality('001001')],
        [D2]: [municipality('001001', { officialName: 'Altro', italianName: 'Altro' })],
      },
    });
    const m = entityAt(built.entities.municipality, '001001', D2);
    expect(built.variations.map((v) => ({ ...v, id: 0 }))).toEqual([
      {
        id: 0,
        date: D2,
        istatActId: null,
        origin: 'inferred',
        description: null,
        participants: [expect.objectContaining({ entityId: m.id, role: 'indirect', istatEvents: [] })],
        links: [],
      },
    ]);
    expect(built.registry.get('variation', `inferred:${D2}:municipality:${m.id}`)).toBe(built.variations[0]?.id);
    expect(codes(built)).toEqual([]);
  });

  it('cadastral continuity (warned upstream) gets an inferred variation', async () => {
    const built = await run({
      municipalities: {
        [D1]: [municipality('001001', { cadastralCode: 'A001' })],
        [D2]: [municipality('001009', { cadastralCode: 'A001' })],
      },
    });
    expect(built.variations.map((v) => [v.origin, v.participants.map((p) => p.role)])).toEqual([
      ['inferred', ['indirect']],
    ]);
  });

  it('a change on an inferred breakpoint gets an inferred variation; elsewhere it is blocking', async () => {
    const world = (inferredDates: IsoDate[]): SyntheticWorld => ({
      municipalities: {
        [D1]: [municipality('001001')],
        [D2]: [municipality('001001', { cadastralCode: 'A001' })],
        [D3]: [municipality('001001', { cadastralCode: 'A002' })],
      },
      inferredDates,
    });
    const inferred = await run(world([D2, D3]));
    expect(inferred.variations.map((v) => [v.date, v.origin])).toEqual([
      [D2, 'inferred'],
      [D3, 'inferred'],
    ]);
    const unexplained = await run(world([D2]));
    expect(unexplained.variations.map((v) => v.date)).toEqual([D2]);
    expect(unexplained.variationAnomalies.list().map((a) => [a.level, a.code, a.context.date])).toEqual([
      ['blocking', 'version-boundary-unexplained', D3],
    ]);
  });

  it('an abbreviation change without an event is a warning with an inferred variation (FO → FC, 1999)', async () => {
    const province = identity([[5, [['PV', D1, '001']]]]);
    const built = await run({
      regions,
      provinces: { [D1]: [uts('001', { abbreviation: 'FO' })], [D2]: [uts('001', { abbreviation: 'FC' })] },
      municipalities: { [D1]: [municipality('001001')], [D2]: [municipality('001001')] },
      internal: { province },
    });
    const p = entityAt(built.entities.province, '001', D2);
    expect(p.versions.map((v) => v.abbreviation)).toEqual(['FO', 'FC']);
    expect(built.variations.map((v) => [v.date, v.origin, v.participants.map((x) => [x.entityId, x.role])])).toEqual([
      [D2, 'inferred', [[p.id, 'indirect']]],
    ]);
    expect(built.variationAnomalies.list().map((a) => [a.level, a.code, a.context.from, a.context.to])).toEqual([
      ['warning', 'abbreviation-change-without-event', 'FO', 'FC'],
    ]);
    expect(variationPropertyViolations(built)).toEqual([]);
  });

  it('an abbreviation change together with another field is not covered by the rule', async () => {
    const built = await run({
      regions,
      provinces: {
        [D1]: [uts('001', { abbreviation: 'FO' })],
        [D2]: [uts('001', { abbreviation: 'FC', name: 'Altra' })],
      },
      municipalities: { [D1]: [municipality('001001')], [D2]: [municipality('001001')] },
      internal: { province: identity([[5, [['PV', D1, '001']]]]) },
    });
    expect(codes(built)).not.toContain('abbreviation-change-without-event');
  });

  it('a municipality appearing without an establishment is blocking', async () => {
    const built = await run({
      municipalities: { [D1]: [municipality('001001')], [D2]: [municipality('001001'), municipality('001002')] },
    });
    expect(built.variationAnomalies.list().map((a) => [a.level, a.code, a.context.side])).toEqual([
      ['blocking', 'version-boundary-unexplained', 'opened'],
    ]);
  });
});
