import { describe, expect, it } from 'vitest';
import { parseJsonBody } from '../../src/http/decode.ts';
import { createFixtureTransport, fixturePath, slugify, subsetBasePath } from '../helpers/fixtures.ts';

const INTERNAL = 'https://situas.istat.it/ShibO2Module/api/Report/ReportByUrl';
const internal = (url: string) => ({ method: 'POST' as const, url: INTERNAL, body: { url } });

describe('fixturePath', () => {
  it('maps public snapshots and event lists by level', () => {
    expect(
      fixturePath({
        method: 'GET',
        url: 'https://situas-servizi.istat.it/publish/reportspooljson?pfun=68&pdata=01/01/1948',
      }),
    ).toBe('situas-public/snapshots/regions/pfun-68_1948-01-01.json');
    expect(
      fixturePath({
        method: 'GET',
        url: 'https://situas-servizi.istat.it/publish/reportspooljson?pfun=103&pdatada=17%2F03%2F1861&pdataa=30%2F09%2F2026',
      }),
    ).toBe('situas-public/events/municipalities/pfun-103_1861-03-17_2026-09-30.json');
  });

  it('maps internal reports 1–9', () => {
    expect(fixturePath(internal('var_get_ua_uts_lov_diffusione?uts='))).toBe('situas-internal/r2-uts-list/all.json');
    expect(fixturePath(internal("var_get_ua_reg_lov_rs?&codreg=02&reg=Valle d'Aosta/Vallée d'Aoste&reg_tipo=2"))).toBe(
      'situas-internal/r4-region-events/02_2_valle-d-aosta-vallee-d-aoste.json',
    );
    expect(fixturePath(internal('var_get_ua_comuni_lov_rs?procom=021008&com=Bolzano%2FBozen'))).toBe(
      'situas-internal/r6-municipality-events/021008_bolzano-bozen.json',
    );
    expect(
      fixturePath(internal('var_get_ua_uts_lov_rs_dett_ass?&id_uts_origine=58&idprovv=6151&uts_tipo=3&mcrvar=CSCT')),
    ).toBe('situas-internal/r8-uts-event-details/58_CSCT_6151.json');
  });

  it('needs a download date for ANPR', () => {
    const request = {
      method: 'GET' as const,
      url: 'https://www.anagrafenazionale.interno.it/wp-content/uploads/ANPR_archivio_comuni.csv',
    };
    expect(() => fixturePath(request)).toThrow(/download date/);
    expect(fixturePath(request, { downloadDate: '2026-09-30' })).toBe('anpr/anpr-archivio-comuni_2026-09-30.csv');
  });

  it('rejects unknown endpoints and missing parameters', () => {
    expect(() => fixturePath({ method: 'GET', url: 'https://example.org/x' })).toThrow();
    expect(() => fixturePath(internal('var_get_ua_uts_lov_rs?&uts=Nuoro&uts_tipo=1'))).toThrow(/coduts/);
  });
});

describe('slugify and subsets', () => {
  it('slugifies names', () => {
    expect(slugify('Agliè')).toBe('aglie');
    expect(slugify('San Dorligo della Valle-Dolina')).toBe('san-dorligo-della-valle-dolina');
  });

  it('strips subset markers', () => {
    expect(subsetBasePath('a/pfun-98_1861-03-17_2026-09-30__subset-first-100-rows.json')).toBe(
      'a/pfun-98_1861-03-17_2026-09-30.json',
    );
  });
});

describe('fixture transport', () => {
  it('serves recorded responses, including for encoded requests', async () => {
    const transport = await createFixtureTransport();
    const response = await transport(internal('var_get_ua_uts_lov_rs?&uts=Sassari&coduts=312&uts_tipo=3'));
    expect(response.status).toBe(200);
    // Raw internal bodies are double-encoded (§3.3).
    expect(parseJsonBody(response.body)).toHaveProperty('items');

    const encoded = await transport({
      method: 'GET',
      url: 'https://situas-servizi.istat.it/publish/reportspooljson?pfun=64&pdata=01%2F01%2F2026',
    });
    expect(parseJsonBody(encoded.body)).toHaveProperty('resultset');
  });

  it('fails loudly on unknown requests', async () => {
    const transport = await createFixtureTransport();
    await expect(
      transport({
        method: 'GET',
        url: 'https://situas-servizi.istat.it/publish/reportspooljson?pfun=64&pdata=02/01/2026',
      }),
    ).rejects.toThrow(/no full fixture/);
    await expect(transport({ method: 'GET', url: 'https://example.org/' })).rejects.toThrow(/Fixture transport/);
  });
});
