import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import { canonicalJson } from '../../src/http/index.ts';
import {
  ENTITY_ANOMALIES,
  matchTransitions,
  resolveEntities,
  subjectSide,
  TRANSITION_ANOMALIES,
  type IdentityEvent,
  type InternalIdentity,
  type TransitionEvent,
} from '../../src/identity/index.ts';
import type { IstatEventCode, Level } from '../../src/model/common.ts';
import type { MunicipalitySnapshotRow, RegionSnapshotRow, SnapshotRowByLevel } from '../../src/model/internal.ts';
import { buildIntervalIndex, CodeResolver, type CodeAlias } from '../../src/resolve/index.ts';

const D1 = '1900-01-01';
const D2 = '1910-01-01';
const D3 = '1920-01-01';

function municipality(code: string, name: string, cadastralCode: string | null = null): MunicipalitySnapshotRow {
  return {
    code,
    officialName: name,
    italianName: name,
    foreignName: null,
    cadastralCode,
    utsCode: '001',
    regionCode: '01',
    utsAbbreviation: 'TO',
    historicalUtsCode: '001',
  };
}

function region(code: string, name: string): RegionSnapshotRow {
  return { code, name, type: 'region' };
}

function event(code: IstatEventCode, date: IsoDate, istatCode: string, cadastralCode: string | null = null) {
  return {
    event: code,
    date,
    code: istatCode,
    side: subjectSide(code),
    cadastralCode,
    source: 'test',
  } satisfies TransitionEvent;
}

function alias(date: IsoDate, from: string, to: string, level: Level = 'municipality'): CodeAlias {
  return { level, date, from, to, source: 'test' };
}

interface World<L extends Level> {
  level: L;
  snapshots: Record<IsoDate, SnapshotRowByLevel[L][]>;
  events?: TransitionEvent[];
  aliases?: CodeAlias[];
  crossCheck?: TransitionEvent[];
  internal?: InternalIdentity | null;
}

async function run<L extends Level>(world: World<L>) {
  const anomalies = new AnomalyCollector();
  const index = await buildIntervalIndex({
    level: world.level,
    snapshots: Object.entries(world.snapshots).map(([date, rows]) => ({
      date,
      rows: rows.map((row) => ({ hash: canonicalJson(row), row })),
    })),
    anomalies,
  });
  const aliases = world.aliases ?? [];
  const resolver = new CodeResolver({ [world.level]: index }, aliases);
  const transitions = matchTransitions({
    level: world.level,
    index,
    resolver,
    events: world.events ?? [],
    aliases,
    crossCheck: world.crossCheck ?? [],
    anomalies,
  });
  const entities = resolveEntities({ transitions, resolver, internal: world.internal ?? null, anomalies });
  const chains = transitions.chains.map((c) => c.map((i) => `${i.code}@${i.validFrom}`));
  const codes = anomalies.list().map((a) => `${a.level}:${a.code}`);
  const matcherCodes = Object.values(TRANSITION_ANOMALIES) as string[];
  /** Anomalies of the matcher only (not of the origin ids). */
  const transitionCodes = codes.filter((c) => matcherCodes.includes(c.slice(c.indexOf(':') + 1)));
  return { transitions, entities, chains, anomalies, codes, transitionCodes };
}

function identity(
  components: { root: number; ids?: number[]; events: [IstatEventCode, IsoDate, string][] }[],
  complete = true,
): InternalIdentity {
  return {
    complete,
    aliases: [],
    components: components.map((c) => ({
      root: c.root,
      ids: c.ids ?? [c.root],
      events: c.events.map(([e, date, code]): IdentityEvent => ({ event: e, date, code, recordId: c.root })),
    })),
  };
}

describe('transition matcher (§6.7)', () => {
  it('links the same code across a change of its row; a rename needs a CD event', async () => {
    const snapshots = { [D1]: [municipality('001001', 'Alpha')], [D2]: [municipality('001001', 'Beta')] };
    const renamed = await run({ level: 'municipality', snapshots, events: [event('CD', D2, '001001')] });
    expect(renamed.chains).toEqual([['001001@1900-01-01', '001001@1910-01-01']]);
    expect(renamed.codes).toEqual([]);

    const silent = await run({ level: 'municipality', snapshots });
    expect(silent.chains).toEqual([['001001@1900-01-01', '001001@1910-01-01']]);
    expect(silent.codes).toEqual([`warning:${TRANSITION_ANOMALIES.nameChange}`]);
  });

  it('does not link a code suppressed and established again on the same day (code reuse)', async () => {
    const {
      chains,
      transitionCodes: codes,
      transitions,
    } = await run({
      level: 'municipality',
      snapshots: { [D1]: [municipality('001001', 'Alpha')], [D2]: [municipality('001001', 'Beta')] },
      events: [event('ES', D2, '001001'), event('CS', D2, '001001')],
    });
    expect(chains).toEqual([['001001@1900-01-01'], ['001001@1910-01-01']]);
    expect(codes).toEqual([]);
    expect(transitions.ends.get('001001@1900-01-01')).toEqual(['ES']);
    expect(transitions.starts.get('001001@1910-01-01')).toEqual(['CS']);
  });

  it('links a code change and prefers it to code equality (two codes swapped)', async () => {
    const changed = await run({
      level: 'municipality',
      snapshots: { [D1]: [municipality('001001', 'Alpha')], [D2]: [municipality('002001', 'Alpha')] },
      aliases: [alias(D2, '001001', '002001')],
    });
    expect(changed.chains).toEqual([['001001@1900-01-01', '002001@1910-01-01']]);
    expect(changed.transitions.links[0]?.rule).toBe('code-change');

    const swapped = await run({
      level: 'municipality',
      snapshots: {
        [D1]: [municipality('001001', 'Alpha'), municipality('001002', 'Beta')],
        [D2]: [municipality('001001', 'Beta'), municipality('001002', 'Alpha')],
      },
      aliases: [alias(D2, '001001', '001002'), alias(D2, '001002', '001001')],
    });
    expect(swapped.chains).toEqual([
      ['001001@1900-01-01', '001002@1910-01-01'],
      ['001002@1900-01-01', '001001@1910-01-01'],
    ]);
    expect(swapped.codes).toEqual([]);
  });

  it('reports intervals without continuity or events as blocking', async () => {
    const { codes, anomalies } = await run({
      level: 'municipality',
      snapshots: { [D1]: [municipality('001001', 'Alpha')], [D2]: [municipality('001002', 'Beta')] },
    });
    expect(codes).toEqual([
      `blocking:${TRANSITION_ANOMALIES.unexplained}`,
      `blocking:${TRANSITION_ANOMALIES.unexplained}`,
    ]);
    expect(anomalies.list().map((a) => [a.context.interval, a.context.side])).toEqual([
      ['001001@1900-01-01', 'closed'],
      ['001002@1910-01-01', 'opened'],
    ]);
  });

  it('accepts suppressions and establishments as explanations, through the side rule', async () => {
    const { chains, transitionCodes: codes } = await run({
      level: 'municipality',
      snapshots: { [D1]: [municipality('001001', 'Alpha')], [D2]: [municipality('001002', 'Beta')] },
      events: [event('ES', D2, '001001'), event('CS', D2, '001002')],
    });
    expect(chains).toEqual([['001001@1900-01-01'], ['001002@1910-01-01']]);
    expect(codes).toEqual([]);
  });

  it('infers continuity from an unchanged cadastral code without events (warning)', async () => {
    const { chains, codes, transitions } = await run({
      level: 'municipality',
      snapshots: { [D1]: [municipality('001001', 'Alpha', 'A001')], [D2]: [municipality('001099', 'Alpha', 'A001')] },
    });
    expect(chains).toEqual([['001001@1900-01-01', '001099@1910-01-01']]);
    expect(transitions.links[0]?.rule).toBe('cadastral');
    expect(codes).toEqual([`warning:${TRANSITION_ANOMALIES.cadastral}`]);
  });

  it('never infers cadastral continuity for UTS and regions', async () => {
    const { codes } = await run({
      level: 'region',
      snapshots: { [D1]: [region('01', 'Alpha')], [D2]: [region('02', 'Alpha')] },
      internal: identity([]),
    });
    expect(codes.filter((c) => c.endsWith(TRANSITION_ANOMALIES.unexplained))).toHaveLength(2);
  });

  it('drops every link of an interval with two successors (blocking)', async () => {
    const { chains, codes } = await run({
      level: 'municipality',
      snapshots: {
        [D1]: [municipality('001001', 'Alpha')],
        [D2]: [municipality('002001', 'Alpha'), municipality('002002', 'Alpha')],
      },
      aliases: [alias(D2, '001001', '002001'), alias(D2, '001001', '002002')],
    });
    expect(chains).toEqual([['001001@1900-01-01'], ['002001@1910-01-01'], ['002002@1910-01-01']]);
    expect(codes).toContain(`blocking:${TRANSITION_ANOMALIES.conflict}`);
    expect(codes.filter((c) => c.endsWith(TRANSITION_ANOMALIES.unexplained))).toHaveLength(3);
  });

  it('cross-checks public suppressions and establishments against the internal explanations', async () => {
    const { codes, anomalies } = await run({
      level: 'region',
      snapshots: { [D1]: [region('01', 'Alpha')], [D2]: [region('02', 'Beta')] },
      internal: identity([
        { root: 1, events: [['ES', D2, '01']] },
        { root: 2, events: [['CS', D2, '02']] },
      ]),
      events: [event('ES', D2, '01'), event('CS', D2, '02')],
      crossCheck: [event('ES', D2, '01'), event('CS', D3, '02')],
    });
    expect(codes).toEqual([`warning:${TRANSITION_ANOMALIES.publicEventUnmatched}`]);
    expect(anomalies.list()[0]?.context).toMatchObject({ event: 'CS', date: D3, code: '02' });
  });
});

describe('entities with ISTAT origin ids (§5.2)', () => {
  it('joins chains of one origin id across a documented suppression and reconstitution', async () => {
    const { entities, codes } = await run({
      level: 'municipality',
      snapshots: { [D1]: [municipality('001001', 'Alpha')], [D2]: [], [D3]: [municipality('001001', 'Alpha')] },
      events: [event('ES', D2, '001001'), event('CS', D3, '001001')],
      internal: identity(
        [
          {
            root: 7,
            events: [
              ['ES', D2, '001001'],
              ['CS', D3, '001001'],
            ],
          },
        ],
        false,
      ),
    });
    expect(entities.map((e) => [e.key, e.intervals.map((i) => i.validFrom)])).toEqual([['istat:7', [D1, D3]]]);
    expect(codes).toEqual([]);
  });

  it('cuts a chain where the origin id changes (warning)', async () => {
    const { entities, codes } = await run({
      level: 'municipality',
      snapshots: { [D1]: [municipality('001001', 'Alpha')], [D2]: [municipality('001001', 'Beta')] },
      events: [event('CD', D2, '001001')],
      internal: identity(
        [
          { root: 1, events: [['PV', D1, '001001']] },
          { root: 2, events: [['CD', D2, '001001']] },
        ],
        false,
      ),
    });
    expect(entities.map((e) => [e.key, e.intervals.map((i) => i.validFrom)])).toEqual([
      ['istat:1', [D1]],
      ['istat:2', [D2]],
    ]);
    expect(codes).toEqual([`warning:${ENTITY_ANOMALIES.mismatch}`]);
  });

  it('blocks when intervals without events lie between two origin ids', async () => {
    const { entities, codes } = await run({
      level: 'municipality',
      snapshots: {
        [D1]: [municipality('001001', 'Alpha')],
        [D2]: [municipality('001001', 'Beta')],
        [D3]: [municipality('001001', 'Gamma')],
      },
      events: [event('CD', D2, '001001'), event('CD', D3, '001001')],
      internal: identity(
        [
          { root: 1, events: [['PV', D1, '001001']] },
          { root: 2, events: [['CD', D3, '001001']] },
        ],
        false,
      ),
    });
    expect(codes).toEqual([`blocking:${ENTITY_ANOMALIES.splitUndetermined}`]);
    expect(entities.map((e) => [e.key, e.intervals.map((i) => i.validFrom)])).toEqual([
      ['istat:1', [D1, D2]],
      ['istat:2', [D3]],
    ]);
  });

  it('warns when chains of one origin id are separate without suppression and reconstitution', async () => {
    const { entities, codes } = await run({
      level: 'municipality',
      snapshots: {
        [D1]: [municipality('001001', 'Alpha')],
        [D2]: [municipality('001001', 'Beta')],
        [D3]: [municipality('001001', 'Gamma')],
      },
      events: [event('CD', D2, '001001'), event('CD', D3, '001001')],
      internal: identity(
        [
          {
            root: 1,
            events: [
              ['PV', D1, '001001'],
              ['CD', D3, '001001'],
            ],
          },
          { root: 2, events: [['CD', D2, '001001']] },
        ],
        false,
      ),
    });
    expect(entities.map((e) => [e.key, e.intervals.map((i) => i.validFrom)])).toEqual([
      ['istat:1', [D1, D3]],
      ['istat:2', [D2]],
    ]);
    expect(codes).toEqual([
      `warning:${ENTITY_ANOMALIES.mismatch}`,
      `warning:${ENTITY_ANOMALIES.mismatch}`,
      `warning:${ENTITY_ANOMALIES.mismatch}`,
    ]);
  });

  it('blocks chains of one origin id that overlap, and intervals claimed by two origin ids', async () => {
    const overlap = await run({
      level: 'municipality',
      snapshots: { [D1]: [municipality('001001', 'Alpha'), municipality('001002', 'Beta')] },
      internal: identity(
        [
          {
            root: 1,
            events: [
              ['PV', D1, '001001'],
              ['PV', D1, '001002'],
            ],
          },
        ],
        false,
      ),
    });
    expect(overlap.codes).toEqual([`blocking:${ENTITY_ANOMALIES.overlap}`]);

    const conflict = await run({
      level: 'municipality',
      snapshots: { [D1]: [municipality('001001', 'Alpha')] },
      internal: identity(
        [
          { root: 1, events: [['PV', D1, '001001']] },
          { root: 2, events: [['PV', D1, '001001']] },
        ],
        false,
      ),
    });
    expect(conflict.codes).toContain(`blocking:${ENTITY_ANOMALIES.originConflict}`);
  });

  it('keeps the UTS members of the component and the natural keys of §5.3', async () => {
    const { entities } = await run({
      level: 'province',
      snapshots: {
        [D1]: [
          {
            code: '015',
            name: 'Milano',
            regionCode: '03',
            type: 'province',
            abbreviation: 'MI',
            historicalCode: '015',
          },
        ],
      },
      internal: identity([{ root: 9, ids: [9, 119], events: [['PV', D1, '015']] }]),
    });
    expect(entities).toEqual([
      expect.objectContaining({
        key: 'istat:9',
        fallbackKey: 'nk:province:015:1900-01-01',
        istatOriginId: 9,
        members: [9, 119],
      }),
    ]);
  });

  describe('entities without an origin id', () => {
    const regionWorld = (complete: boolean) =>
      run({ level: 'region', snapshots: { [D1]: [region('01', 'Alpha')] }, internal: identity([], complete) });

    it('regions and UTS always block', async () => {
      expect((await regionWorld(true)).codes).toEqual([`blocking:${ENTITY_ANOMALIES.originMissing}`]);
      expect((await regionWorld(false)).codes).toEqual([`blocking:${ENTITY_ANOMALIES.internalDataRequired}`]);
      expect((await regionWorld(false)).entities[0]?.key).toBe('nk:region:01:1900-01-01');
    });

    it('municipalities: warning with complete internal data, blocking only for establishments without it', async () => {
      const snapshots = {
        [D1]: [municipality('001001', 'Alpha')],
        [D2]: [municipality('001001', 'Alpha'), municipality('001002', 'Beta')],
      };
      const events = [event('CS', D2, '001002')];
      const complete = await run({ level: 'municipality', snapshots, events, internal: identity([], true) });
      expect(complete.codes).toEqual([
        `warning:${ENTITY_ANOMALIES.originMissing}`,
        `warning:${ENTITY_ANOMALIES.originMissing}`,
      ]);
      const missing = await run({ level: 'municipality', snapshots, events, internal: null });
      expect(missing.anomalies.list().map((a) => [a.level, a.code, a.context.intervals])).toEqual([
        ['blocking', ENTITY_ANOMALIES.internalDataRequired, ['001002@1910-01-01']],
      ]);
    });
  });
});
