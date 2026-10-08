/**
 * Versions on real SITUAS fixtures (§4.2, §6.9, Step 10): golden 2, 3, 5, 10, 11, 12, 15, 16, plus
 * the pre-1948 abbreviations of the full 1921 world.
 *
 * Worlds of non-consecutive dates are reduced to a few codes per level (`snapshotIndex`), so the
 * changes of the other territories in between do not enter the test. Their identity anomalies
 * (rootless entities without internal data, transitions of the reduced world) are Step 9's
 * subject: these tests only look at the anomalies of the version builder.
 */
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../src/dates/index.ts';
import type { InternalIdentity } from '../../src/identity/index.ts';
import type { Level } from '../../src/model/common.ts';
import type { EntityByLevel } from '../../src/model/internal.ts';
import { municipalityIdentity, piemonteIdentity, snapshotIndex, utsIdentity } from '../helpers/identity.ts';
import { withSources } from '../helpers/sources.ts';
import { buildWorld, entityAt, versionPropertyViolations, type BuiltWorld } from '../helpers/versions.ts';

/** Versions as `[validFrom, validTo, code, official name]`. */
function spans(entity: EntityByLevel[Level]): [IsoDate, IsoDate | null, string, string][] {
  return entity.versions.map((v) => [v.validFrom, v.validTo, v.istatCode, v.officialName]);
}

/**
 * Messages of the parent anomalies of the version builder. Reduced worlds keep few
 * municipalities, so the pre-1948 abbreviations of their UTS may be underived there: only full
 * worlds expect no builder anomaly at all.
 */
function parentAnomalies(built: BuiltWorld): string[] {
  return built.anomalies
    .list()
    .filter((a) => a.code === 'version-parent-unresolved')
    .map((a) => a.message);
}

function expectWellFormed(built: BuiltWorld): void {
  for (const level of ['region', 'province', 'municipality'] as const satisfies readonly Level[]) {
    const intervals = built.intervals[level];
    expect(versionPropertyViolations(built[level], (id) => intervals.get(id) ?? [])).toEqual([]);
  }
}

const lists = await withSources(async ({ situasPublic }) => {
  const list = async <L extends Level>(level: L, pfun: number, from: IsoDate, to: IsoDate) =>
    (await situasPublic.fetchEventList(level, pfun as never, from, to)).data;
  return {
    municipality: {
      98: await list('municipality', 98, '1861-03-17', '2026-09-30'),
      100: await list('municipality', 100, '1861-03-17', '2026-10-01'),
      104: await list('municipality', 104, '1861-03-17', '2026-09-30'),
      105: await list('municipality', 105, '1861-03-17', '2026-09-30'),
    },
    province: {
      112: await list('province', 112, '1861-03-17', '2026-10-01'),
      113: await list('province', 113, '1861-03-17', '2026-10-01'),
      114: await list('province', 114, '1861-03-17', '2026-10-01'),
    },
    region: {
      106: await list('region', 106, '1861-03-17', '2026-10-01'),
      107: await list('region', 107, '1861-03-17', '2026-10-01'),
      108: await list('region', 108, '1861-03-17', '2026-10-01'),
    },
  };
});

/** A world of the given dates, each level reduced to `codes` (every row without; no municipalities with `false`). */
async function world(
  dates: readonly IsoDate[],
  codes: { region?: string[]; province?: string[]; municipality?: string[] | false },
  internal: Partial<Record<Level, InternalIdentity>> = {},
): Promise<BuiltWorld> {
  const indexes = await withSources(async ({ situasPublic }) => ({
    region: await snapshotIndex(situasPublic, 'region', dates, codes.region),
    province: await snapshotIndex(situasPublic, 'province', dates, codes.province),
    municipality:
      codes.municipality === false
        ? undefined
        : await snapshotIndex(situasPublic, 'municipality', dates, codes.municipality),
  }));
  return buildWorld({
    region: { index: indexes.region, internal: internal.region ?? null, eventLists: lists.region },
    province: { index: indexes.province, internal: internal.province ?? null, eventLists: lists.province },
    ...(indexes.municipality === undefined
      ? {}
      : {
          municipality: {
            index: indexes.municipality,
            internal: internal.municipality ?? null,
            eventLists: lists.municipality,
          },
        }),
  });
}

describe('golden-2: Sassofeltrio', async () => {
  const built = await world(
    ['1929-05-13', '1929-05-14', '1947-11-24', '1947-11-25', '2021-06-16', '2021-06-17'],
    { region: ['08', '11'], province: ['041', '099'], municipality: ['041060', '099031'] },
    { municipality: await municipalityIdentity(['099031_sassofeltrio.json']) },
  );

  it('has three versions with a gap; the 2021 code change moves it to Rimini and Emilia-Romagna', () => {
    const sassofeltrio = entityAt(built.municipality, '099031', '2021-06-17');
    expect(sassofeltrio.istatOriginId).toBe(4450);
    expect(spans(sassofeltrio)).toEqual([
      ['1929-05-13', '1929-05-14', '041060', 'Sassofeltrio'],
      ['1947-11-25', '2021-06-17', '041060', 'Sassofeltrio'],
      ['2021-06-17', null, '099031', 'Sassofeltrio'],
    ]);
    const pesaro = entityAt(built.province, '041', '2021-06-16').id;
    const rimini = entityAt(built.province, '099', '2021-06-17').id;
    const marche = entityAt(built.region, '11', '2021-06-16').id;
    const emilia = entityAt(built.region, '08', '2021-06-17').id;
    expect(sassofeltrio.versions.map((v) => [v.cadastralCode, v.provinceId, v.regionId])).toEqual([
      ['I460', pesaro, marche],
      ['I460', pesaro, marche],
      ['I460', rimini, emilia],
    ]);
    expect(parentAnomalies(built)).toEqual([]);
    expectWellFormed(built);
  });
});

describe('golden-3: Siamanna', async () => {
  const built = await world(
    ['1947-11-27', '1947-11-28', '1974-08-20', '1974-09-13', '2025-12-31', '2026-01-01'],
    { region: ['20'], province: ['092', '095', '115'], municipality: ['092128', '095057', '115064'] },
    {
      municipality: await municipalityIdentity(['115064_siamanna.json']),
      province: await utsIdentity([
        ['092', 'province', '092_1_cagliari.json'],
        ['115', 'province', '115_1_oristano.json'],
      ]),
    },
  );

  it('has exactly the four versions of §4.4', () => {
    const siamanna = entityAt(built.municipality, '115064', '2026-01-01');
    const cagliari = entityAt(built.province, '092', '1947-11-28').id;
    const oristano = entityAt(built.province, '115', '2026-01-01').id;
    const sardegna = entityAt(built.region, '20', '2026-01-01').id;
    expect(siamanna.istatOriginId).toBe(10704);
    expect(entityAt(built.province, '095', '1974-08-20').id).toBe(oristano);
    const version = (
      validFrom: IsoDate,
      validTo: IsoDate | null,
      istatCode: string,
      name: string,
      cadastralCode: string,
      provinceId: string,
    ) => ({
      validFrom,
      validTo,
      istatCode,
      officialName: name,
      italianName: name,
      foreignName: null,
      cadastralCode,
      provinceId,
      regionId: sardegna,
    });
    expect(siamanna.versions).toEqual([
      version('1947-11-28', '1974-08-20', '092128', 'Siamanna-Siapiccia', 'I719', cagliari),
      version('1974-08-20', '1974-09-13', '095057', 'Siamanna-Siapiccia', 'I719', oristano),
      version('1974-09-13', '2026-01-01', '095057', 'Siamanna', 'I718', oristano),
      version('2026-01-01', null, '115064', 'Siamanna', 'I718', oristano),
    ]);
    expect(parentAnomalies(built)).toEqual([]);
    expectWellFormed(built);
  });

  it('the compartment of 1947 and the region of 1974 are one entity, with a new version', () => {
    const sardegna = entityAt(built.region, '20', '2026-01-01');
    expect(sardegna.versions.map((v) => [v.validFrom, v.type])).toEqual([
      ['1947-11-27', 'compartment'],
      ['1974-08-20', 'region'],
    ]);
  });
});

describe('golden-5: Milano 2015', async () => {
  const built = await world(
    ['2014-12-31', '2015-01-01'],
    { region: ['03'], province: ['015', '215'] },
    {
      province: await utsIdentity([
        ['015', 'province', '015_1_milano.json'],
        ['215', 'metropolitan_city', '215_3_milano.json'],
      ]),
    },
  );
  const milano = entityAt(built.province, '215', '2015-01-01');
  const milanese = built.municipality.filter((e) => e.versions[0]?.istatCode.startsWith('015'));

  it('the province becomes a metropolitan city: one entity, a new version', () => {
    expect(milano.istatOriginId).toBe(9);
    expect(milano.versions.map((v) => [v.validFrom, v.istatCode, v.type, v.abbreviation])).toEqual([
      ['2014-12-31', '015', 'province', 'MI'],
      ['2015-01-01', '215', 'metropolitan_city', 'MI'],
    ]);
  });

  it('its 134 municipalities keep their 015xxx codes and get no new version', () => {
    expect(milanese).toHaveLength(134);
    for (const municipality of milanese) {
      expect(municipality.versions).toHaveLength(1);
      expect(municipality.versions[0]).toMatchObject({ validFrom: '2014-12-31', validTo: null, provinceId: milano.id });
    }
    expectWellFormed(built);
  });
});

describe('golden-10: Courmayeur', async () => {
  const built = await world(
    ['1936-06-04', '1939-10-21', '1946-01-30'],
    { region: ['01'], province: ['007'], municipality: ['007022'] },
    { municipality: await municipalityIdentity(['007022_courmayeur.json']) },
  );

  it('Courmayeur → Cormaiore (1939-10-21) → Courmayeur (1946-01-30): three versions, only names change', () => {
    const courmayeur = entityAt(built.municipality, '007022', '1946-01-30');
    expect(spans(courmayeur)).toEqual([
      ['1936-06-04', '1939-10-21', '007022', 'Courmayeur'],
      ['1939-10-21', '1946-01-30', '007022', 'Cormaiore'],
      ['1946-01-30', null, '007022', 'Courmayeur'],
    ]);
    const unnamed = courmayeur.versions.map(({ istatCode, foreignName, cadastralCode, provinceId, regionId }) => ({
      istatCode,
      foreignName,
      cadastralCode,
      provinceId,
      regionId,
    }));
    expect(new Set(unnamed.map((v) => JSON.stringify(v))).size).toBe(1);
  });

  it("the province renamed Aosta → Valle d'Aosta does not split the municipality", () => {
    const aosta = entityAt(built.province, '007', '1946-01-30');
    expect(aosta.versions.map((v) => [v.validFrom, v.officialName, v.abbreviation])).toEqual([
      ['1936-06-04', 'Aosta', 'AO'],
      ['1946-01-30', "Valle d'Aosta", 'AO'],
    ]);
    expect(built.anomalies.list()).toEqual([]);
    expectWellFormed(built);
  });
});

describe('golden-11: Bolzano/Bozen', async () => {
  const built = await world(
    ['1920-10-15', '1920-10-16', '1921-06-01'],
    { region: ['82'], province: ['802'], municipality: ['802039'] },
    { municipality: await municipalityIdentity(['021008_bolzano-bozen.json']) },
  );

  it('is bilingual from the annexation of 1920-10-16', () => {
    const bolzano = entityAt(built.municipality, '802039', '1921-06-01');
    expect(bolzano.istatOriginId).toBe(8980);
    expect(bolzano.versions).toEqual([
      {
        validFrom: '1920-10-16',
        validTo: null,
        istatCode: '802039',
        officialName: 'Bolzano/Bozen',
        italianName: 'Bolzano',
        foreignName: 'Bozen',
        cadastralCode: 'A952',
        provinceId: entityAt(built.province, '802', '1921-06-01').id,
        regionId: entityAt(built.region, '82', '1921-06-01').id,
      },
    ]);
    expect(built.anomalies.list()).toEqual([]);
    expectWellFormed(built);
  });
});

describe('golden-12: bilingual names of 2009-01-29', async () => {
  const built = await world(['2009-01-28', '2009-01-29'], {});
  const renames = lists.municipality[104].filter((r) => r.date === '2009-01-29');

  it('every rename of the day opens a version with the new names', () => {
    expect(renames.length).toBeGreaterThan(0);
    for (const rename of renames) {
      const entity = entityAt(built.municipality, rename.related?.code ?? rename.code, '2009-01-29');
      expect(entity.versions.map((v) => v.validFrom)).toEqual(['2009-01-28', '2009-01-29']);
      expect(entity.versions[1]).toMatchObject({
        officialName: rename.related?.name,
        foreignName: rename.related?.foreignName,
      });
    }
  });

  it('Duino Aurisina gets its Slovene name Devin Nabrežina', () => {
    const duino = entityAt(built.municipality, '032001', '2009-01-29');
    expect(spans(duino)).toEqual([
      ['2009-01-28', '2009-01-29', '032001', 'Duino Aurisina'],
      ['2009-01-29', null, '032001', 'Duino Aurisina-Devin Nabrežina'],
    ]);
    expect(duino.versions[1]).toMatchObject({ italianName: 'Duino Aurisina', foreignName: 'Devin Nabrežina' });
  });

  it('nothing else changes in the full world of the two days', () => {
    expect(built.municipality.filter((e) => e.versions.length > 1)).toHaveLength(renames.length);
    expect(built.province.every((e) => e.versions.length === 1)).toBe(true);
    expect(built.anomalies.list()).toEqual([]);
    expectWellFormed(built);
  });
});

describe('golden-15: the 1948 regime boundary', async () => {
  const built = await world(
    ['1947-12-31', '1948-01-01'],
    { municipality: false },
    { region: await piemonteIdentity() },
  );

  it('Piemonte (origin 14): the compartment becomes a region, a new version of the same entity', () => {
    const piemonte = entityAt(built.region, '01', '1948-01-01');
    expect(piemonte.istatOriginId).toBe(14);
    expect(piemonte.versions.map((v) => [v.validFrom, v.validTo, v.istatCode, v.officialName, v.type])).toEqual([
      ['1947-12-31', '1948-01-01', '01', 'Piemonte', 'compartment'],
      ['1948-01-01', null, '01', 'Piemonte', 'region'],
    ]);
  });

  it('splits bilingual region names on "/"', () => {
    expect(entityAt(built.region, '04', '1948-01-01').versions.at(-1)).toMatchObject({
      officialName: 'Trentino-Alto Adige/Südtirol',
      italianName: 'Trentino-Alto Adige',
      foreignName: 'Trentino-Südtirol',
    });
    expectWellFormed(built);
  });
});

describe('golden-16: the 1927 regime boundary', async () => {
  const built = await world(['1927-01-11', '1927-01-12'], {});
  const DAY = '1927-01-12';
  const municipalityEvents = Object.values(lists.municipality)
    .flat()
    .filter((r) => r.date === DAY);
  const eventCodes = new Set(municipalityEvents.flatMap((r) => [r.code, r.related?.code ?? r.code]));

  it('a municipality crossing the boundary gets a new version only with an event of the day', () => {
    const spanning = built.municipality.filter(
      (e) => e.versions[0]?.validFrom === '1927-01-11' && e.versions.at(-1)?.validTo === null,
    );
    expect(spanning.length).toBeGreaterThan(8000);
    const spurious = spanning.filter(
      (e) => e.versions.length > 1 && !e.versions.some((v) => eventCodes.has(v.istatCode)),
    );
    expect(spurious.map((e) => spans(e))).toEqual([]);
    // Municipalities moved to the new provinces of the day (new code and province).
    expect(spanning.filter((e) => e.versions.length > 1)).toHaveLength(1622);
  });

  it('without internal data, identity leaves exactly the expected anomalies', () => {
    // The 17 provinces established on 1927-01-12 and the suppression of Caserta need internal UTS events.
    const established = ['002 Vercelli', '007 Aosta', '009 Savona', '012 Varese', '021 Bolzano/Bozen', '031 Gorizia']
      .concat(['047 Pistoia', '055 Terni', '056 Viterbo', '057 Rieti', '060 Frosinone', '068 Pescara'])
      .concat(['074 Brindisi', '077 Matera', '086 Castrogiovanni', '088 Ragusa', '091 Nuoro']);
    const unexplained = built.identityAnomalies
      .list()
      .filter((a) => a.code === 'transition-unexplained')
      .map((a) => `${a.level}:${a.message}`);
    expect(unexplained).toEqual([
      'blocking:province 061 Caserta disappears on 1927-01-12 without continuity or events',
      ...established.map((p) => `blocking:province ${p} appears on 1927-01-12 without continuity or events`),
    ]);
    // Everything else follows from the missing internal data: every region and UTS entity has no
    // ISTAT id, Finale Ligure (009029, CS) could be a reconstitution, and the full public lists of
    // the cross-check have no internal counterpart.
    const counts: Record<string, number> = {};
    for (const a of built.identityAnomalies.list()) {
      const key = `${a.level}:${a.code}:${String(a.context.level)}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toEqual({
      'blocking:transition-unexplained:province': 18,
      'blocking:internal-data-required:region': 18,
      'blocking:internal-data-required:province': 93,
      'blocking:internal-data-required:municipality': 1,
      'warning:identity-public-event-unmatched:region': 66,
      'warning:identity-public-event-unmatched:province': 156,
    });
    expect(
      built.identityAnomalies
        .list()
        .filter((a) => a.code === 'internal-data-required' && a.context.level === 'municipality')
        .map((a) => (a.context.intervals as string[])[0]),
    ).toEqual(['009029@1927-01-12']);
  });

  it('regions and the surviving provinces do not change', () => {
    expect(built.region.every((e) => e.versions.length === 1)).toBe(true);
    expect(built.province.filter((e) => e.versions.length > 1).map((e) => spans(e))).toEqual([]);
    expect(built.anomalies.list()).toEqual([]);
    expectWellFormed(built);
  });
});

describe('pre-1948 abbreviations of the 1921 world (§6.9)', async () => {
  const built = await world(['1921-06-01'], {});

  it('are derived from the municipalities, unanimous, Venezia Giulia as ISTAT reports it', () => {
    const abbreviation = (code: string) => entityAt(built.province, code, '1921-06-01').versions[0]?.abbreviation;
    expect(built.province).toHaveLength(71);
    expect(abbreviation('801')).toBe('Venezia Giulia');
    expect(abbreviation('802')).toBe('TN');
    expect(abbreviation('001')).toBe('TO');
    expect(built.anomalies.list()).toEqual([]);
  });
});
