import { describe, expect, it } from 'vitest';
import { AnomalyCollector } from '../../src/anomalies.ts';
import { ANPR_ANOMALIES, crossCheckAnpr, loadAnpr, type CrossCheckMunicipality } from '../../src/crosscheck/index.ts';
import type { IsoDate } from '../../src/dates/index.ts';
import type { HttpResponse } from '../../src/http/transport.ts';
import type { MunicipalityVersion, ProvinceEntity } from '../../src/model/internal.ts';
import type { AnprRow } from '../../src/sources/anpr/index.ts';
import { constant, withSources } from '../helpers/sources.ts';

const PROVINCE_ID = 28;

function version(
  id: number,
  validFrom: IsoDate,
  validTo: IsoDate | null,
  fields: Partial<MunicipalityVersion> = {},
): MunicipalityVersion {
  return {
    id,
    validFrom,
    validTo,
    istatCode: '028001',
    officialName: 'Abano Terme',
    italianName: 'Abano Terme',
    foreignName: null,
    cadastralCode: 'A001',
    provinceId: PROVINCE_ID,
    regionId: 5,
    ...fields,
  };
}

function municipality(id: number, versions: MunicipalityVersion[], isFormerItalian = false): CrossCheckMunicipality {
  return { level: 'municipality', id, istatOriginId: id, versions, isFormerItalian };
}

function row(line: number, validFrom: IsoDate, validTo: IsoDate | null, fields: Partial<AnprRow> = {}): AnprRow {
  return {
    line,
    validFrom,
    validTo,
    istatCode: '028001',
    cadastralCode: 'A001',
    italianName: 'ABANO TERME',
    otherName: null,
    provinceCode: '028',
    regionCode: '05',
    provinceAbbreviation: 'PD',
    status: validTo === null ? 'A' : 'C',
    ...fields,
  };
}

const PADOVA: ProvinceEntity = {
  level: 'province',
  id: PROVINCE_ID,
  istatOriginId: PROVINCE_ID,
  versions: [],
  historicalCodes: [{ validFrom: '1861-03-17', validTo: null, value: '028' }],
};

function check(
  municipalities: CrossCheckMunicipality[],
  rows: AnprRow[],
  provinces: ProvinceEntity[] = [PADOVA],
): AnomalyCollector {
  const anomalies = new AnomalyCollector();
  crossCheckAnpr({ anpr: { rows, issues: [] }, municipalities, provinces, anomalies });
  expect(anomalies.has('blocking')).toBe(false);
  return anomalies;
}

const codes = (anomalies: AnomalyCollector) => anomalies.list().map((a) => [a.level, a.code]);
const one = (anomalies: AnomalyCollector, code: string) => {
  const found = anomalies.list().filter((a) => a.code === code);
  expect(found).toHaveLength(1);
  const [anomaly] = found;
  if (anomaly === undefined) throw new Error(`no ${code} anomaly`);
  return anomaly;
};

describe('crossCheckAnpr: attributes', () => {
  it('reports nothing when ANPR agrees, across row splits that follow version splits', () => {
    const entity = municipality(1, [
      version(1, '1866-11-19', '1924-11-14', { officialName: 'Abano', italianName: 'Abano' }),
      version(2, '1924-11-14', null),
    ]);
    const anomalies = check(
      [entity],
      [row(2, '1866-11-19', '1924-11-14', { italianName: 'ABANO' }), row(3, '1924-11-14', null)],
    );
    expect(anomalies.list()).toEqual([]);
  });

  it('accepts the official or the Italian name in uppercase, accents included', () => {
    const bilingual = version(1, '1920-10-16', null, {
      istatCode: '021008',
      cadastralCode: 'A952',
      officialName: 'Bolzano/Bozen',
      italianName: 'Bolzano',
      foreignName: 'Bozen',
    });
    const accented = version(2, '1861-03-17', null, {
      istatCode: '001001',
      cadastralCode: 'A074',
      officialName: 'Agliè',
      italianName: 'Agliè',
    });
    const anomalies = check(
      [municipality(1, [bilingual]), municipality(2, [accented])],
      [
        row(2, '1920-10-16', null, { istatCode: '021008', cadastralCode: 'A952', italianName: 'BOLZANO' }),
        row(3, '1861-03-17', null, { istatCode: '001001', cadastralCode: 'A074', italianName: 'AGLIÈ' }),
      ],
    );
    expect(anomalies.list()).toEqual([]);
  });

  it('warns once per divergent ISTAT code, name and province, on the overlap', () => {
    const entity = municipality(7, [version(1, '1866-11-19', null)]);
    const anomalies = check(
      [entity],
      [
        row(2, '1866-11-19', '1924-11-14', { istatCode: '028901', italianName: 'ABANO BAGNI' }),
        row(3, '1924-11-14', null, { provinceCode: '029' }),
      ],
    );
    expect(codes(anomalies)).toEqual([
      ['warning', ANPR_ANOMALIES.divergentIstatCode],
      ['warning', ANPR_ANOMALIES.divergentName],
      ['warning', ANPR_ANOMALIES.divergentProvince],
    ]);
    expect(one(anomalies, ANPR_ANOMALIES.divergentIstatCode).context).toEqual({
      matchedBy: 'cadastral',
      entityId: 7,
      versionId: 1,
      validFrom: '1866-11-19',
      validTo: '1924-11-14',
      anprLine: 2,
      situas: '028001',
      anpr: '028901',
    });
    expect(one(anomalies, ANPR_ANOMALIES.divergentProvince).context).toMatchObject({
      validFrom: '1924-11-14',
      validTo: null,
      provinceId: PROVINCE_ID,
      situas: [{ validFrom: '1924-11-14', validTo: null, historicalCode: '028' }],
      anpr: '029',
    });
  });

  it('compares the province with its historical code on the same dates, skipping undetermined provinces', () => {
    const milano: ProvinceEntity = {
      ...PADOVA,
      id: 15,
      historicalCodes: [{ validFrom: '1861-03-17', validTo: null, value: '015' }],
    };
    const inMilano = version(1, '1861-03-17', null, { istatCode: '015146', cadastralCode: 'F205', provinceId: 15 });
    const undetermined = version(2, '1866-11-19', null, { provinceId: null });
    const anomalies = check(
      [municipality(1, [inMilano]), municipality(2, [undetermined])],
      [
        row(2, '1861-03-17', null, { istatCode: '015146', cadastralCode: 'F205', provinceCode: '015' }),
        row(3, '1866-11-19', null, { provinceCode: '999' }),
      ],
      [milano],
    );
    expect(anomalies.list()).toEqual([]);
  });

  it('falls back to the ISTAT code for versions without cadastral code', () => {
    const entity = municipality(3, [
      version(1, '1861-03-17', '1928-05-04', { cadastralCode: null, istatCode: '095809' }),
    ]);
    const anomalies = check(
      [entity],
      [row(2, '1861-03-17', '1928-05-05', { cadastralCode: null, istatCode: '095809', italianName: 'X' })],
    );
    expect(one(anomalies, ANPR_ANOMALIES.divergentName).context).toMatchObject({ matchedBy: 'istat-code' });
    expect(one(anomalies, ANPR_ANOMALIES.dateOffByOne).context).toEqual({
      count: 1,
      items: [
        {
          key: 'istat:095809',
          validFrom: '1928-05-04',
          validTo: '1928-05-05',
          anprLines: [2],
          side: 'anpr-only',
        },
      ],
    });
  });

  it('compares consecutive rows day by day and skips only the days where rows of the join key overlap', () => {
    const fallback = municipality(1, [
      version(1, '1861-03-17', '1900-01-01', { cadastralCode: null, istatCode: '001801' }),
    ]);
    const cadastral = municipality(2, [version(2, '1861-03-17', null)]);
    const anomalies = check(
      [fallback, cadastral],
      [
        row(2, '1861-03-17', '1880-01-01', { cadastralCode: 'Z001', istatCode: '001801', italianName: 'X' }),
        row(3, '1880-01-01', '1900-01-01', { cadastralCode: 'Z001', istatCode: '001801' }),
        row(6, '1890-01-01', '1900-01-01', { cadastralCode: 'Z002', istatCode: '001801', italianName: 'Y' }),
        row(4, '1861-03-17', null),
        row(5, '1950-01-01', null, { italianName: 'D' }),
      ],
    );
    expect(codes(anomalies)).toEqual([
      ['warning', ANPR_ANOMALIES.divergentName],
      ['info', ANPR_ANOMALIES.notComparable],
    ]);
    expect(one(anomalies, ANPR_ANOMALIES.divergentName).context).toMatchObject({
      matchedBy: 'istat-code',
      entityId: 1,
      validFrom: '1861-03-17',
      validTo: '1880-01-01',
      anprLine: 2,
    });
    expect(one(anomalies, ANPR_ANOMALIES.notComparable).context).toMatchObject({
      count: 2,
      items: [
        {
          entityId: 1,
          versionId: 1,
          matchedBy: 'istat-code',
          validFrom: '1890-01-01',
          validTo: '1900-01-01',
          anprRows: [{ line: 3 }, { line: 6 }],
        },
        {
          entityId: 2,
          versionId: 2,
          matchedBy: 'cadastral',
          validFrom: '1950-01-01',
          validTo: null,
          anprRows: [{ line: 4 }, { line: 5 }],
        },
      ],
    });
  });

  it('names equal without diacritics and with uniform apostrophes are info, other differences warnings', () => {
    const sampeire = version(1, '1861-03-17', null, { cadastralCode: 'B001', officialName: 'Sampèire' });
    const santAngelo = version(2, '1861-03-17', null, { cadastralCode: 'B002', officialName: 'Sant\u2019Angelo' });
    const cantu = version(3, '1861-03-17', null, { cadastralCode: 'B003', officialName: 'Cantù' });
    const anomalies = check(
      [municipality(1, [sampeire]), municipality(2, [santAngelo]), municipality(3, [cantu])],
      [
        row(2, '1861-03-17', null, { cadastralCode: 'B001', italianName: 'SAMPEIRE' }),
        row(3, '1861-03-17', null, { cadastralCode: 'B002', italianName: "SANT'ANGELO" }),
        row(4, '1861-03-17', null, { cadastralCode: 'B003', italianName: "CANTU'" }),
      ],
    );
    expect(codes(anomalies)).toEqual([
      ['warning', ANPR_ANOMALIES.divergentName],
      ['info', ANPR_ANOMALIES.nameDiacritics],
    ]);
    expect(one(anomalies, ANPR_ANOMALIES.divergentName).context).toMatchObject({ entityId: 3, anpr: "CANTU'" });
    expect(one(anomalies, ANPR_ANOMALIES.nameDiacritics).context).toMatchObject({
      count: 2,
      items: [
        { entityId: 1, anpr: 'SAMPEIRE', situas: { officialName: 'Sampèire' } },
        { entityId: 2, anpr: "SANT'ANGELO" },
      ],
    });
  });

  it('ISTAT codes and provinces in the municipality history: earlier = lag, later = anachronism (info)', () => {
    const province = (id: number, value: string): ProvinceEntity => ({
      ...PADOVA,
      id,
      historicalCodes: [{ validFrom: '1861-03-17', validTo: null, value }],
    });
    const provinces = [province(802, '802'), province(21, '021'), province(22, '022')];
    // Bolzano: 802039 in 802 until 1923-02-13, 022954 in 022 until 1927-01-11, then 021008 in 021.
    const bolzano = municipality(1, [
      version(1, '1920-10-16', '1923-02-14', { cadastralCode: 'A952', istatCode: '802039', provinceId: 802 }),
      version(2, '1923-02-14', '1927-01-12', { cadastralCode: 'A952', istatCode: '022954', provinceId: 22 }),
      version(3, '1927-01-12', null, { cadastralCode: 'A952', istatCode: '021008', provinceId: 21 }),
    ]);
    const anomalies = check(
      [bolzano],
      [
        // ANPR already has the 1923 province (anachronism) and is late with the 1927 code and province.
        row(2, '1920-10-16', '1923-02-14', { cadastralCode: 'A952', istatCode: '802039', provinceCode: '022' }),
        row(3, '1923-02-14', '1927-01-12', { cadastralCode: 'A952', istatCode: '021008', provinceCode: '022' }),
        row(4, '1927-01-12', null, { cadastralCode: 'A952', istatCode: '022954', provinceCode: '022' }),
      ],
      provinces,
    );
    expect(codes(anomalies)).toEqual([
      ['info', ANPR_ANOMALIES.laggingIstatCode],
      ['info', ANPR_ANOMALIES.anachronisticIstatCode],
      ['info', ANPR_ANOMALIES.laggingProvince],
      ['info', ANPR_ANOMALIES.anachronisticProvince],
    ]);
    expect(one(anomalies, ANPR_ANOMALIES.laggingIstatCode).context).toMatchObject({
      items: [{ versionId: 3, situas: '021008', anpr: '022954' }],
    });
    expect(one(anomalies, ANPR_ANOMALIES.anachronisticIstatCode).context).toMatchObject({
      items: [{ versionId: 2, situas: '022954', anpr: '021008' }],
    });
    expect(one(anomalies, ANPR_ANOMALIES.laggingProvince).context).toMatchObject({
      items: [{ versionId: 3, provinceId: 21, anpr: '022', situas: [{ historicalCode: '021' }] }],
    });
    expect(one(anomalies, ANPR_ANOMALIES.anachronisticProvince).context).toMatchObject({
      items: [{ versionId: 1, provinceId: 802, anpr: '022', situas: [{ historicalCode: '802' }] }],
    });
  });

  it('an ISTAT code or province never in the municipality history is a warning', () => {
    const entity = municipality(1, [
      version(1, '1866-11-19', '1924-11-14', { istatCode: '028901' }),
      version(2, '1924-11-14', null),
    ]);
    const anomalies = check(
      [entity],
      [
        row(2, '1866-11-19', '1924-11-14', { istatCode: '028901' }),
        row(3, '1924-11-14', null, { istatCode: '099001', provinceCode: '099' }),
      ],
    );
    expect(codes(anomalies)).toEqual([
      ['warning', ANPR_ANOMALIES.divergentIstatCode],
      ['warning', ANPR_ANOMALIES.divergentProvince],
    ]);
  });
});

describe('crossCheckAnpr: dates', () => {
  it('one-day differences are info, longer ones warnings (golden-3 shape)', () => {
    const entity = municipality(1, [
      version(1, '1947-11-28', '1974-08-20'),
      version(2, '1974-08-20', '2000-01-01', { istatCode: '095057' }),
    ]);
    const anomalies = check(
      [entity],
      [row(2, '1947-12-13', '1974-08-20'), row(3, '1974-08-20', '2000-01-02', { istatCode: '095057' })],
    );
    expect(codes(anomalies)).toEqual([
      ['warning', ANPR_ANOMALIES.dateDivergence],
      ['info', ANPR_ANOMALIES.dateOffByOne],
    ]);
    expect(one(anomalies, ANPR_ANOMALIES.dateDivergence).context).toMatchObject({
      entityId: 1,
      versionIds: [1],
      matchedBy: ['cadastral'],
      validFrom: '1947-11-28',
      validTo: '1947-12-13',
      side: 'situas-only',
      edge: 'start',
      anprRows: [{ line: 2, validFrom: '1947-12-13' }, { line: 3 }],
    });
    expect(one(anomalies, ANPR_ANOMALIES.dateOffByOne).context).toMatchObject({
      items: [{ validFrom: '2000-01-01', validTo: '2000-01-02', side: 'anpr-only' }],
    });
  });

  it('a period only ANPR covers, next to a matched one, is a date divergence', () => {
    const anomalies = check(
      [municipality(1, [version(1, '1900-01-01', '1950-01-01')])],
      [row(2, '1900-01-01', '1960-01-01')],
    );
    expect(one(anomalies, ANPR_ANOMALIES.dateDivergence).context).toMatchObject({
      key: 'A001',
      validFrom: '1950-01-01',
      validTo: '1960-01-01',
      side: 'anpr-only',
      edge: 'end',
      versions: [{ entityId: 1, versionId: 1 }],
    });
  });

  it('entities and periods absent from ANPR are info, aggregated per code', () => {
    const missing = municipality(1, [version(1, '1861-03-17', '1869-01-01', { cadastralCode: 'B001' })]);
    const other = municipality(2, [
      version(2, '1861-03-17', '1870-01-01', { cadastralCode: 'B002', istatCode: '028002' }),
    ]);
    // A suppressed and reconstituted municipality: ANPR knows only the second period.
    const gap = municipality(3, [
      version(3, '1861-03-17', '1929-05-14', { cadastralCode: 'I460', istatCode: '041060' }),
      version(4, '1947-11-25', null, { cadastralCode: 'I460', istatCode: '041060' }),
    ]);
    const anomalies = check(
      [missing, other, gap],
      [row(2, '1947-11-25', null, { cadastralCode: 'I460', istatCode: '041060' })],
    );
    expect(codes(anomalies)).toEqual([
      ['info', ANPR_ANOMALIES.missingEntity],
      ['info', ANPR_ANOMALIES.missingPeriod],
    ]);
    expect(one(anomalies, ANPR_ANOMALIES.missingEntity).context).toMatchObject({
      count: 2,
      items: [{ entityId: 1 }, { entityId: 2 }],
    });
    expect(one(anomalies, ANPR_ANOMALIES.missingPeriod).context).toMatchObject({
      count: 1,
      items: [{ entityId: 3, versionIds: [3], validFrom: '1861-03-17', validTo: '1929-05-14' }],
    });
  });

  it('a period only ANPR knows, matching no version, is unmatched', () => {
    const anomalies = check(
      [municipality(1, [version(1, '1900-01-01', null)])],
      [row(2, '1900-01-01', null), row(3, '1920-10-16', '1923-02-14', { cadastralCode: 'Z999', istatCode: '802001' })],
    );
    expect(codes(anomalies)).toEqual([['warning', ANPR_ANOMALIES.unmatchedPeriod]]);
    expect(one(anomalies, ANPR_ANOMALIES.unmatchedPeriod).context).toMatchObject({
      key: 'Z999',
      validFrom: '1920-10-16',
      validTo: '1923-02-14',
      anprRows: [{ line: 3 }],
    });
  });

  it('consecutive ANPR rows with identical attributes are split rows (info)', () => {
    const anomalies = check(
      [municipality(1, [version(1, '1900-01-01', null)])],
      [row(2, '1900-01-01', '1928-12-12'), row(3, '1928-12-12', null)],
    );
    expect(codes(anomalies)).toEqual([['info', ANPR_ANOMALIES.splitRows]]);
    expect(one(anomalies, ANPR_ANOMALIES.splitRows).context).toEqual({
      count: 1,
      items: [{ key: 'A001', istatCode: '028001', date: '1928-12-12', anprLines: [2, 3] }],
    });
  });
});

describe('crossCheckAnpr: former Italian', () => {
  it('ANPR missing the EX of a former Italian entity is info; an EX on one that is not is a warning', () => {
    const fiume = municipality(1, [version(1, '1924-03-09', '1947-09-16', { cadastralCode: 'D620' })], true);
    const tenda = municipality(2, [version(2, '1861-03-17', '1947-09-16', { cadastralCode: 'L095' })], true);
    const zara = municipality(3, [version(3, '1923-02-08', null, { cadastralCode: 'M149' })], false);
    const anomalies = check(
      [fiume, tenda, zara],
      [
        row(2, '1924-03-09', '1947-09-16', { cadastralCode: 'D620', regionCode: 'EX' }),
        row(3, '1861-03-17', '1947-09-16', { cadastralCode: 'L095', regionCode: '01' }),
        row(4, '1923-02-08', null, { cadastralCode: 'M149', regionCode: 'EX' }),
      ],
    );
    expect(codes(anomalies)).toEqual([
      ['warning', ANPR_ANOMALIES.formerItalianDivergence],
      ['info', ANPR_ANOMALIES.formerItalianMissing],
    ]);
    expect(one(anomalies, ANPR_ANOMALIES.formerItalianDivergence).context).toMatchObject({
      entityId: 3,
      isFormerItalian: false,
      anprRegion: 'EX',
    });
    expect(one(anomalies, ANPR_ANOMALIES.formerItalianMissing).context).toEqual({
      count: 1,
      items: [
        {
          matchedBy: 'cadastral',
          entityId: 2,
          versionId: 2,
          isFormerItalian: true,
          anprRegion: '01',
          anprLine: 3,
        },
      ],
    });
  });
});

describe('loadAnpr', () => {
  const HEADER =
    '"ID","DATAISTITUZIONE","DATACESSAZIONE","CODISTAT","CODCATASTALE","DENOMINAZIONE_IT","DENOMTRASLITTERATA",' +
    '"ALTRADENOMINAZIONE","ALTRADENOMTRASLITTERATA","ID_PROVINCIA","IDPROVINCIAISTAT","IDREGIONE","IDPREFETTURA",' +
    '"STATO","SIGLAPROVINCIA","FONTE","DATAULTIMOAGG","COD_DENOM"';
  const ABANO =
    '1,"1924-11-14","9999-12-31","028001","A001","ABANO TERME","ABANO TERME","","",28,"028","05","PD","A","PD","","2016-06-17",""';
  const csv = (...lines: string[]): HttpResponse => ({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    body: `${lines.join('\r\n')}\r\n`,
  });

  it('returns the rows and reports dropped rows as one info', async () => {
    await withSources(
      async ({ anpr }) => {
        const anomalies = new AnomalyCollector();
        const data = await loadAnpr({ source: anpr, anomalies });
        expect(data?.rows).toHaveLength(1);
        expect(anomalies.list()).toEqual([
          {
            level: 'info',
            code: ANPR_ANOMALIES.rowDropped,
            message: '1 malformed ANPR rows dropped',
            context: { count: 1, items: [expect.objectContaining({ line: 3, message: "invalid STATO 'Z'" })] },
          },
        ]);
      },
      { transport: constant(csv(HEADER, ABANO, ABANO.replace('"A","PD"', '"Z","PD"'))) },
    );
  });

  it('a structurally broken CSV skips the cross-check with a single warning, and the run goes on', async () => {
    await withSources(
      async ({ anpr }) => {
        const anomalies = new AnomalyCollector();
        expect(await loadAnpr({ source: anpr, anomalies })).toBeNull();
        expect(codes(anomalies)).toEqual([['warning', ANPR_ANOMALIES.unavailable]]);
        expect(one(anomalies, ANPR_ANOMALIES.unavailable).context).toMatchObject({ error: 'AnprFormatError' });
      },
      { transport: constant(csv(HEADER.replace('"IDREGIONE",', ''), ABANO)) },
    );
  });

  it('download failures (HTTP status, exhausted retries) skip the cross-check with a single warning', async () => {
    for (const [status, error] of [
      [404, 'HttpStatusError'],
      [503, 'RetriesExhaustedError'],
    ] as const) {
      await withSources(
        async ({ anpr }) => {
          const anomalies = new AnomalyCollector();
          expect(await loadAnpr({ source: anpr, anomalies })).toBeNull();
          expect(anomalies.list()).toHaveLength(1);
          expect(one(anomalies, ANPR_ANOMALIES.unavailable)).toMatchObject({ level: 'warning', context: { error } });
        },
        { transport: constant({ status, headers: { 'content-type': 'text/html' }, body: 'down' }) },
      );
    }
  });

  it('other errors are bugs and propagate', async () => {
    await withSources(
      async ({ anpr }) => {
        await expect(loadAnpr({ source: anpr, anomalies: new AnomalyCollector() })).rejects.toThrow('boom');
      },
      {
        transport: () => {
          throw new Error('boom');
        },
      },
    );
  });
});
