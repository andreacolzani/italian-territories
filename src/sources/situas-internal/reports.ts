/**
 * §3.3. Field names differ per report in casing and wording, so each is mapped explicitly (D29).
 * Internal reports accept every event code: whether a `(level, code)` pair means something is decided
 * by the variation builder. Non-empty responses are double-encoded JSON, empty ones `text/plain`.
 */
import { z } from 'zod';
import type { IsoDate } from '../../dates/index.ts';
import { CONTENT_TYPES, jsonRowsDecoder, type Endpoint } from '../../http/index.ts';
import type { IstatEventCode, RegionType, UtsType } from '../../model/common.ts';
import {
  describedEventCode,
  eventCode,
  integer,
  italianDate,
  optionalCode,
  optionalText,
  regionType,
  requiredCode,
  requiredText,
  utsType,
  utsTypeLabel,
  relatedTerritory,
  cleanText,
  FOREIGN_STATE_NAME,
  parseUtsTypeLabel,
} from '../normalise.ts';
import { INTERNAL_REPORTS, type InternalReportNumber } from './requests.ts';

/** r1. */
export interface RegionListRecord {
  code: string;
  name: string;
  type: RegionType;
  originId: number;
}

/** r2. */
export interface UtsListRecord {
  code: string;
  name: string;
  type: UtsType;
  originId: number;
}

/** r3. */
export interface MunicipalityListRecord {
  code: string;
  name: string;
}

interface InternalEventBase {
  event: IstatEventCode;
  date: IsoDate;
  /** At the time of the event (§3.3). */
  code: string;
  name: string;
  /** Today's name (`denominazione corrente`). */
  currentName: string;
  description: string | null;
  /** `identificativo provvedimento`. */
  actId: number;
}

/** r4. */
export interface InternalRegionEvent extends InternalEventBase {
  currentCode: string;
  type: RegionType;
  originId: number;
}

/** r5, per typed record (`id_uts`, §3.5 item 14). */
export interface InternalUtsEvent extends InternalEventBase {
  utsId: number;
  type: UtsType;
  originId: number;
}

/** r6. */
export interface InternalMunicipalityEvent extends InternalEventBase {
  currentCode: string;
  originId: number;
}

/** r7. */
export interface RegionEventDetail {
  event: IstatEventCode;
  date: IsoDate;
  code: string;
  name: string;
  abroad: boolean;
  related: { code: string | null; name: string | null } | null;
}

/** r8. */
export interface UtsEventDetail {
  event: IstatEventCode;
  date: IsoDate;
  code: string;
  name: string;
  type: UtsType;
  regionCode: string;
  abroad: boolean;
  related: { code: string | null; name: string | null; type: UtsType | null; regionCode: string | null } | null;
}

/** r9. */
export interface MunicipalityEventDetail {
  event: IstatEventCode;
  date: IsoDate;
  code: string;
  name: string;
  utsCode: string;
  abroad: boolean;
  related: { code: string | null; name: string | null; utsCode: string | null } | null;
}

const positiveId = integer.pipe(z.int().positive());

const eventFields = {
  'tipo variazione': eventCode(),
  'data evento': italianDate,
  'codice Istat': z.unknown(),
  denominazione: requiredText,
  'denominazione corrente': requiredText,
  'descrizione evento': optionalText,
  'identificativo provvedimento': positiveId,
};

function eventBase(r: z.output<z.ZodObject<typeof eventFields>>): Omit<InternalEventBase, 'code'> {
  return {
    event: r['tipo variazione'],
    date: r['data evento'],
    name: r.denominazione,
    currentName: r['denominazione corrente'],
    description: r['descrizione evento'],
    actId: r['identificativo provvedimento'],
  };
}

const regionList = z
  .object({
    cod_regione: requiredCode(2),
    'denominazione regione': requiredText,
    'tipo regione': regionType,
    id_regione_origine: positiveId,
  })
  .transform((r): RegionListRecord => ({
    code: r.cod_regione,
    name: r['denominazione regione'],
    type: r['tipo regione'],
    originId: r.id_regione_origine,
  }));

const utsList = z
  .object({
    cod_uts: requiredCode(3),
    denominazione_uts: requiredText,
    'tipo uts': utsType,
    id_uts_origine: positiveId,
  })
  .transform((r): UtsListRecord => ({
    code: r.cod_uts,
    name: r.denominazione_uts,
    type: r['tipo uts'],
    originId: r.id_uts_origine,
  }));

const municipalityList = z
  .object({ pro_com_t: requiredCode(6), comune: requiredText })
  .transform((r): MunicipalityListRecord => ({ code: r.pro_com_t, name: r.comune }));

const regionEvents = z
  .object({
    ...eventFields,
    'codice Istat': requiredCode(2),
    // The report names the current region code `codice uts corrente`.
    'codice uts corrente': requiredCode(2),
    'tipo reg': regionType,
    id_regione_origine: positiveId,
  })
  .transform((r): InternalRegionEvent => ({
    ...eventBase(r),
    code: r['codice Istat'],
    currentCode: r['codice uts corrente'],
    type: r['tipo reg'],
    originId: r.id_regione_origine,
  }));

const utsEvents = z
  .object({
    ...eventFields,
    'codice Istat': requiredCode(3),
    id_uts: positiveId,
    'tipo uts': utsType,
    id_uts_origine: positiveId,
  })
  .transform((r): InternalUtsEvent => ({
    ...eventBase(r),
    code: r['codice Istat'],
    utsId: r.id_uts,
    type: r['tipo uts'],
    originId: r.id_uts_origine,
  }));

const municipalityEvents = z
  .object({
    ...eventFields,
    'codice Istat': requiredCode(6),
    'codice comune corrente': requiredCode(6),
    id_comune_origine: positiveId,
  })
  .transform((r): InternalMunicipalityEvent => ({
    ...eventBase(r),
    code: r['codice Istat'],
    currentCode: r['codice comune corrente'],
    originId: r.id_comune_origine,
  }));

const regionEventDetails = z
  .object({
    'descrizione variazione': describedEventCode(),
    'Data evento': italianDate,
    'Codice Compartimento/Regione': requiredCode(2),
    Denominazione: requiredText,
    CodCompRegAss: optionalCode(2),
    'Denominazione associata': optionalText,
  })
  .transform((r, ctx): RegionEventDetail => ({
    event: r['descrizione variazione'],
    date: r['Data evento'],
    code: r['Codice Compartimento/Regione'],
    name: r.Denominazione,
    ...relatedTerritory(
      r['descrizione variazione'],
      { code: r.CodCompRegAss, name: r['Denominazione associata'] },
      ctx,
    ),
  }));

const utsEventDetails = z
  .object({
    'descrizione variazione': describedEventCode(),
    'data evento': italianDate,
    'codice Provincia/Uts': requiredCode(3),
    Denominazione: requiredText,
    'Tipo Uts': utsTypeLabel,
    'Codice Compartimento/Regione': requiredCode(2),
    'Codice Provincia/Uts associato': optionalCode(3),
    'Denominazione associata': optionalText,
    // Blank only when the associated territory is a foreign state (checked below, §3.5 item 15).
    'Tipo Uts associato': z.string().nullish(),
    'Codice Compartimento/Regione associato': optionalCode(2),
  })
  .transform((r, ctx): UtsEventDetail => ({
    event: r['descrizione variazione'],
    date: r['data evento'],
    code: r['codice Provincia/Uts'],
    name: r.Denominazione,
    type: r['Tipo Uts'],
    regionCode: r['Codice Compartimento/Regione'],
    ...relatedTerritory(
      r['descrizione variazione'],
      {
        code: r['Codice Provincia/Uts associato'],
        name: r['Denominazione associata'],
        type: relatedUtsType(r['Tipo Uts associato'], r['Denominazione associata'], ctx),
        regionCode: r['Codice Compartimento/Regione associato'],
      },
      ctx,
    ),
  }));

/**
 * `Tipo Uts associato`: a label, or blank when the associated territory is a foreign state (verified:
 * Cuneo, `CE` of 1947-09-16, act 2410). A blank label of any other territory is a schema violation.
 */
function relatedUtsType(
  label: string | null | undefined,
  name: string | null,
  ctx: z.core.$RefinementCtx,
): UtsType | null {
  if (label == null) return null;
  if (cleanText(label) !== null) return parseUtsTypeLabel(label, ctx);
  if (name?.toLowerCase() === FOREIGN_STATE_NAME.toLowerCase()) return null;
  ctx.addIssue({ code: 'custom', message: `blank UTS type label for the associated territory '${name ?? ''}'` });
  return z.NEVER;
}

const municipalityEventDetails = z
  .object({
    'tipo variazione': eventCode(),
    'data evento': italianDate,
    'codice Comune': requiredCode(6),
    Comune: requiredText,
    'codice Provincia/Uts': requiredCode(3),
    'codice Comune associato': optionalCode(6),
    'denominazione associata': optionalText,
    'codice Provincia/Uts associato': optionalCode(3),
  })
  .transform((r, ctx): MunicipalityEventDetail => ({
    event: r['tipo variazione'],
    date: r['data evento'],
    code: r['codice Comune'],
    name: r.Comune,
    utsCode: r['codice Provincia/Uts'],
    ...relatedTerritory(
      r['tipo variazione'],
      {
        code: r['codice Comune associato'],
        name: r['denominazione associata'],
        utsCode: r['codice Provincia/Uts associato'],
      },
      ctx,
    ),
  }));

function endpoint<T>(n: InternalReportNumber, row: z.ZodType<T>, nonEmpty: boolean): Endpoint<T[]> {
  return {
    id: INTERNAL_REPORTS[n].endpoint,
    family: 'situas-internal',
    timeoutClass: 'default',
    decode: jsonRowsDecoder({ contentTypes: CONTENT_TYPES.situasInternal, envelope: 'items', nonEmpty, row }),
  };
}

/** An empty event list of a listed record is a crawl anomaly, not a transport problem. */
export const INTERNAL_ENDPOINTS = {
  regionList: endpoint(1, regionList, true),
  utsList: endpoint(2, utsList, true),
  municipalityList: endpoint(3, municipalityList, true),
  regionEvents: endpoint(4, regionEvents, false),
  utsEvents: endpoint(5, utsEvents, false),
  municipalityEvents: endpoint(6, municipalityEvents, false),
  regionEventDetails: endpoint(7, regionEventDetails, false),
  utsEventDetails: endpoint(8, utsEventDetails, false),
  municipalityEventDetails: endpoint(9, municipalityEventDetails, false),
};
