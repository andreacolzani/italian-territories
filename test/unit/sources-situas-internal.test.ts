import { describe, expect, it } from 'vitest';
import { ResponseValidationError, RetriesExhaustedError } from '../../src/http/errors.ts';
import type { HttpResponse } from '../../src/http/transport.ts';
import { reportUrls } from '../../src/sources/situas-internal/index.ts';
import { constant, withSources } from '../helpers/sources.ts';

/** Internal API body as served for a non-empty result: a JSON string holding the document (§3.3). */
const doubleEncoded = (items: unknown[]): HttpResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(JSON.stringify({ items })),
});
/** Plain JSON, as served for empty results (`text/plain`) or provided by hand. */
const plain = (items: unknown[], contentType = 'application/json'): HttpResponse => ({
  status: 200,
  headers: { 'content-type': contentType },
  body: JSON.stringify({ items }),
});

const sassofeltrioEvent = {
  'codice comune corrente': '099031',
  'denominazione corrente': 'Sassofeltrio',
  'tipo variazione': 'ES',
  'data evento': '14/05/1929',
  'codice Istat': '041060',
  denominazione: 'Sassofeltrio',
  'descrizione evento': 'AGGREGATO',
  'identificativo provvedimento': 4928,
  variazione: 'ES-Estinzione',
  id_comune_origine: 4450,
  orderr: 3,
};

describe('internal lists (r1–r3)', () => {
  it('lists regions, UTS and municipalities with origin ids', async () => {
    await withSources(async ({ situasInternal }) => {
      const regions = (await situasInternal.regionList()).data;
      expect(regions).toHaveLength(45);
      expect(regions.filter((r) => r.name === 'Piemonte')).toEqual([
        { code: '01', name: 'Piemonte', type: 'compartment', originId: 14 },
        { code: '01', name: 'Piemonte', type: 'region', originId: 14 },
      ]);

      const uts = (await situasInternal.utsList()).data;
      expect(uts).toHaveLength(180);
      expect(uts.filter((r) => r.name === 'Cagliari')).toEqual([
        { code: '092', name: 'Cagliari', type: 'province', originId: 59 },
        { code: '292', name: 'Cagliari', type: 'metropolitan_city', originId: 59 },
        { code: '318', name: 'Cagliari', type: 'metropolitan_city', originId: 59 },
      ]);
      // golden-4: the 2026 Ogliastra and Medio Campidano are distinct from the 2005–2016 ones.
      expect(uts.filter((r) => r.name === 'Ogliastra').map((r) => [r.code, r.originId])).toEqual([
        ['105', 111],
        ['116', 146],
      ]);

      const municipalities = (await situasInternal.municipalityList()).data;
      expect(municipalities).toHaveLength(17617);
      expect(municipalities[0]).toEqual({ code: '001001', name: 'Agliè' });
    });
  });

  it('treats an empty list as transient (impossible for r1–r3)', async () => {
    await withSources(
      async ({ situasInternal, calls }) => {
        await expect(situasInternal.regionList()).rejects.toBeInstanceOf(RetriesExhaustedError);
        expect(calls).toHaveLength(3);
      },
      { transport: constant(plain([], 'text/plain')) },
    );
  });
});

describe('internal events (r4–r6)', () => {
  it('r4: events of each Piemonte record', async () => {
    await withSources(async ({ situasInternal }) => {
      const compartment = (await situasInternal.regionEvents({ code: '01', name: 'Piemonte', type: 'compartment' }))
        .data;
      expect(compartment).toHaveLength(5);
      expect(compartment[0]).toMatchObject({
        event: 'CS',
        date: '1871-12-31',
        code: '01',
        name: 'Piemonte',
        currentCode: '01',
        currentName: 'Piemonte',
        actId: 6109,
        originId: 14,
        type: 'compartment',
      });
      const region = (await situasInternal.regionEvents({ code: '01', name: 'Piemonte', type: 'region' })).data;
      expect(region.map((e) => [e.event, e.date, e.actId, e.type])).toEqual([['CSCT', '1948-01-01', 6107, 'region']]);
    });
  });

  it('r5: typed UTS records keep id_uts and point to their origin (golden-4, golden-5)', async () => {
    await withSources(async ({ situasInternal }) => {
      const sassari = (await situasInternal.utsEvents({ code: '090', name: 'Sassari', type: 'province' })).data;
      expect(new Set(sassari.map((e) => e.utsId))).toEqual(new Set([58]));
      expect(sassari.at(-1)).toMatchObject({ event: 'ESCT', date: '2026-01-01', actId: 6151, originId: 58 });

      const sassariCity = (await situasInternal.utsEvents({ code: '312', name: 'Sassari', type: 'metropolitan_city' }))
        .data;
      expect(sassariCity.map((e) => [e.event, e.utsId, e.originId, e.type])).toEqual([
        ['CSCT', 143, 58, 'metropolitan_city'],
      ]);

      const cagliari = (await situasInternal.utsEvents({ code: '318', name: 'Cagliari', type: 'metropolitan_city' }))
        .data;
      expect(cagliari.map((e) => [e.event, e.code, e.utsId, e.originId])).toEqual([
        ['CSCT', '292', 127, 59],
        ['RN', '318', 127, 59],
        ['AQES', '318', 127, 59],
      ]);

      const milano = (await situasInternal.utsEvents({ code: '015', name: 'Milano', type: 'province' })).data;
      expect(new Set(milano.map((e) => e.utsId))).toEqual(new Set([9]));
      const milanoCity = (await situasInternal.utsEvents({ code: '215', name: 'Milano', type: 'metropolitan_city' }))
        .data;
      expect(milanoCity.map((e) => [e.event, e.date, e.utsId, e.originId])).toEqual([['CSCT', '2015-01-01', 119, 9]]);
    });
  });

  it('r6: full history of a municipality (golden-2, golden-11)', async () => {
    await withSources(async ({ situasInternal }) => {
      const sassofeltrio = (await situasInternal.municipalityEvents({ code: '099031', name: 'Sassofeltrio' })).data;
      expect(sassofeltrio.map((e) => [e.event, e.date, e.code])).toEqual([
        ['PV', '1861-03-17', '041060'],
        ['ES', '1929-05-14', '041060'],
        ['CS', '1947-11-25', '041060'],
        ['AP', '2021-06-17', '099031'],
      ]);
      expect(new Set(sassofeltrio.map((e) => e.originId))).toEqual(new Set([4450]));
      expect(sassofeltrio[0]).toMatchObject({ currentCode: '099031', currentName: 'Sassofeltrio', actId: 373 });

      const bolzano = (await situasInternal.municipalityEvents({ code: '021008', name: 'Bolzano/Bozen' })).data;
      expect(bolzano.find((e) => e.event === 'AN')).toMatchObject({ date: '1920-10-16', code: '802039' });
    });
  });

  it('decodes double-encoded and plain JSON bodies alike', async () => {
    for (const response of [doubleEncoded([sassofeltrioEvent]), plain([sassofeltrioEvent])]) {
      await withSources(
        async ({ situasInternal }) => {
          const { data } = await situasInternal.municipalityEvents({ code: '099031', name: 'Sassofeltrio' });
          expect(data).toEqual([
            {
              event: 'ES',
              date: '1929-05-14',
              code: '041060',
              name: 'Sassofeltrio',
              currentCode: '099031',
              currentName: 'Sassofeltrio',
              description: 'AGGREGATO',
              actId: 4928,
              originId: 4450,
            },
          ]);
        },
        { transport: constant(response) },
      );
    }
  });

  it('accepts an empty event list served as text/plain', async () => {
    await withSources(
      async ({ situasInternal }) => {
        const { data } = await situasInternal.utsEvents({ code: '999', name: 'Nowhere', type: 'province' });
        expect(data).toEqual([]);
      },
      { transport: constant(plain([], 'text/plain')) },
    );
  });

  it('rejects an unknown event code (§6.2, D21)', async () => {
    await withSources(
      async ({ situasInternal }) => {
        await expect(
          situasInternal.municipalityEvents({ code: '099031', name: 'Sassofeltrio' }),
        ).rejects.toBeInstanceOf(ResponseValidationError);
      },
      { transport: constant(doubleEncoded([{ ...sassofeltrioEvent, 'tipo variazione': 'XX' }])) },
    );
  });
});

describe('internal event details (r7–r9)', () => {
  it('r7: the compartment a 1871 region came from (golden-15)', async () => {
    await withSources(async ({ situasInternal }) => {
      const { data } = await situasInternal.regionEventDetails({
        originId: 14,
        regionType: 'compartment',
        actId: 6109,
        event: 'CS',
      });
      expect(data).toEqual([
        {
          event: 'CS',
          date: '1871-12-31',
          code: '01',
          name: 'Piemonte',
          related: { code: '81', name: 'Piemonte e Liguria' },
          abroad: false,
        },
      ]);
    });
  });

  it('r8: successors of Sud Sardegna and Milano type change, with types given as labels (golden-4, golden-5)', async () => {
    await withSources(async ({ situasInternal }) => {
      const sudSardegna = (
        await situasInternal.utsEventDetails({ originId: 126, utsType: 'province', actId: 6151, event: 'ES' })
      ).data;
      expect(sudSardegna.map((d) => [d.event, d.code, d.related?.code, d.related?.name, d.related?.type])).toEqual([
        ['ES', '111', '114', 'Nuoro', 'province'],
        ['ES', '111', '318', 'Cagliari', 'metropolitan_city'],
        ['ES', '111', '117', 'Medio Campidano', 'province'],
        ['ES', '111', '116', 'Ogliastra', 'province'],
        ['ES', '111', '119', 'Sulcis Iglesiente', 'province'],
      ]);

      const milano = (
        await situasInternal.utsEventDetails({ originId: 9, utsType: 'province', actId: 6029, event: 'ESCT' })
      ).data;
      expect(milano).toEqual([
        {
          event: 'ESCT',
          date: '2015-01-01',
          code: '015',
          name: 'Milano',
          type: 'province',
          regionCode: '03',
          related: { code: '215', name: 'Milano', type: 'metropolitan_city', regionCode: '03' },
          abroad: false,
        },
      ]);
    });
  });

  it('r7: an acquisition of territory from abroad (AQ with Stato estero, §3.5 item 15)', async () => {
    await withSources(async ({ situasInternal }) => {
      const lombardia = (
        await situasInternal.regionEventDetails({ originId: 1, regionType: 'compartment', actId: 3619, event: 'AQ' })
      ).data;
      expect(lombardia).toEqual([
        { event: 'AQ', date: '1866-11-20', code: '03', name: 'Lombardia', related: null, abroad: true },
      ]);
    });
  });

  it('r8: a blank associated UTS type only for a foreign state (Cuneo, 1947, §3.5 item 15)', async () => {
    await withSources(async ({ situasInternal }) => {
      const cuneo = (
        await situasInternal.utsEventDetails({ originId: 3, utsType: 'province', actId: 2410, event: 'CE' })
      ).data;
      expect(cuneo).toEqual([
        {
          event: 'CE',
          date: '1947-09-16',
          code: '004',
          name: 'Cuneo',
          type: 'province',
          regionCode: '01',
          related: null,
          abroad: true,
        },
      ]);
    });
    const domestic = {
      'Codice Compartimento/Regione': '01',
      'codice Provincia/Uts': '004',
      'Tipo Uts': 'Provincia',
      Denominazione: 'Cuneo',
      'data evento': '16/09/1947',
      'Codice Compartimento/Regione associato': '01',
      'Codice Provincia/Uts associato': '001',
      'Denominazione associata': 'Torino',
      'descrizione variazione': 'CE-Cessione territorio',
      'Tipo Uts associato': ' ',
    };
    await withSources(
      async ({ situasInternal }) => {
        await expect(
          situasInternal.utsEventDetails({ originId: 3, utsType: 'province', actId: 2410, event: 'CE' }),
        ).rejects.toBeInstanceOf(ResponseValidationError);
      },
      { transport: constant(doubleEncoded([domestic])) },
    );
  });

  it('r9: municipalities associated with Sassofeltrio events (golden-2)', async () => {
    await withSources(async ({ situasInternal }) => {
      const suppression = (await situasInternal.municipalityEventDetails({ originId: 4450, event: 'ES', actId: 4928 }))
        .data;
      expect(suppression.map((d) => [d.event, d.date, d.code, d.related?.code, d.related?.name])).toEqual([
        ['ES', '1929-05-14', '041060', '041035', 'Monte Grimano'],
        ['ES', '1929-05-14', '041060', '041026', 'Piandicastello'],
      ]);
      const reconstitution = (
        await situasInternal.municipalityEventDetails({ originId: 4450, event: 'CS', actId: 4949 })
      ).data;
      expect(reconstitution.map((d) => d.related?.name)).toEqual(['Monte Grimano', 'Mercatino Conca']);
    });
  });

  it('builds report URLs with the parameters of §3.3', () => {
    expect(reportUrls.utsEvents({ code: '312', name: 'Sassari', type: 'metropolitan_city' })).toBe(
      'var_get_ua_uts_lov_rs?&uts=Sassari&coduts=312&uts_tipo=3',
    );
    expect(reportUrls.regionEvents({ code: '02', name: "Valle d'Aosta/Vallée d'Aoste", type: 'region' })).toBe(
      "var_get_ua_reg_lov_rs?&codreg=02&reg=Valle d'Aosta/Vallée d'Aoste&reg_tipo=2",
    );
    expect(reportUrls.municipalityEventDetails({ originId: 4450, event: 'ES', actId: 4928 })).toBe(
      'var_get_ua_comuni_lov_rs_dett_ass?idcomuneorig=4450&mcrvar=ES&idprovv=4928',
    );
  });
});
