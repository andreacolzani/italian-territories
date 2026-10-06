/**
 * Endpoints of the SITUAS internal reports 1–9 (§3.3), normalised (§6.2). Field names are
 * mapped explicitly per report (they differ in casing and wording, e.g. r4 calls the current
 * region code `codice uts corrente`; r7/r8 give the event only as `<code>-<label>` and r8 the UTS
 * type only as a label). Internal reports accept every event code of §2; whether a
 * `(level, code)` pair is meaningful is decided when building variations.
 *
 * Responses may be double-encoded JSON (non-empty) or plain JSON served as `text/plain`
 * (empty); `jsonRowsDecoder` handles both (§3.3).
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

/** r1: every region or compartment record ever. */
export interface RegionListRecord {
  code: string;
  name: string;
  type: RegionType;
  originId: number;
}

/** r2: every typed UTS record ever. */
export interface UtsListRecord {
  code: string;
  name: string;
  type: UtsType;
  originId: number;
}

/** r3: every `(code, name)` pair of a municipality ever. */
export interface MunicipalityListRecord {
  code: string;
  name: string;
}

interface InternalEventBase {
  event: IstatEventCode;
  date: IsoDate;
  /** Code and name at the time of the event (§3.3). */
  code: string;
  name: string;
  /** Name of the record today (`denominazione corrente`). */
  currentName: string;
  description: string | null;
  /** `identificativo provvedimento`. */
  actId: number;
}

/** r4: event of a region record. */
export interface InternalRegionEvent extends InternalEventBase {
  currentCode: string;
  type: RegionType;
  originId: number;
}

/** r5: event of a typed UTS record (`id_uts`, §3.5 item 14). */
export interface InternalUtsEvent extends InternalEventBase {
  utsId: number;
  type: UtsType;
  originId: number;
}

/** r6: event of a municipality. */
export interface InternalMunicipalityEvent extends InternalEventBase {
  currentCode: string;
  originId: number;
}

/** r7: an associated territory of a region event. */
export interface RegionEventDetail {
  event: IstatEventCode;
  date: IsoDate;
  code: string;
  name: string;
  /** The related territory is a foreign state (`AS`, `AN`, `CE`, `AQ`; §3.5 item 15). */
  abroad: boolean;
  related: { code: string | null; name: string | null } | null;
}

/** r8: an associated territory of a UTS event. */
export interface UtsEventDetail {
  event: IstatEventCode;
  date: IsoDate;
  code: string;
  name: string;
  type: UtsType;
  regionCode: string;
  /** The related territory is a foreign state (`AS`, `AN`, `CE`, `AQ`; §3.5 item 15). */
  abroad: boolean;
  related: { code: string | null; name: string | null; type: UtsType | null; regionCode: string | null } | null;
}

/** r9: an associated territory of a municipality event. */
export interface MunicipalityEventDetail {
  event: IstatEventCode;
  date: IsoDate;
  code: string;
  name: string;
  utsCode: string;
  /** The related territory is a foreign state (`AS`, `AN`, `CE`, `AQ`; §3.5 item 15). */
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

/**
 * Endpoints r1–r9. Lists (r1–r3) are never empty; event and detail reports may be (an empty
 * event list for a listed record is a crawl anomaly, not a transport problem).
 */
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
