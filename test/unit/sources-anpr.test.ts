import { describe, expect, it } from 'vitest';
import { ResponseValidationError } from '../../src/http/errors.ts';
import type { HttpResponse } from '../../src/http/transport.ts';
import { AnprFormatError, parseAnprCsv } from '../../src/sources/anpr/index.ts';
import { constant, withSources } from '../helpers/sources.ts';

const HEADER =
  '"ID","DATAISTITUZIONE","DATACESSAZIONE","CODISTAT","CODCATASTALE","DENOMINAZIONE_IT","DENOMTRASLITTERATA",' +
  '"ALTRADENOMINAZIONE","ALTRADENOMTRASLITTERATA","ID_PROVINCIA","IDPROVINCIAISTAT","IDREGIONE","IDPREFETTURA",' +
  '"STATO","SIGLAPROVINCIA","FONTE","DATAULTIMOAGG","COD_DENOM"';
const ABANO_OLD =
  '12560,"1866-11-19","1924-11-13","028001","A001","ABANO","ABANO","","",28,"028","05","","C","PD","","2016-06-17","028500"';
const ABANO =
  '1,"1924-11-14","9999-12-31","028001","A001","ABANO TERME","ABANO TERME","","",28,"028","05","PD","A","PD","","2016-06-17",""';

const csv = (...lines: string[]): HttpResponse => ({
  status: 200,
  headers: { 'content-type': 'text/csv' },
  body: `${lines.join('\r\n')}\r\n`,
});

describe('fetchAnpr', () => {
  it('parses the real archive with half-open dates (§6.11)', async () => {
    await withSources(async ({ anpr }) => {
      const { data } = await anpr.fetchAnpr();
      expect(data.issues).toEqual([]);
      expect(data.rows).toHaveLength(19364);
      expect(data.rows[0]).toEqual({
        line: 2,
        validFrom: '1866-11-19',
        validTo: '1924-11-14',
        istatCode: '028001',
        cadastralCode: 'A001',
        italianName: 'ABANO',
        otherName: null,
        provinceCode: '028',
        regionCode: '05',
        provinceAbbreviation: 'PD',
        status: 'C',
      });
      expect(data.rows[1]).toMatchObject({ validFrom: '1924-11-14', validTo: null, status: 'A' });
      expect(data.rows.filter((r) => r.status === 'A')).toHaveLength(7894);
      expect(data.rows.filter((r) => r.cadastralCode === null)).toHaveLength(28);
      expect(data.rows.filter((r) => r.regionCode === 'EX')).toHaveLength(197);
      // golden-3: ANPR starts Siamanna-Siapiccia on 1947-12-13 (SITUAS: 1947-11-28).
      expect(data.rows.find((r) => r.cadastralCode === 'I719' && r.istatCode === '092128')?.validFrom).toBe(
        '1947-12-13',
      );
    });
  });

  it('drops malformed rows as issues and keeps the others', () => {
    const { rows, issues } = parseAnprCsv(
      [
        HEADER,
        ABANO_OLD,
        '2,"1924-13-14","9999-12-31","028001","A001","X","X","","",28,"028","05","PD","A","PD","","2016-06-17",""',
        '3,"1924-11-14","1924-11-13","028001","A001","X","X","","",28,"028","05","PD","A","PD","","2016-06-17",""',
        '4,"1924-11-14","9999-12-31","28001","A001","X","X","","",28,"028","05","PD","A","PD","","2016-06-17",""',
        '5,"1924-11-14","9999-12-31","028001","A01","X","X","","",28,"028","05","PD","A","PD","","2016-06-17",""',
        '6,"1924-11-14","9999-12-31","028001","A001","X","X","","",28,"028","5","PD","A","PD","","2016-06-17",""',
        '7,"1924-11-14","9999-12-31","028001","A001","X","X","","",28,"028","05","PD","Z","PD","","2016-06-17",""',
        '8,"1924-11-14","9999-12-31","028001"',
        '9,"1924-11-14","9999-12-31","028001","ND","  ","X","","",28,"028","05","PD","A","PD","","2016-06-17",""',
        ABANO,
      ].join('\r\n'),
    );
    expect(rows.map((r) => r.line)).toEqual([2, 11]);
    expect(issues.map((i) => [i.line, i.message])).toEqual([
      [3, "invalid DATAISTITUZIONE '1924-13-14'"],
      [4, 'DATACESSAZIONE 1924-11-13 before DATAISTITUZIONE 1924-11-14'],
      [5, "invalid CODISTAT '28001'"],
      [6, "invalid CODCATASTALE 'A01'"],
      [7, "invalid IDREGIONE '5'"],
      [8, "invalid STATO 'Z'"],
      [9, 'expected 18 fields, got 4'],
      [10, 'missing DENOMINAZIONE_IT'],
    ]);
  });

  it('accepts a one-day row (cessation on the institution day)', () => {
    const ok = parseAnprCsv(
      [HEADER, '1,"1924-11-14","1924-11-14","028001","A001","X","X","","",28,"028","05","PD","C","PD","","",""'].join(
        '\n',
      ),
    );
    expect(ok.rows[0]).toMatchObject({ validFrom: '1924-11-14', validTo: '1924-11-15' });
  });

  it('raises AnprFormatError for structural problems, never a validation error, and stays usable', async () => {
    const missingColumn = csv(HEADER.replace('"IDREGIONE",', ''), ABANO);
    await withSources(
      async ({ anpr, client, calls }) => {
        const error: unknown = await anpr.fetchAnpr().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AnprFormatError);
        expect(error).not.toBeInstanceOf(ResponseValidationError);
        expect((error as Error).message).toContain('IDREGIONE');
        expect(client.isEndpointDisabled('anpr:archivio-comuni')).toBe(false);
        expect(client.isCircuitOpen('anpr')).toBe(false);
        // Not retried and not cached: a second call goes to the network again.
        await expect(anpr.fetchAnpr()).rejects.toBeInstanceOf(AnprFormatError);
        expect(calls).toHaveLength(2);
      },
      { transport: constant(missingColumn) },
    );
    await withSources(
      async ({ anpr }) => {
        await expect(anpr.fetchAnpr()).rejects.toBeInstanceOf(AnprFormatError);
      },
      { transport: constant(csv(HEADER, '1,"unterminated')) },
    );
  });
});
