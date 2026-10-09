import { describe, expect, it } from 'vitest';
import {
  ISTAT_EVENT_CODES,
  PARTICIPANT_ROLES,
  participantRoleViolations,
  regionTypeFromIstat,
  utsTypeFromIstat,
} from '../../src/model/common.ts';
import {
  entityLinkSchema,
  municipalitySchema,
  provinceVersionSchema,
  regionVersionSchema,
} from '../../src/model/public.ts';
import {
  anomaliesFileSchema,
  anomalySchema,
  participantSchema,
  variationLinkSchema,
  variationSchema,
} from '../../src/model/reports.ts';

/** §4.4, verbatim. */
const siamanna = {
  id: 'mun-WJG7J5',
  status: 'active',
  is_former_italian: false,
  predecessors: [{ id: 'mun-3Z4B94', kind: 'detached_into', date: '1947-11-28' }],
  successors: [],
  current_successors: [],
  versions: [
    {
      valid_from: '1947-11-28',
      valid_until: '1974-08-19',
      istat_code: '092128',
      cadastral_code: 'I719',
      official_name: 'Siamanna-Siapiccia',
      italian_name: 'Siamanna-Siapiccia',
      foreign_name: null,
      province_id: 'prv-2KA4XZ',
      region_id: 'reg-0W14C8',
    },
    {
      valid_from: '1974-08-20',
      valid_until: '1974-09-12',
      istat_code: '095057',
      cadastral_code: 'I719',
      official_name: 'Siamanna-Siapiccia',
      italian_name: 'Siamanna-Siapiccia',
      foreign_name: null,
      province_id: 'prv-ZY50X3',
      region_id: 'reg-0W14C8',
    },
    {
      valid_from: '1974-09-13',
      valid_until: '2025-12-31',
      istat_code: '095057',
      cadastral_code: 'I718',
      official_name: 'Siamanna',
      italian_name: 'Siamanna',
      foreign_name: null,
      province_id: 'prv-ZY50X3',
      region_id: 'reg-0W14C8',
    },
    {
      valid_from: '2026-01-01',
      valid_until: null,
      istat_code: '115064',
      cadastral_code: 'I718',
      official_name: 'Siamanna',
      italian_name: 'Siamanna',
      foreign_name: null,
      province_id: 'prv-ZY50X3',
      region_id: 'reg-0W14C8',
    },
  ],
};

/** §4.3, with the description completed. */
const sassari2026 = {
  id: 1843,
  date: '2026-01-01',
  istat_act_id: 6151,
  origin: 'istat',
  description: "ISTITUITE LA CITTA' METROPOLITANA DI SASSARI",
  participants: [
    {
      level: 'province',
      territory_id: 'prv-K2M8VT',
      istat_events: ['RN', 'AQES', 'CECS'],
      abroad: false,
      role: 'changed',
      version_before: '1974-08-20',
      version_after: '2026-01-01',
    },
    {
      level: 'province',
      territory_id: 'prv-8ZQ1KD',
      istat_events: ['CS'],
      abroad: false,
      role: 'established',
      version_before: null,
      version_after: '2026-01-01',
    },
    {
      level: 'municipality',
      territory_id: 'mun-WJG7J5',
      istat_events: ['RN'],
      abroad: false,
      role: 'changed',
      version_before: '1974-09-13',
      version_after: '2026-01-01',
    },
  ],
  links: [{ level: 'province', from: 'prv-1D7R3M', to: 'prv-8ZQ1KD', kind: 'merged_into' }],
};

const bolzano = {
  valid_from: '1927-01-12',
  valid_until: null,
  istat_code: '021',
  official_name: 'Bolzano/Bozen',
  italian_name: 'Bolzano',
  foreign_name: 'Bozen',
  type: 'autonomous_province',
  abbreviation: 'BZ',
  region_id: 'reg-000004',
};

describe('vocabulary', () => {
  it('maps ISTAT numeric types', () => {
    expect([1, 2, 3, 4, 5].map(utsTypeFromIstat)).toEqual([
      'province',
      'autonomous_province',
      'metropolitan_city',
      'free_municipal_consortium',
      'non_administrative_unit',
    ]);
    expect([1, 2].map(regionTypeFromIstat)).toEqual(['compartment', 'region']);
    for (const bad of [0, 6, 1.5, Number.NaN]) expect(() => utsTypeFromIstat(bad)).toThrow(RangeError);
    for (const bad of [0, 3]) expect(() => regionTypeFromIstat(bad)).toThrow(RangeError);
  });

  it('lists every ISTAT event code of §2', () => {
    expect(ISTAT_EVENT_CODES).toHaveLength(18);
  });
});

describe('public entity models (§4.2)', () => {
  it('accepts the §4.4 example', () => {
    expect(municipalitySchema.parse(siamanna)).toEqual(siamanna);
  });

  it('preserves the published key order', () => {
    const parsed = municipalitySchema.parse(siamanna);
    expect(Object.keys(parsed)).toEqual(Object.keys(siamanna));
    expect(Object.keys(parsed.versions[0] ?? {})).toEqual(Object.keys(siamanna.versions[0] ?? {}));
  });

  it('accepts bilingual UTS names and one-day versions', () => {
    expect(provinceVersionSchema.safeParse(bolzano).success).toBe(true);
    expect(provinceVersionSchema.safeParse({ ...bolzano, valid_until: '1927-01-12' }).success).toBe(true);
  });

  it.each([
    ['inverted interval', { valid_until: '1927-01-11' }],
    ['non-existent date', { valid_from: '1927-02-29' }],
    ['abbreviation too long (Venezia Giulia before override)', { abbreviation: 'Venezia Giulia' }],
    ['lowercase abbreviation', { abbreviation: 'bz' }],
    ['null abbreviation', { abbreviation: null }],
    ['2-digit UTS code', { istat_code: '21' }],
    ['unknown type', { type: 'county' }],
    ['untrimmed name', { italian_name: 'Bolzano ' }],
    ['empty name', { official_name: '' }],
    ['non-NFC name (decomposed e + U+0301)', { foreign_name: 'Bre' + String.fromCharCode(0x301) }],
    ['numeric id', { region_id: 4 }],
    ['id of another level', { region_id: 'prv-000004' }],
    ['version id', { id: 1 }],
    ['unknown key', { cod_prov_storico: '021' }],
  ])('rejects a UTS version with %s', (_, patch) => {
    expect(provinceVersionSchema.safeParse({ ...bolzano, ...patch }).success).toBe(false);
  });

  it('validates municipality codes', () => {
    const version = siamanna.versions[0];
    const municipality = (patch: object) => ({ ...siamanna, versions: [{ ...version, ...patch }] });
    expect(municipalitySchema.safeParse(municipality({ cadastral_code: null })).success).toBe(true);
    expect(municipalitySchema.safeParse(municipality({ cadastral_code: 'ND' })).success).toBe(false);
    expect(municipalitySchema.safeParse(municipality({ istat_code: '95057' })).success).toBe(false);
    expect(municipalitySchema.safeParse({ ...siamanna, versions: [] }).success).toBe(false);
  });

  it('validates region versions', () => {
    const piemonte = {
      valid_from: '1861-03-17',
      valid_until: '1947-12-31',
      istat_code: '01',
      official_name: 'Piemonte',
      italian_name: 'Piemonte',
      foreign_name: null,
      type: 'compartment',
    };
    expect(regionVersionSchema.safeParse(piemonte).success).toBe(true);
    expect(regionVersionSchema.safeParse({ ...piemonte, istat_code: '1' }).success).toBe(false);
  });

  it('requires current_successors sorted and unique', () => {
    expect(
      municipalitySchema.safeParse({ ...siamanna, current_successors: ['mun-000003', 'mun-000007'] }).success,
    ).toBe(true);
    expect(
      municipalitySchema.safeParse({ ...siamanna, current_successors: ['mun-000007', 'mun-000003'] }).success,
    ).toBe(false);
    expect(
      municipalitySchema.safeParse({ ...siamanna, current_successors: ['mun-000003', 'mun-000003'] }).success,
    ).toBe(false);
  });

  it('validates entity links', () => {
    const link = { id: 'mun-000005', kind: 'split_into', date: '2024-01-22' };
    expect(entityLinkSchema.safeParse(link).success).toBe(true);
    expect(entityLinkSchema.safeParse({ ...link, kind: 'annexed' }).success).toBe(false);
    expect(entityLinkSchema.safeParse({ ...link, kind: 'transferred_to' }).success).toBe(false);
    expect(entityLinkSchema.safeParse({ ...link, variation_id: 9 }).success).toBe(false);
  });

  it('has no partially_ceded field', () => {
    expect(municipalitySchema.safeParse({ ...siamanna, partially_ceded: false }).success).toBe(false);
  });
});

describe('variation report model (§4.3)', () => {
  it('accepts the §4.3 example', () => {
    expect(variationSchema.parse(sassari2026)).toEqual(sassari2026);
  });

  it('rejects inferred variations with an act id', () => {
    expect(variationSchema.safeParse({ ...sassari2026, origin: 'inferred' }).success).toBe(false);
    expect(variationSchema.safeParse({ ...sassari2026, origin: 'inferred', istat_act_id: null }).success).toBe(true);
  });

  it('rejects duplicated participants and links, and empty participant lists', () => {
    const [first] = sassari2026.participants;
    expect(variationSchema.safeParse({ ...sassari2026, participants: [first, first] }).success).toBe(false);
    const [link] = sassari2026.links;
    expect(
      variationSchema.safeParse({ ...sassari2026, links: [link, { ...link, kind: 'detached_into' }] }).success,
    ).toBe(false);
    expect(variationSchema.safeParse({ ...sassari2026, participants: [] }).success).toBe(false);
  });

  it('allows abroad only with an AS, AN, CE or AQ event (golden-18)', () => {
    const gorizia = {
      level: 'municipality',
      territory_id: 'mun-000007',
      istat_events: ['CE'],
      abroad: true,
      role: 'territory_changed',
      version_before: null,
      version_after: null,
    };
    expect(participantSchema.safeParse(gorizia).success).toBe(true);
    expect(participantSchema.safeParse({ ...gorizia, istat_events: ['AQ'] }).success).toBe(true);
    expect(participantSchema.safeParse({ ...gorizia, istat_events: ['AQES'] }).success).toBe(false);
    expect(participantSchema.safeParse({ ...gorizia, abroad: undefined }).success).toBe(false);
  });

  it('rejects self links', () => {
    expect(
      variationLinkSchema.safeParse({ level: 'region', from: 'reg-000003', to: 'reg-000003', kind: 'merged_into' })
        .success,
    ).toBe(false);
  });

  const date = (n: 1 | 2 | null) => (n === null ? null : n === 1 ? '1900-01-01' : '1950-01-01');
  const participant = (role: string, events: string[], before: 1 | 2 | null, after: 1 | 2 | null) => ({
    level: 'municipality',
    territory_id: 'mun-000001',
    istat_events: events,
    abroad: false,
    role,
    version_before: date(before),
    version_after: date(after),
  });

  it.each([
    ['established', ['CS'], null, 2],
    ['established', ['CSCT'], null, 2],
    ['annexed', ['AN'], null, 2],
    ['suppressed', ['ES'], 1, null],
    ['suppressed', ['ESCT', 'AQ'], 1, null],
    ['ceded', ['AS'], 1, null],
    ['changed', ['CD'], 1, 2],
    ['changed', ['RN', 'AQES', 'CECS'], 1, 2],
    ['territory_changed', ['AQ', 'CE'], null, null],
    ['indirect', [], 1, 2],
  ] as const)('accepts role %s with events %j', (role, events, before, after) => {
    expect(participantSchema.safeParse(participant(role, [...events], before, after)).success).toBe(true);
  });

  it.each([
    ['version before present', 'established', ['CS'], 1, 2],
    ['wrong event', 'established', ['AN'], null, 2],
    ['wrong event', 'annexed', ['CS'], null, 2],
    ['version after present', 'suppressed', ['ES'], 1, 2],
    ['wrong event', 'suppressed', ['AS'], 1, null],
    ['wrong event', 'ceded', ['ES'], 1, null],
    ['no own event', 'changed', [], 1, 2],
    ['version before missing', 'changed', ['CD'], null, 2],
    ['non-territorial event', 'territory_changed', ['CD'], null, null],
    ['no event', 'territory_changed', [], null, null],
    ['versions present', 'territory_changed', ['AQ'], 1, 2],
    ['own event', 'indirect', ['AP'], 1, 2],
    ['PV event', 'changed', ['PV'], 1, 2],
    ['repeated event', 'changed', ['CD', 'CD'], 1, 2],
  ] as const)('rejects %s (role %s, events %j)', (_reason, role, events, before, after) => {
    expect(participantSchema.safeParse(participant(role, [...events], before, after)).success).toBe(false);
  });

  it('describes each violation', () => {
    expect(
      participantRoleViolations({
        role: 'suppressed',
        istatEvents: ['CD'],
        versionBefore: null,
        versionAfter: '1950-01-01',
      }),
    ).toEqual([
      'role suppressed: version_before is required',
      'role suppressed: version_after is forbidden',
      'role suppressed: requires one of the events ES, ESCT',
    ]);
    for (const role of PARTICIPANT_ROLES) expect(typeof role).toBe('string');
  });
});

describe('anomalies (§8.2)', () => {
  const anomaly = {
    level: 'warning',
    code: 'anpr-unmatched-period',
    message: 'ANPR covers a period SITUAS does not',
    context: { entity_id: 10704, situas: '1947-11-28', anpr: '1947-12-13' },
  };

  it('accepts anomalies of every level internally', () => {
    expect(anomalySchema.safeParse({ ...anomaly, level: 'blocking' }).success).toBe(true);
    expect(anomalySchema.safeParse({ ...anomaly, code: 'Not Stable' }).success).toBe(false);
    expect(anomalySchema.safeParse({ ...anomaly, code: 'invariant-i8' }).success).toBe(true);
    expect(anomalySchema.safeParse({ ...anomaly, code: 'anpr.date_mismatch' }).success).toBe(false);
    expect(anomalySchema.safeParse({ ...anomaly, code: 'trailing-' }).success).toBe(false);
  });

  it('never publishes blocking anomalies', () => {
    expect(anomaliesFileSchema.safeParse([anomaly, { ...anomaly, level: 'info' }]).success).toBe(true);
    expect(anomaliesFileSchema.safeParse([{ ...anomaly, level: 'blocking' }]).success).toBe(false);
  });
});
