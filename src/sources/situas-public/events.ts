/**
 * Event list endpoints (§3.2): one per `pfun`, each with its own event code vocabulary (§6.2,
 * D21) and field mapping. Field differences between lists are mapped explicitly per endpoint:
 * pfun 100 carries the event code in `COD_VARIAZIONE_M`; pfun 104, 108 and 114 have no event
 * code column and are renames (`CD`) by definition (§3.5).
 *
 * `*_REL` fields identify the related territory (§3.5 item 6). A related foreign state
 * (`Stato estero`, no code) is allowed only for `AS`, `AN` and `CE`: it becomes `abroad: true`
 * with `related: null`, so it is never resolved and never produces links (§3.5 item 15).
 */
import { z } from 'zod';
import type { IsoDate } from '../../dates/index.ts';
import { CONTENT_TYPES, jsonRowsDecoder, type Endpoint } from '../../http/index.ts';
import type { IstatEventCode, Level, RegionType, UtsType } from '../../model/common.ts';
import {
  cadastralCode,
  eventCode,
  flag,
  optionalCode,
  optionalText,
  regionType,
  requiredCode,
  requiredText,
  timestampDate,
  utsType,
  relatedTerritory,
} from '../normalise.ts';
import { EVENT_LISTS, type EventListPfun, type EventListPfunOf } from './pfun.ts';

interface EventRowBase {
  event: IstatEventCode;
  /** `DATA_INIZIO_AMMINISTRATIVA`: first day of the new state. */
  date: IsoDate;
  /** `FLAG_ES_SCORPORO`: one row per successor of a multi-successor event. */
  multipleSuccessors: boolean;
}

export interface RegionEventRow extends EventRowBase {
  code: string;
  name: string;
  type: RegionType;
  /** The related territory is a foreign state (`AS`, `AN`, `CE`; §3.5 item 15). */
  abroad: boolean;
  related: { code: string | null; name: string | null; type: RegionType | null } | null;
}

export interface UtsEventRow extends EventRowBase {
  code: string;
  name: string;
  type: UtsType;
  /** `SIGLA_UTS` as reported (may be a full name, §3.5 item 12). */
  abbreviation: string | null;
  /** The related territory is a foreign state (`AS`, `AN`, `CE`; §3.5 item 15). */
  abroad: boolean;
  related: { code: string | null; name: string | null; abbreviation: string | null; type: UtsType | null } | null;
}

export interface MunicipalityEventRow extends EventRowBase {
  code: string;
  name: string;
  foreignName: string | null;
  cadastralCode: string | null;
  utsCode: string;
  utsAbbreviation: string | null;
  /** The related territory is a foreign state (`AS`, `AN`, `CE`; §3.5 item 15). */
  abroad: boolean;
  related: {
    code: string | null;
    name: string | null;
    foreignName: string | null;
    cadastralCode: string | null;
    utsCode: string | null;
    utsAbbreviation: string | null;
  } | null;
  /** `FLAG_CAMBIO_REGIONE` (pfun 105 only), else `null`. */
  regionChanged: boolean | null;
}

export interface EventRowByLevel {
  region: RegionEventRow;
  province: UtsEventRow;
  municipality: MunicipalityEventRow;
}

const date = { DATA_INIZIO_AMMINISTRATIVA: timestampDate, FLAG_ES_SCORPORO: flag };

/** Event code column of a list: present (`COD_VARIAZIONE` or `COD_VARIAZIONE_M`) or implied `CD`. */
type CodeColumn = 'COD_VARIAZIONE' | 'COD_VARIAZIONE_M' | null;

function codeField(pfun: EventListPfun, column: CodeColumn) {
  const allowed: readonly IstatEventCode[] = EVENT_LISTS[pfun].events;
  return column === null ? {} : { [column]: eventCode(allowed) };
}

function eventOf(row: Record<string, unknown>, column: CodeColumn): IstatEventCode {
  return column === null ? 'CD' : (row[column] as IstatEventCode);
}

function regionRow(pfun: EventListPfunOf<'region'>, column: CodeColumn) {
  return z
    .object({
      ...codeField(pfun, column),
      ...date,
      COD_COMP_REG: requiredCode(2),
      DEN_COMP_REG: requiredText,
      TIPO_COMP_REG: regionType,
      COD_COMP_REG_REL: optionalCode(2),
      DEN_COMP_REG_REL: optionalText,
      TIPO_COMP_REG_REL: regionType.nullish(),
    })
    .transform((r, ctx): RegionEventRow => ({
      event: eventOf(r, column),
      date: r.DATA_INIZIO_AMMINISTRATIVA,
      multipleSuccessors: r.FLAG_ES_SCORPORO,
      code: r.COD_COMP_REG,
      name: r.DEN_COMP_REG,
      type: r.TIPO_COMP_REG,
      ...relatedTerritory(
        eventOf(r, column),
        {
          code: r.COD_COMP_REG_REL,
          name: r.DEN_COMP_REG_REL,
          type: r.TIPO_COMP_REG_REL ?? null,
        },
        ctx,
      ),
    }));
}

function utsRow(pfun: EventListPfunOf<'province'>, column: CodeColumn) {
  return z
    .object({
      ...codeField(pfun, column),
      ...date,
      COD_UTS: requiredCode(3),
      DEN_UTS: requiredText,
      TIPO_UTS: utsType,
      SIGLA_UTS: optionalText,
      COD_UTS_REL: optionalCode(3),
      DEN_UTS_REL: optionalText,
      SIGLA_UTS_REL: optionalText,
      TIPO_UTS_REL: utsType.nullish(),
    })
    .transform((r, ctx): UtsEventRow => ({
      event: eventOf(r, column),
      date: r.DATA_INIZIO_AMMINISTRATIVA,
      multipleSuccessors: r.FLAG_ES_SCORPORO,
      code: r.COD_UTS,
      name: r.DEN_UTS,
      type: r.TIPO_UTS,
      abbreviation: r.SIGLA_UTS,
      ...relatedTerritory(
        eventOf(r, column),
        {
          code: r.COD_UTS_REL,
          name: r.DEN_UTS_REL,
          abbreviation: r.SIGLA_UTS_REL,
          type: r.TIPO_UTS_REL ?? null,
        },
        ctx,
      ),
    }));
}

function municipalityRow(pfun: EventListPfunOf<'municipality'>, column: CodeColumn) {
  return z
    .object({
      ...codeField(pfun, column),
      ...date,
      PRO_COM_T: requiredCode(6),
      COMUNE: requiredText,
      COMUNE_A: optionalText,
      COD_CATASTO: cadastralCode,
      COD_UTS: requiredCode(3),
      SIGLA_UTS: optionalText,
      PRO_COM_T_REL: optionalCode(6),
      COMUNE_REL: optionalText,
      COMUNE_A_REL: optionalText,
      COD_CATASTO_REL: cadastralCode,
      COD_UTS_REL: optionalCode(3),
      SIGLA_UTS_REL: optionalText,
      FLAG_CAMBIO_REGIONE: flag.optional(),
    })
    .transform((r, ctx): MunicipalityEventRow => ({
      event: eventOf(r, column),
      date: r.DATA_INIZIO_AMMINISTRATIVA,
      multipleSuccessors: r.FLAG_ES_SCORPORO,
      code: r.PRO_COM_T,
      name: r.COMUNE,
      foreignName: r.COMUNE_A,
      cadastralCode: r.COD_CATASTO,
      utsCode: r.COD_UTS,
      utsAbbreviation: r.SIGLA_UTS,
      ...relatedTerritory(
        eventOf(r, column),
        {
          code: r.PRO_COM_T_REL,
          name: r.COMUNE_REL,
          foreignName: r.COMUNE_A_REL,
          cadastralCode: r.COD_CATASTO_REL,
          utsCode: r.COD_UTS_REL,
          utsAbbreviation: r.SIGLA_UTS_REL,
        },
        ctx,
      ),
      regionChanged: r.FLAG_CAMBIO_REGIONE ?? null,
    }));
}

/** Row schema per event list (§3.2), with its explicit event code column. */
const ROW_SCHEMAS: { [P in EventListPfun]: z.ZodType<EventRowByLevel[(typeof EVENT_LISTS)[P]['level']]> } = {
  106: regionRow(106, 'COD_VARIAZIONE'),
  107: regionRow(107, 'COD_VARIAZIONE'),
  108: regionRow(108, null),
  112: utsRow(112, 'COD_VARIAZIONE'),
  113: utsRow(113, 'COD_VARIAZIONE'),
  114: utsRow(114, null),
  98: municipalityRow(98, 'COD_VARIAZIONE'),
  100: municipalityRow(100, 'COD_VARIAZIONE_M'),
  103: municipalityRow(103, 'COD_VARIAZIONE'),
  104: municipalityRow(104, null),
  105: municipalityRow(105, 'COD_VARIAZIONE'),
};

const endpoints = new Map<EventListPfun, Endpoint<unknown>>();

/** Endpoint `events:pfun-<id>`. Event lists may legitimately be empty (short ranges). */
export function eventListEndpoint<P extends EventListPfun>(
  pfun: P,
): Endpoint<EventRowByLevel[(typeof EVENT_LISTS)[P]['level']][]> {
  let endpoint = endpoints.get(pfun);
  if (endpoint === undefined) {
    endpoint = {
      id: `events:pfun-${pfun}`,
      family: 'situas-public-reports',
      timeoutClass: 'default',
      decode: jsonRowsDecoder({
        contentTypes: CONTENT_TYPES.situasPublic,
        envelope: 'resultset',
        nonEmpty: false,
        row: ROW_SCHEMAS[pfun],
      }),
    };
    endpoints.set(pfun, endpoint);
  }
  return endpoint as Endpoint<EventRowByLevel[(typeof EVENT_LISTS)[P]['level']][]>;
}

/** Level of an event list `pfun`. */
export function eventListLevel(pfun: EventListPfun): Level {
  return EVENT_LISTS[pfun].level;
}
