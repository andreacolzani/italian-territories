import { describe, expect, it } from 'vitest';
import { EndpointDisabledError, ResponseValidationError } from '../../src/http/errors.ts';
import type { MunicipalitySnapshotRow } from '../../src/model/internal.ts';
import {
  EVENT_LISTS,
  REGIME_1927_START,
  REGIME_1948_START,
  snapshotPfun,
  type EventListPfun,
} from '../../src/sources/situas-public/index.ts';
import { json } from '../helpers/http.ts';
import { constant, mapResultset, patchedFixtureTransport, withSources } from '../helpers/sources.ts';

const FULL_RANGE_TO = '2026-10-01';
const OLD_RANGE_TO = '2026-09-30';
const UNIFICATION = '1861-03-17';

function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1;
  return counts;
}

describe('snapshot pfun by regime (§3.2)', () => {
  it('switches on 1927-01-12 and 1948-01-01', () => {
    expect(REGIME_1927_START).toBe('1927-01-12');
    expect(REGIME_1948_START).toBe('1948-01-01');
    expect([snapshotPfun('region', '1861-03-17'), snapshotPfun('region', '1927-01-11')]).toEqual([44, 44]);
    expect([snapshotPfun('region', '1927-01-12'), snapshotPfun('region', '1947-12-31')]).toEqual([46, 46]);
    expect(snapshotPfun('region', '1948-01-01')).toBe(68);
    expect(['1927-01-11', '1927-01-12', '1948-01-01'].map((d) => snapshotPfun('province', d))).toEqual([48, 49, 64]);
    expect(['1927-01-11', '1927-01-12', '1948-01-01'].map((d) => snapshotPfun('municipality', d))).toEqual([
      51, 50, 61,
    ]);
  });
});

describe('fetchSnapshot', () => {
  it('projects regions: compartments before 1948, regions afterwards', async () => {
    await withSources(async ({ situasPublic }) => {
      const before = await situasPublic.fetchSnapshot('region', '1947-12-31');
      expect(before.data.pfun).toBe(46);
      expect(before.data.snapshot.rows).toHaveLength(18);
      expect(before.data.snapshot.rows[0]).toEqual({ code: '01', name: 'Piemonte', type: 'compartment' });

      const after = await situasPublic.fetchSnapshot('region', '1948-01-01');
      expect(after.data.pfun).toBe(68);
      expect(after.data.snapshot).toMatchObject({ level: 'region', date: '1948-01-01' });
      expect(after.data.snapshot.rows).toHaveLength(19);
      expect(after.data.snapshot.rows[0]).toEqual({ code: '01', name: 'Piemonte', type: 'region' });

      const today = await situasPublic.fetchSnapshot('region', '2026-01-01');
      expect(today.data.snapshot.rows).toContainEqual({
        code: '02',
        name: "Valle d'Aosta/Vallée d'Aoste",
        type: 'region',
      });
      expect((await situasPublic.fetchSnapshot('region', '1921-06-01')).data.pfun).toBe(44);
    });
  });

  it('projects UTS before 1948 with type province, no abbreviation and the code as historical code', async () => {
    await withSources(async ({ situasPublic }) => {
      const { data } = await situasPublic.fetchSnapshot('province', '1921-06-01');
      expect(data.pfun).toBe(48);
      expect(data.historicalCodeFallbacks).toBe(0);
      expect(data.snapshot.rows.find((r) => r.code === '801')).toEqual({
        code: '801',
        name: 'Venezia Giulia',
        regionCode: '83',
        type: 'province',
        abbreviation: null,
        historicalCode: '801',
      });
    });
  });

  it('projects UTS from 1948 with type, abbreviation and COD_PROV_STORICO', async () => {
    await withSources(async ({ situasPublic }) => {
      const { data } = await situasPublic.fetchSnapshot('province', '2026-01-01');
      expect(data.pfun).toBe(64);
      expect(data.snapshot.rows).toHaveLength(110);
      expect(data.historicalCodeFallbacks).toBe(0);
      expect(data.snapshot.rows.find((r) => r.code === '318')).toEqual({
        code: '318',
        name: 'Cagliari',
        regionCode: '20',
        type: 'metropolitan_city',
        abbreviation: 'CA',
        historicalCode: '118',
      });
    });
  });

  it('falls back to COD_UTS when SITUAS omits COD_PROV_STORICO, and counts the fallbacks (§3.5)', async () => {
    await withSources(async ({ situasPublic }) => {
      const { data } = await situasPublic.fetchSnapshot('province', '1948-01-01');
      expect(data.snapshot.rows).toHaveLength(92);
      expect(data.historicalCodeFallbacks).toBe(92);
      expect(data.historicalCodeFallbackUtsCodes).toEqual(data.snapshot.rows.map((r) => r.code).sort());
      for (const row of data.snapshot.rows) expect(row.historicalCode).toBe(row.code);
    });
  });

  it('falls back to the row COD_UTS for municipalities, outside the projection', async () => {
    const transport = await patchedFixtureTransport((response, request) =>
      request.url.includes('pfun=61')
        ? mapResultset(response, (rows) =>
            rows.map(({ COD_PROV_STORICO, ...row }) =>
              row.PRO_COM_T === '015146' ? row : { ...row, COD_PROV_STORICO },
            ),
          )
        : response,
    );
    await withSources(
      async ({ situasPublic }) => {
        const { data } = await situasPublic.fetchSnapshot('municipality', '2024-01-22');
        expect(data.historicalCodeFallbacks).toBe(1);
        expect(data.historicalCodeFallbackUtsCodes).toEqual(['215']);
        const milano = data.snapshot.rows.find((r) => r.code === '015146');
        expect(milano).toMatchObject({ utsCode: '215', historicalUtsCode: '215' });
        expect(Object.keys(milano ?? {})).not.toContain('fallback');
      },
      { transport },
    );
  });

  it('projects municipalities by regime', async () => {
    await withSources(async ({ situasPublic }) => {
      const r1921 = (await situasPublic.fetchSnapshot('municipality', '1921-06-01')).data;
      expect(r1921.pfun).toBe(51);
      expect(r1921.snapshot.rows).toHaveLength(9202);
      expect(r1921.snapshot.rows.find((r) => r.code === '801256')).toMatchObject({
        officialName: 'Zara',
        cadastralCode: 'M149',
        utsCode: '801',
        regionCode: '83',
        // Reported as the full name (§3.5 item 12); the override comes later (§6.10).
        utsAbbreviation: 'Venezia Giulia',
        historicalUtsCode: '801',
      });

      const r1927 = (await situasPublic.fetchSnapshot('municipality', '1927-01-12')).data;
      expect(r1927.pfun).toBe(50);

      const r2024 = (await situasPublic.fetchSnapshot('municipality', '2024-01-22')).data;
      expect(r2024.pfun).toBe(61);
      expect(r2024.historicalCodeFallbacks).toBe(0);
      expect(r2024.snapshot.rows.find((r) => r.code === '025075')).toEqual({
        code: '025075',
        officialName: 'Setteville',
        italianName: 'Setteville',
        foreignName: null,
        cadastralCode: 'M437',
        utsCode: '025',
        regionCode: '05',
        utsAbbreviation: 'BL',
        historicalUtsCode: '025',
      } satisfies MunicipalitySnapshotRow);
      expect(r2024.snapshot.rows.find((r) => r.code === '021008')).toMatchObject({
        officialName: 'Bolzano/Bozen',
        italianName: 'Bolzano',
        foreignName: 'Bozen',
      });
    });
  });

  it('golden-1 inclusivity: Setteville appears on 2024-01-22, Quero Vas and Alano di Piave disappear', async () => {
    await withSources(async ({ situasPublic }) => {
      const codes = async (date: string) =>
        new Set((await situasPublic.fetchSnapshot('municipality', date)).data.snapshot.rows.map((r) => r.code));
      const before = await codes('2024-01-21');
      const after = await codes('2024-01-22');
      expect([before.has('025070'), before.has('025002'), before.has('025075')]).toEqual([true, true, false]);
      expect([after.has('025070'), after.has('025002'), after.has('025075')]).toEqual([false, false, true]);
    });
  });

  it('has a municipality code prefix equal to the effective historical UTS code, except 8xx codes (§3.5)', async () => {
    const dates = ['1921-06-01', '1927-01-11', '1927-01-12', '1942-06-01', '2024-01-21', '2024-01-22'];
    const mismatchCounts: Record<string, number> = {};
    await withSources(async ({ situasPublic }) => {
      for (const date of dates) {
        const { rows } = (await situasPublic.fetchSnapshot('municipality', date)).data.snapshot;
        const mismatches = rows.filter((r) => r.code.slice(0, 3) !== r.historicalUtsCode);
        // Codes with suffix ≥ 800 are assigned retroactively to suppressed municipalities: their
        // prefix may be a later or earlier province, never the membership.
        expect(
          mismatches.filter((r) => Number(r.code.slice(3)) < 800).map((r) => r.code),
          date,
        ).toEqual([]);
        mismatchCounts[date] = mismatches.length;
      }
    });
    expect(mismatchCounts).toEqual({
      '1921-06-01': 36,
      '1927-01-11': 41,
      '1927-01-12': 63,
      '1942-06-01': 0,
      '2024-01-21': 0,
      '2024-01-22': 0,
    });
  });

  it('serves snapshots from the cache on the second call', async () => {
    await withSources(async ({ situasPublic, calls }) => {
      await situasPublic.fetchSnapshot('province', '2026-01-01');
      const second = await situasPublic.fetchSnapshot('province', '2026-01-01');
      expect(second.source).toBe('cache');
      expect(second.data.snapshot.rows).toHaveLength(110);
      expect(calls).toHaveLength(1);
    });
  });

  it('rejects a row missing a required field as a permanent validation error', async () => {
    const transport = await patchedFixtureTransport((response) =>
      mapResultset(response, (rows) => rows.map(({ DEN_UTS, ...row }, i) => (i === 3 ? row : { ...row, DEN_UTS }))),
    );
    await withSources(
      async ({ situasPublic }) => {
        await expect(situasPublic.fetchSnapshot('province', '2026-01-01')).rejects.toBeInstanceOf(
          ResponseValidationError,
        );
        await expect(situasPublic.fetchSnapshot('province', '2025-12-31')).rejects.toBeInstanceOf(
          EndpointDisabledError,
        );
      },
      { transport },
    );
  });
});

describe('fetchEventList', () => {
  it('normalises municipality suppressions (98) with REL fields and the scorporo flag', async () => {
    await withSources(async ({ situasPublic }) => {
      const { data } = await situasPublic.fetchEventList('municipality', 98, UNIFICATION, OLD_RANGE_TO);
      expect(data).toHaveLength(3618);
      expect(countBy(data, (r) => r.event)).toEqual({ ES: 3511, AS: 107 });
      expect(data.filter((r) => r.multipleSuccessors)).toHaveLength(361);
      expect(data[0]).toEqual({
        event: 'ES',
        date: '2026-02-21',
        multipleSuccessors: false,
        code: '024027',
        name: 'Castegnero',
        foreignName: null,
        cadastralCode: 'C056',
        utsCode: '024',
        utsAbbreviation: 'VI',
        related: {
          code: '024129',
          name: 'Castegnero Nanto',
          foreignName: null,
          cadastralCode: 'M439',
          utsCode: '024',
          utsAbbreviation: 'VI',
        },
        abroad: false,
        regionChanged: null,
      });
      // golden-9: every cession abroad shares 1947-09-16; Fiume's related territory is a foreign state.
      const cessions = data.filter((r) => r.event === 'AS');
      expect(new Set(cessions.map((r) => r.date))).toEqual(new Set(['1947-09-16']));
      expect(cessions.find((r) => r.code === '701706')).toMatchObject({
        cadastralCode: 'D620',
        related: null,
        abroad: true,
      });
    });
  });

  it('reads the event code of pfun 100 from COD_VARIAZIONE_M', async () => {
    await withSources(async ({ situasPublic }) => {
      const { data } = await situasPublic.fetchEventList('municipality', 100, UNIFICATION, FULL_RANGE_TO);
      expect(data).toHaveLength(4291);
      expect(countBy(data, (r) => r.event)).toEqual({ CS: 2384, AN: 1907 });
      // golden-1: Setteville established on 2024-01-22.
      expect(data.filter((r) => r.code === '025075').map((r) => [r.event, r.date, r.related?.code])).toEqual([
        ['CS', '2024-01-22', '025070'],
        ['CS', '2024-01-22', '025002'],
      ]);
      // A row without any REL field.
      expect(data.find((r) => r.code === '071026' && r.date === '1932-02-12')?.related).toBeNull();
    });
  });

  it('requires COD_VARIAZIONE_M in pfun 100 and never falls back to COD_VARIAZIONE', async () => {
    const transport = await patchedFixtureTransport((response) =>
      mapResultset(response, (rows) =>
        rows.map(({ COD_VARIAZIONE_M, ...row }) => ({ ...row, COD_VARIAZIONE: COD_VARIAZIONE_M })),
      ),
    );
    await withSources(
      async ({ situasPublic }) => {
        await expect(
          situasPublic.fetchEventList('municipality', 100, UNIFICATION, FULL_RANGE_TO),
        ).rejects.toBeInstanceOf(ResponseValidationError);
      },
      { transport },
    );
  });

  it('normalises territorial events (103), renames (104) and code changes (105)', async () => {
    await withSources(async ({ situasPublic }) => {
      const territorial = (await situasPublic.fetchEventList('municipality', 103, UNIFICATION, FULL_RANGE_TO)).data;
      expect(countBy(territorial, (r) => r.event)).toEqual({ CE: 1251, AQ: 1235, AQES: 2285, CECS: 1156 });

      const renames = (await situasPublic.fetchEventList('municipality', 104, UNIFICATION, OLD_RANGE_TO)).data;
      expect(renames).toHaveLength(2765);
      expect(new Set(renames.map((r) => r.event))).toEqual(new Set(['CD']));
      // golden-12: bilingual rename of 2009-01-29.
      expect(renames.find((r) => r.code === '032001' && r.date === '2009-01-29')?.related).toMatchObject({
        name: 'Duino Aurisina-Devin Nabrežina',
        foreignName: 'Devin Nabrežina',
      });

      const changes = (await situasPublic.fetchEventList('municipality', 105, UNIFICATION, OLD_RANGE_TO)).data;
      expect(countBy(changes, (r) => r.event)).toEqual({ AP: 4220, RNAPUTS: 66, RN: 474, CDAP: 1 });
      expect(new Set(changes.map((r) => r.regionChanged))).toEqual(new Set([true, false]));
      // golden-4: Alghero renumbered after the UTS change.
      expect(changes.find((r) => r.code === '090003' && r.event === 'RNAPUTS')).toMatchObject({
        date: '2026-01-01',
        related: { code: '112001', utsCode: '312' },
      });
    });
  });

  it('normalises UTS lists (112, 113, 114) with numeric types and implied renames', async () => {
    await withSources(async ({ situasPublic }) => {
      const suppressed = (await situasPublic.fetchEventList('province', 112, UNIFICATION, FULL_RANGE_TO)).data;
      expect(suppressed).toHaveLength(48);
      expect(suppressed[0]).toEqual({
        event: 'ESCT',
        date: '2026-01-01',
        multipleSuccessors: true,
        code: '090',
        name: 'Sassari',
        type: 'province',
        abbreviation: 'SS',
        related: { code: '113', name: 'Gallura Nord-Est Sardegna', abbreviation: 'OT', type: 'province' },
        abroad: false,
      });
      expect(suppressed.find((r) => r.code === '701')).toMatchObject({ event: 'AS', related: null, abroad: true });

      const established = (await situasPublic.fetchEventList('province', 113, UNIFICATION, FULL_RANGE_TO)).data;
      expect(established.find((r) => r.code === '312')).toMatchObject({
        event: 'CSCT',
        type: 'metropolitan_city',
        related: { code: '090', type: 'province' },
      });

      const renamed = (await situasPublic.fetchEventList('province', 114, UNIFICATION, FULL_RANGE_TO)).data;
      expect(renamed).toHaveLength(31);
      expect(renamed[0]).toEqual({
        event: 'CD',
        date: '2003-07-06',
        multipleSuccessors: false,
        code: '007',
        name: "Valle d'Aosta",
        type: 'province',
        abbreviation: 'AO',
        related: { code: '007', name: "Valle d'Aosta/Vallée d'Aoste", abbreviation: null, type: null },
        abroad: false,
      });
    });
  });

  it('normalises region lists (106, 107, 108)', async () => {
    await withSources(async ({ situasPublic }) => {
      const suppressed = (await situasPublic.fetchEventList('region', 106, UNIFICATION, FULL_RANGE_TO)).data;
      expect(suppressed).toHaveLength(31);
      expect(suppressed[0]).toEqual({
        event: 'ESCT',
        date: '1948-01-01',
        multipleSuccessors: true,
        code: '01',
        name: 'Piemonte',
        type: 'compartment',
        related: { code: '01', name: 'Piemonte', type: 'region' },
        abroad: false,
      });

      const established = (await situasPublic.fetchEventList('region', 107, UNIFICATION, FULL_RANGE_TO)).data;
      expect(countBy(established, (r) => r.event)).toMatchObject({ AN: 4 });

      const renamed = (await situasPublic.fetchEventList('region', 108, UNIFICATION, FULL_RANGE_TO)).data;
      expect(renamed.map((r) => [r.event, r.date, r.name, r.related?.name])).toEqual([
        ['CD', '2003-07-06', "Valle d'Aosta", "Valle d'Aosta/Vallée d'Aoste"],
        ['CD', '1964-01-19', 'Abruzzi e Molise', 'Abruzzo'],
      ]);
    });
  });

  it('turns a foreign state counterpart into abroad, only for AS, AN, CE and AQ (§3.5 item 15)', async () => {
    await withSources(async ({ situasPublic }) => {
      const lists = [
        await situasPublic.fetchEventList('municipality', 98, UNIFICATION, OLD_RANGE_TO),
        await situasPublic.fetchEventList('municipality', 100, UNIFICATION, FULL_RANGE_TO),
        await situasPublic.fetchEventList('municipality', 103, UNIFICATION, FULL_RANGE_TO),
        await situasPublic.fetchEventList('province', 112, UNIFICATION, FULL_RANGE_TO),
        await situasPublic.fetchEventList('province', 113, UNIFICATION, FULL_RANGE_TO),
        await situasPublic.fetchEventList('region', 107, UNIFICATION, FULL_RANGE_TO),
      ].map((result) => result.data as { event: string; abroad: boolean; related: { name: string | null } | null }[]);
      expect(
        lists.map((rows) =>
          countBy(
            rows.filter((r) => r.abroad),
            (r) => r.event,
          ),
        ),
      ).toEqual([{ AS: 107 }, { AN: 1907 }, { CE: 17 }, { AS: 3 }, { AN: 12 }, { AN: 4 }]);
      // The foreign state never survives as a related territory to resolve.
      for (const rows of lists) {
        expect(rows.filter((r) => r.related?.name?.toLowerCase() === 'stato estero')).toEqual([]);
        for (const row of rows.filter((r) => r.abroad)) expect(row.related).toBeNull();
      }
      // golden-18: partial cessions abroad of surviving municipalities on 1947-09-16.
      const [, , territorial = []] = lists;
      const cessionsAbroad = territorial.filter((r) => r.abroad) as unknown as { code: string; date: string }[];
      expect(new Set(cessionsAbroad.map((r) => r.date))).toEqual(new Set(['1947-09-16']));
      expect(cessionsAbroad.map((r) => r.code)).toEqual(expect.arrayContaining(['031007', '032006', '001022']));
    });
  });

  it('rejects a foreign state counterpart for other events or with a code', async () => {
    const row = {
      COD_UTS: '001',
      PRO_COM_T: '001022',
      COMUNE: 'Bardonecchia',
      COD_VARIAZIONE: 'CE',
      DATA_INIZIO_AMMINISTRATIVA: '1947-09-16T00:00:00Z',
      COMUNE_REL: 'Stato estero',
    };
    for (const invalid of [
      { ...row, COD_VARIAZIONE: 'AQES' },
      { ...row, PRO_COM_T_REL: '001999' },
    ]) {
      await withSources(
        async ({ situasPublic }) => {
          await expect(
            situasPublic.fetchEventList('municipality', 103, UNIFICATION, FULL_RANGE_TO),
          ).rejects.toBeInstanceOf(ResponseValidationError);
        },
        { transport: constant(json({ resultset: [invalid] })) },
      );
    }
    await withSources(
      async ({ situasPublic }) => {
        const { data } = await situasPublic.fetchEventList('municipality', 103, UNIFICATION, FULL_RANGE_TO);
        expect(data).toMatchObject([
          { event: 'CE', related: null, abroad: true },
          { event: 'AQ', related: null, abroad: true },
        ]);
      },
      { transport: constant(json({ resultset: [row, { ...row, COD_VARIAZIONE: 'AQ' }] })) },
    );
  });

  it('accepts an empty list', async () => {
    await withSources(
      async ({ situasPublic }) => {
        const result = await situasPublic.fetchEventList('region', 108, '2026-01-01', '2026-01-31');
        expect(result.data).toEqual([]);
      },
      { transport: constant(json({ resultset: [] })) },
    );
  });

  it('rejects unknown codes and codes not allowed for the list (§6.2, D21)', async () => {
    const row = {
      COD_UTS: '024',
      PRO_COM_T: '024027',
      COMUNE: 'Castegnero',
      DATA_INIZIO_AMMINISTRATIVA: '2026-02-21T00:00:00Z',
    };
    for (const code of ['XX', 'CS']) {
      await withSources(
        async ({ situasPublic }) => {
          const error: unknown = await situasPublic
            .fetchEventList('municipality', 98, UNIFICATION, OLD_RANGE_TO)
            .catch((e: unknown) => e);
          expect(error).toBeInstanceOf(ResponseValidationError);
          expect((error as ResponseValidationError).issues[0]?.message).toContain(code);
        },
        { transport: constant(json({ resultset: [{ ...row, COD_VARIAZIONE: code }] })) },
      );
    }
  });

  it('refuses a pfun of another level', async () => {
    await withSources(async ({ situasPublic }) => {
      await expect(
        // @ts-expect-error pfun 112 is a UTS list
        situasPublic.fetchEventList('municipality', 112, UNIFICATION, FULL_RANGE_TO),
      ).rejects.toBeInstanceOf(RangeError);
    });
  });

  it('declares a vocabulary for every list', () => {
    for (const [pfun, list] of Object.entries(EVENT_LISTS)) {
      expect(list.events.length, pfun).toBeGreaterThan(0);
      expect(Number(pfun) as EventListPfun).toBeTypeOf('number');
    }
  });
});

describe('fetchCount', () => {
  it('reads NUM_ROWS (golden-17 counts of the download date)', async () => {
    await withSources(async ({ situasPublic }) => {
      const counts = await Promise.all(
        ([61, 64, 68] as const).map(
          async (pfun) => (await situasPublic.fetchCount(pfun, { date: FULL_RANGE_TO })).data,
        ),
      );
      expect(counts).toEqual([7894, 110, 20]);
    });
  });

  it('accepts zero and rejects anything but one row', async () => {
    await withSources(
      async ({ situasPublic }) => {
        expect((await situasPublic.fetchCount(112, { from: '2026-01-01', to: '2026-01-31' })).data).toBe(0);
      },
      { transport: constant(json({ resultset: [{ NUM_ROWS: 0 }] })) },
    );
    await withSources(
      async ({ situasPublic }) => {
        await expect(situasPublic.fetchCount(61, { date: '2026-01-01' })).rejects.toBeInstanceOf(
          ResponseValidationError,
        );
      },
      { transport: constant(json({ resultset: [{ NUM_ROWS: 1 }, { NUM_ROWS: 2 }] })) },
    );
  });
});
