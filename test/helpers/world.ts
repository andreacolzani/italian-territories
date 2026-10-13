/**
 * A declarative world for the end-to-end tests of the commands: a few regions, UTS and
 * municipalities with their intervals and events, and a transport that answers every request of
 * the pipeline from it, in the raw formats of the real sources:
 *
 * - SITUAS public snapshots (pfun 68/64/61, regime ≥ 1948 only: the world starts in 2000), event
 *   lists (pfun 100 with `COD_VARIAZIONE_M`, renames without an event code column) and counts;
 * - SITUAS internal reports r1–r6, double-encoded JSON, and the `text/plain` empty body;
 * - the ANPR archive CSV (CRLF, quoted).
 *
 * Field sets are taken from real rows (`test/unit/world-formats.test.ts` checks them against the
 * fixtures and decodes them with the production adapters). The scenarios of the tests change the
 * world between two runs; `failing` makes requests fail.
 */
import { compareDates, previousDay, type IsoDate } from '../../src/dates/index.ts';
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from '../../src/http/index.ts';

export interface WorldRegion {
  originId: number;
  code: string;
  name: string;
  /** Ripartizione (geographic area): code and name, unpublished. */
  area: [number, string];
}

export interface WorldUts {
  utsId: number;
  originId: number;
  code: string;
  name: string;
  /** ISTAT type: 1 province, 3 metropolitan city. */
  type: 1 | 3;
  /** `SIGLA_AUTOMOBILISTICA` as SITUAS reports it (may need an override). */
  abbreviation: string;
  regionCode: string;
}

/** One interval of a municipality; an entity (`originId`) may have several. */
export interface WorldMunicipality {
  originId: number;
  code: string;
  name: string;
  /** `null` is served as `ND`. */
  cadastral: string | null;
  utsCode: string;
  from: IsoDate;
  /** Half-open end; `null` while it exists. */
  to: IsoDate | null;
}

/** A fusion: `from` municipalities (codes) suppressed on `date`, merged into the new `into`. */
export interface WorldFusion {
  date: IsoDate;
  actId: number;
  description: string;
  from: string[];
  into: string;
}

/** A rename on `date` of the municipality `code` (pfun 104, internal `CD`). */
export interface WorldRename {
  date: IsoDate;
  actId: number;
  code: string;
  from: string;
  to: string;
}

export interface World {
  /** `dates.start` of the runs. */
  start: IsoDate;
  regions: WorldRegion[];
  uts: WorldUts[];
  municipalities: WorldMunicipality[];
  fusions: WorldFusion[];
  renames: WorldRename[];
}

/** First-validity act of the synthetic records (`PV` on `start`). */
const PV_ACT = 1;

/**
 * Veneto (Belluno, Padova) and Sardegna (Sassari, Nuoro) from 2000-01-01: the Quero Vas fusion
 * (2013-12-28), a rename (Abano → Abano Terme, 2005-03-01), a municipality without cadastral code
 * (served as `ND`), and Nuoro's abbreviation reported as a full name (corrected by an override).
 */
export function baseWorld(): World {
  const start = '2000-01-01';
  const m = (
    originId: number,
    code: string,
    name: string,
    cadastral: string | null,
    from: IsoDate = start,
    to: IsoDate | null = null,
  ): WorldMunicipality => ({ originId, code, name, cadastral, utsCode: code.slice(0, 3), from, to });
  return {
    start,
    regions: [
      { originId: 9, code: '05', name: 'Veneto', area: [2, 'Nord-est'] },
      { originId: 23, code: '20', name: 'Sardegna', area: [5, 'Isole'] },
    ],
    uts: [
      { utsId: 25, originId: 25, code: '025', name: 'Belluno', type: 1, abbreviation: 'BL', regionCode: '05' },
      { utsId: 28, originId: 28, code: '028', name: 'Padova', type: 1, abbreviation: 'PD', regionCode: '05' },
      { utsId: 58, originId: 58, code: '090', name: 'Sassari', type: 1, abbreviation: 'SS', regionCode: '20' },
      { utsId: 59, originId: 59, code: '091', name: 'Nuoro', type: 1, abbreviation: 'Nuoro', regionCode: '20' },
    ],
    municipalities: [
      m(8000, '025002', 'Alano di Piave', 'A121'),
      m(8037, '025042', 'Quero', 'H124', start, '2013-12-28'),
      m(8059, '025064', 'Vas', 'L692', start, '2013-12-28'),
      m(11188, '025070', 'Quero Vas', 'M332', '2013-12-28'),
      m(8100, '028001', 'Abano', 'A001', start, '2005-03-01'),
      m(8100, '028001', 'Abano Terme', 'A001', '2005-03-01'),
      m(8160, '028060', 'Padova', 'G224'),
      m(10003, '090003', 'Alghero', 'A192'),
      m(10064, '090064', 'Sassari', 'I452'),
      m(10151, '091051', 'Nuoro', 'F979'),
      m(10199, '091099', 'Villaggio Senza Catasto', null),
    ],
    fusions: [
      {
        date: '2013-12-28',
        actId: 5964,
        description:
          'NUOVO COMUNE DI QUERO VAS COSTITUITO MEDIANTE FUSIONE DEI COMUNI DI QUERO E VAS IN PROVINCIA DI BELLUNO',
        from: ['025042', '025064'],
        into: '025070',
      },
    ],
    renames: [{ date: '2005-03-01', actId: 4500, code: '028001', from: 'Abano', to: 'Abano Terme' }],
  };
}

/** Adds the Setteville fusion (Quero Vas + Alano di Piave) on `date`. */
export function withSettevilleFusion(world: World, date: IsoDate): World {
  const closed = world.municipalities.map((mu) =>
    (mu.code === '025070' || mu.code === '025002') && mu.to === null ? { ...mu, to: date } : mu,
  );
  return {
    ...world,
    municipalities: [
      ...closed,
      { originId: 11308, code: '025075', name: 'Setteville', cadastral: 'M437', utsCode: '025', from: date, to: null },
    ],
    fusions: [
      ...world.fusions,
      {
        date,
        actId: 6141,
        description:
          'ISTITUITO IL COMUNE DI SETTEVILLE MEDIANTE FUSIONE DEI SOPPRESSI COMUNI DI ALANO DI PIAVE E QUERO VAS, IN PROVINCIA DI BELLUNO',
        from: ['025070', '025002'],
        into: '025075',
      },
    ],
  };
}

/** Splits the open interval of `code` on `date` with another cadastral code, without any event. */
export function withSilentCadastralChange(world: World, code: string, date: IsoDate, cadastral: string): World {
  return {
    ...world,
    municipalities: world.municipalities.flatMap((mu) =>
      mu.code === code && mu.to === null
        ? [
            { ...mu, to: date },
            { ...mu, from: date, cadastral },
          ]
        : [mu],
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Raw rows
// ---------------------------------------------------------------------------------------------

const within = (from: IsoDate, to: IsoDate | null, date: IsoDate) =>
  compareDates(from, date) <= 0 && (to === null || compareDates(date, to) < 0);

const timestamp = (date: IsoDate) => `${date}T00:00:00Z`;
const italian = (date: IsoDate) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
const fiscal = (seed: string) => `8${seed.padStart(10, '0')}`;

function regionOf(world: World, code: string): WorldRegion {
  const found = world.regions.find((r) => r.code === code);
  if (found === undefined) throw new Error(`world: no region ${code}`);
  return found;
}

function utsOf(world: World, code: string): WorldUts {
  const found = world.uts.find((u) => u.code === code);
  if (found === undefined) throw new Error(`world: no UTS ${code}`);
  return found;
}

function municipalityAt(world: World, code: string, date: IsoDate): WorldMunicipality {
  const found = world.municipalities.find((mu) => mu.code === code && within(mu.from, mu.to, date));
  if (found === undefined) throw new Error(`world: no municipality ${code} on ${date}`);
  return found;
}

export function regionSnapshotRows(world: World, date: IsoDate): Record<string, unknown>[] {
  if (compareDates(date, world.start) < 0) return [];
  return world.regions.map((r) => ({
    COD_RIP: r.area[0],
    COD_REG: r.code,
    DEN_REG: r.name,
    DEN_RIP: r.area[1],
    TIPO_REG: '1',
    DESC_TIPO_REG: 'Regione a Statuto ordinario',
    COD_REG_FISCALE: fiscal(r.code),
    COD_NUTS2_2024: `IT${r.code}`,
  }));
}

export function utsSnapshotRows(world: World, date: IsoDate): Record<string, unknown>[] {
  if (compareDates(date, world.start) < 0) return [];
  return world.uts.map((u) => {
    const region = regionOf(world, u.regionCode);
    return {
      COD_RIP: region.area[0],
      COD_REG: region.code,
      COD_PROV_STORICO: u.code,
      COD_UTS: u.code,
      DEN_UTS: u.name,
      DEN_RIP: region.area[1],
      DEN_REG: region.name,
      TIPO_UTS: u.type,
      DESC_TIPO_UTS: u.type === 1 ? 'Provincia' : 'Città metropolitana',
      SIGLA_AUTOMOBILISTICA: u.abbreviation,
      COD_PROV_FISCALE: fiscal(u.code),
      COD_NUTS3_2024: `IT${u.code}`,
    };
  });
}

export function municipalitySnapshotRows(world: World, date: IsoDate): Record<string, unknown>[] {
  return world.municipalities
    .filter((mu) => within(mu.from, mu.to, date))
    .map((mu) => {
      const uts = utsOf(world, mu.utsCode);
      const region = regionOf(world, uts.regionCode);
      return {
        COD_RIP: region.area[0],
        COD_REG: region.code,
        COD_PROV_STORICO: uts.code,
        COD_UTS: uts.code,
        PRO_COM_T: mu.code,
        PRO_COM: Number(mu.code),
        COMUNE: mu.name,
        COMUNE_IT: mu.name,
        DEN_RIP: region.area[1],
        DEN_REG: region.name,
        DEN_UTS: uts.name,
        TIPO_UTS: uts.type,
        CC_REG: 0,
        CC_UTS: 0,
        SIGLA_AUTOMOBILISTICA: uts.abbreviation,
        COD_CATASTO: mu.cadastral ?? 'ND',
        COD_COM_FISCALE: fiscal(mu.code),
        COM_NUTS1_2024: 'ITH',
        COM_NUTS2_2024: `IT${region.code}`,
        COM_NUTS3_2024: `IT${uts.code}`,
      };
    });
}

function municipalityFields(world: World, mu: WorldMunicipality) {
  return {
    SIGLA_UTS: utsOf(world, mu.utsCode).abbreviation,
    COD_UTS: mu.utsCode,
    PRO_COM_T: mu.code,
    COD_CATASTO: mu.cadastral ?? 'ND',
    COMUNE: mu.name,
  };
}

function relatedFields(world: World, mu: WorldMunicipality) {
  return {
    PRO_COM_T_REL: mu.code,
    COD_CATASTO_REL: mu.cadastral ?? 'ND',
    COMUNE_REL: mu.name,
    COD_UTS_REL: mu.utsCode,
    SIGLA_UTS_REL: utsOf(world, mu.utsCode).abbreviation,
  };
}

/** Rows of event list `pfun` dated in `[from, to]`. */
export function eventListRows(world: World, pfun: number, from: IsoDate, to: IsoDate): Record<string, unknown>[] {
  const inRange = (date: IsoDate) => compareDates(from, date) <= 0 && compareDates(date, to) <= 0;
  const rows: Record<string, unknown>[] = [];
  for (const fusion of world.fusions.filter((f) => inRange(f.date))) {
    const into = municipalityAt(world, fusion.into, fusion.date);
    for (const code of fusion.from) {
      const old = municipalityAt(world, code, previousDay(fusion.date));
      const { COMUNE, ...subject } = municipalityFields(world, old);
      if (pfun === 98) {
        rows.push({
          ANNO: fusion.date.slice(0, 4),
          ...subject,
          COMUNE,
          COD_VARIAZIONE: 'ES',
          DATA_INIZIO_AMMINISTRATIVA: timestamp(fusion.date),
          ...relatedFields(world, into),
        });
      }
      if (pfun === 100) {
        const { COMUNE: name, ...created } = municipalityFields(world, into);
        rows.push({
          ANNO: fusion.date.slice(0, 4),
          ...created,
          COMUNE: name,
          COD_VARIAZIONE_M: 'CS',
          DATA_INIZIO_AMMINISTRATIVA: timestamp(fusion.date),
          ...relatedFields(world, old),
        });
      }
    }
  }
  if (pfun === 104) {
    for (const rename of world.renames.filter((r) => inRange(r.date))) {
      const old = municipalityAt(world, rename.code, previousDay(rename.date));
      rows.push({
        ANNO: rename.date.slice(0, 4),
        SIGLA_UTS: utsOf(world, old.utsCode).abbreviation,
        COD_UTS: old.utsCode,
        PRO_COM_T: old.code,
        COMUNE: rename.from,
        DATA_INIZIO_AMMINISTRATIVA: timestamp(rename.date),
        COMUNE_REL: rename.to,
        PRO_COM_T_REL: old.code,
        COD_UTS_REL: old.utsCode,
        SIGLA_UTS_REL: utsOf(world, old.utsCode).abbreviation,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Internal reports
// ---------------------------------------------------------------------------------------------

export function regionListItems(world: World): Record<string, unknown>[] {
  return world.regions.map((r, i) => ({
    cod_regione: r.code,
    'denominazione regione': r.name,
    riga: i + 1,
    'descrizione tipo regione': 'Regione',
    'tipo regione': 2,
    id_regione_origine: r.originId,
  }));
}

export function utsListItems(world: World): Record<string, unknown>[] {
  return world.uts.map((u, i) => ({
    cod_uts: u.code,
    denominazione_uts: u.name,
    riga: i + 1,
    'descrizione tipo uts': u.type === 1 ? 'Provincia' : 'Città metropolitana',
    'tipo uts': u.type,
    id_uts_origine: u.originId,
  }));
}

/** Every `(code, name)` pair of a municipality ever. */
export function municipalityListItems(world: World): Record<string, unknown>[] {
  const pairs = new Map<string, { pro_com_t: string; comune: string }>();
  for (const mu of world.municipalities) pairs.set(`${mu.code}|${mu.name}`, { pro_com_t: mu.code, comune: mu.name });
  return [...pairs.values()].map((p, i) => ({ ...p, riga: i + 1 }));
}

export function regionEventItems(world: World, code: string): Record<string, unknown>[] {
  const r = world.regions.find((x) => x.code === code);
  if (r === undefined) return [];
  return [
    {
      'codice uts corrente': r.code,
      'denominazione corrente': r.name,
      'tipo variazione': 'PV',
      'data evento': italian(world.start),
      'codice Istat': r.code,
      denominazione: r.name,
      'descrizione evento': 'PRIMA VALIDITA',
      'identificativo provvedimento': PV_ACT,
      id_regione_origine: r.originId,
      'tipo reg': 2,
      variazione: 'PV-Prima validità',
    },
  ];
}

export function utsEventItems(world: World, code: string): Record<string, unknown>[] {
  const u = world.uts.find((x) => x.code === code);
  if (u === undefined) return [];
  return [
    {
      'denominazione corrente': u.name,
      'tipo variazione': 'PV',
      'data evento': italian(world.start),
      'codice Istat': u.code,
      denominazione: u.name,
      'descrizione evento': 'PRIMA VALIDITA',
      'identificativo provvedimento': PV_ACT,
      id_uts: u.utsId,
      'tipo uts': u.type,
      variazione: 'PV-Prima validità',
      id_uts_origine: u.originId,
    },
  ];
}

/** The full history of the municipality owning the pair `(code, name)` (r6). */
export function municipalityEventItems(world: World, code: string, name: string): Record<string, unknown>[] {
  const owner = world.municipalities.find((mu) => mu.code === code && mu.name === name);
  if (owner === undefined) return [];
  const intervals = world.municipalities
    .filter((mu) => mu.originId === owner.originId)
    .sort((a, b) => compareDates(a.from, b.from));
  const [first] = intervals;
  const last = intervals.at(-1);
  if (first === undefined || last === undefined) return [];
  const item = (
    event: string,
    label: string,
    date: IsoDate,
    at: WorldMunicipality,
    actId: number,
    description: string,
    order: number,
  ) => ({
    'codice comune corrente': last.code,
    'denominazione corrente': last.name,
    'tipo variazione': event,
    'data evento': italian(date),
    'codice Istat': at.code,
    denominazione: at.name,
    'descrizione evento': description,
    'identificativo provvedimento': actId,
    variazione: `${event}-${label}`,
    id_comune_origine: owner.originId,
    orderr: order,
  });
  const items: Record<string, unknown>[] = [];
  if (first.from === world.start) {
    items.push(item('PV', 'Prima validità', world.start, first, PV_ACT, 'PRIMA VALIDITA', 1));
  }
  for (const fusion of world.fusions) {
    if (fusion.into === first.code && fusion.date === first.from) {
      items.push(item('CS', 'Costituzione', fusion.date, first, fusion.actId, fusion.description, 2));
    }
    if (fusion.from.includes(last.code) && fusion.date === last.to) {
      items.push(item('ES', 'Estinzione', fusion.date, last, fusion.actId, fusion.description, 3));
    }
  }
  for (const rename of world.renames) {
    const at = intervals.find((i) => i.code === rename.code && i.from === rename.date);
    if (at !== undefined) {
      items.push(
        item(
          'CD',
          'Cambio denominazione',
          rename.date,
          at,
          rename.actId,
          `NUOVA DENOMINAZIONE ${rename.to.toUpperCase()}`,
          1,
        ),
      );
    }
  }
  return items.sort((a, b) => compareDates(isoOf(a['data evento']), isoOf(b['data evento'])));
}

function isoOf(italianDate: unknown): IsoDate {
  const [d, m, y] = String(italianDate).split('/');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------------------------
// ANPR
// ---------------------------------------------------------------------------------------------

export const ANPR_HEADER =
  '"ID","DATAISTITUZIONE","DATACESSAZIONE","CODISTAT","CODCATASTALE","DENOMINAZIONE_IT","DENOMTRASLITTERATA",' +
  '"ALTRADENOMINAZIONE","ALTRADENOMTRASLITTERATA","ID_PROVINCIA","IDPROVINCIAISTAT","IDREGIONE","IDPREFETTURA",' +
  '"STATO","SIGLAPROVINCIA","FONTE","DATAULTIMOAGG","COD_DENOM"';

/**
 * One row per maximal stretch of a municipality with the same code and name, with the cadastral
 * code of its last interval (ANPR does not split on a silent cadastral change).
 */
export function anprCsv(world: World): string {
  const lines = [ANPR_HEADER];
  const byEntity = new Map<number, WorldMunicipality[]>();
  for (const mu of world.municipalities) byEntity.set(mu.originId, [...(byEntity.get(mu.originId) ?? []), mu]);
  let id = 10000;
  for (const intervals of byEntity.values()) {
    const sorted = [...intervals].sort((a, b) => compareDates(a.from, b.from));
    const stretches: WorldMunicipality[][] = [];
    for (const mu of sorted) {
      const current = stretches.at(-1);
      const last = current?.at(-1);
      if (current !== undefined && last?.code === mu.code && last.name === mu.name && last.to === mu.from) {
        current.push(mu);
      } else stretches.push([mu]);
    }
    for (const stretch of stretches) {
      const [first] = stretch;
      const last = stretch.at(-1);
      if (first === undefined || last === undefined) continue;
      const uts = utsOf(world, last.utsCode);
      const name = last.name.toUpperCase();
      lines.push(
        [
          String(id++),
          q(first.from),
          q(last.to === null ? '9999-12-31' : previousDay(last.to)),
          q(last.code),
          q(last.cadastral ?? 'ND'),
          q(name),
          q(name),
          q(''),
          q(''),
          String(Number(uts.code)),
          q(uts.code),
          q(uts.regionCode),
          q(''),
          q(last.to === null ? 'A' : 'C'),
          // ANPR has the two-letter abbreviation where SITUAS reports a full name (cf. `VG`).
          q(/^[A-Z]{2}$/.test(uts.abbreviation) ? uts.abbreviation : uts.abbreviation.slice(0, 2).toUpperCase()),
          q(''),
          q('2020-01-01'),
          q(''),
        ].join(','),
      );
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

function q(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

export interface WorldTransport {
  transport: Transport;
  /** The world served from now on. */
  world: World;
  /** Makes every request fail at the connection (`NetworkError`), or only those `failing` matches. */
  failing: ((request: HttpRequest) => boolean) | null;
  /** Holds a request until the returned promise settles (e.g. to interrupt a run in the middle). */
  hold: ((request: HttpRequest) => Promise<void> | null) | null;
  /** Rewrites a response before it is served (e.g. to violate a schema). */
  patch: ((response: HttpResponse, request: HttpRequest) => HttpResponse) | null;
  /** Requests served, in order. */
  requests: HttpRequest[];
}

const json = (body: unknown, contentType = 'application/json; charset=utf-8'): HttpResponse => ({
  status: 200,
  headers: { 'content-type': contentType },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** Internal report body: double-encoded JSON, or the `text/plain` empty document. */
function internalBody(items: readonly Record<string, unknown>[]): HttpResponse {
  if (items.length === 0) return json('{\n"items":[\n]\n}', 'text/plain; charset=utf-8');
  return json(JSON.stringify(JSON.stringify({ items })));
}

function params(query: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    map.set(decodeURIComponent(part.slice(0, eq)), decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')));
  }
  return map;
}

function isoFromItalian(value: string | undefined): IsoDate {
  if (value === undefined) throw new Error('world transport: missing date');
  return isoOf(value);
}

/** Answers one request from `world` (throws on requests the pipeline should never send). */
export function respond(world: World, request: HttpRequest): HttpResponse {
  const [base = '', query = ''] = request.url.split('?');
  if (base.endsWith('/reportspooljson') || base.endsWith('/reportspooljsoncount')) {
    const p = params(query);
    const pfun = Number(p.get('pfun'));
    if (p.has('pdata')) {
      const date = isoFromItalian(p.get('pdata'));
      const rows =
        pfun === 68
          ? regionSnapshotRows(world, date)
          : pfun === 64
            ? utsSnapshotRows(world, date)
            : pfun === 61
              ? municipalitySnapshotRows(world, date)
              : (() => {
                  throw new Error(`world transport: snapshot pfun ${pfun} outside the world's regime`);
                })();
      return json({ resultset: base.endsWith('count') ? [{ NUM_ROWS: rows.length }] : rows });
    }
    const rows = eventListRows(world, pfun, isoFromItalian(p.get('pdatada')), isoFromItalian(p.get('pdataa')));
    return json({ resultset: base.endsWith('count') ? [{ NUM_ROWS: rows.length }] : rows });
  }
  if (base.endsWith('/ReportByUrl')) {
    const url = (request.body as { url?: unknown } | undefined)?.url;
    const reportUrl = typeof url === 'string' ? url : '';
    const [report = '', reportQuery = ''] = reportUrl.split('?');
    const p = params(reportQuery);
    switch (report) {
      case 'var_get_ua_reg_lov_diffusione':
        return internalBody(regionListItems(world));
      case 'var_get_ua_uts_lov_diffusione':
        return internalBody(utsListItems(world));
      case 'var_get_ua_comuni_lov_diffusione':
        return internalBody(municipalityListItems(world));
      case 'var_get_ua_reg_lov_rs':
        return internalBody(regionEventItems(world, p.get('codreg') ?? ''));
      case 'var_get_ua_uts_lov_rs':
        return internalBody(utsEventItems(world, p.get('coduts') ?? ''));
      case 'var_get_ua_comuni_lov_rs':
        return internalBody(municipalityEventItems(world, p.get('procom') ?? '', p.get('com') ?? ''));
      case 'var_get_ua_reg_lov_rs_dett_ass':
      case 'var_get_ua_uts_lov_rs_dett_ass':
        return internalBody([]);
      default:
        throw new Error(`world transport: unexpected internal report ${report}`);
    }
  }
  if (base.endsWith('.csv')) {
    return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' }, body: anprCsv(world) };
  }
  throw new Error(`world transport: unexpected request ${request.method} ${request.url}`);
}

export function worldTransport(world: World): WorldTransport {
  const state: WorldTransport = {
    world,
    failing: null,
    hold: null,
    patch: null,
    requests: [],
    transport: async (request) => {
      state.requests.push(request);
      const held = state.hold?.(request);
      if (held !== undefined && held !== null) await held;
      if (state.failing?.(request) === true) {
        throw new NetworkError('world transport: connection refused', { code: 'ECONNREFUSED' });
      }
      const response = respond(state.world, request);
      return state.patch === null ? response : state.patch(response, request);
    },
  };
  return state;
}
