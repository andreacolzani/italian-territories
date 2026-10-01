/**
 * SITUAS internal reports 1–9 (§3.3): report URLs and `ReportByUrl` requests. Report URLs are
 * built unencoded (§11.1); the HTTP client encodes the URL inside the body.
 */
import type { HttpRequest } from '../../http/index.ts';
import {
  regionTypeToIstat,
  utsTypeToIstat,
  type IstatEventCode,
  type RegionType,
  type UtsType,
} from '../../model/common.ts';

/** Report number → report name and endpoint id (§3.3, §11.1). */
export const INTERNAL_REPORTS = {
  1: { report: 'var_get_ua_reg_lov_diffusione', endpoint: 'r1:region-list' },
  2: { report: 'var_get_ua_uts_lov_diffusione', endpoint: 'r2:uts-list' },
  3: { report: 'var_get_ua_comuni_lov_diffusione', endpoint: 'r3:municipality-list' },
  4: { report: 'var_get_ua_reg_lov_rs', endpoint: 'r4:region-events' },
  5: { report: 'var_get_ua_uts_lov_rs', endpoint: 'r5:uts-events' },
  6: { report: 'var_get_ua_comuni_lov_rs', endpoint: 'r6:municipality-events' },
  7: { report: 'var_get_ua_reg_lov_rs_dett_ass', endpoint: 'r7:region-event-details' },
  8: { report: 'var_get_ua_uts_lov_rs_dett_ass', endpoint: 'r8:uts-event-details' },
  9: { report: 'var_get_ua_comuni_lov_rs_dett_ass', endpoint: 'r9:municipality-event-details' },
} as const;

export type InternalReportNumber = keyof typeof INTERNAL_REPORTS;

/** A typed region record as listed by r1 (`codreg`, `reg`, `reg_tipo`). */
export interface RegionRecordQuery {
  code: string;
  name: string;
  type: RegionType;
}

/** A typed UTS record as listed by r2 (`coduts`, `uts`, `uts_tipo`). */
export interface UtsRecordQuery {
  code: string;
  name: string;
  type: UtsType;
}

/** A historical `(pro_com_t, comune)` pair of a municipality. */
export interface MunicipalityRecordQuery {
  code: string;
  name: string;
}

export interface RegionEventQuery {
  originId: number;
  regionType: RegionType;
  actId: number;
  event: IstatEventCode;
}

export interface UtsEventQuery {
  originId: number;
  utsType: UtsType;
  actId: number;
  event: IstatEventCode;
}

export interface MunicipalityEventQuery {
  originId: number;
  actId: number;
  event: IstatEventCode;
}

/** Report URLs, with parameters in the order of §3.3. */
export const reportUrls = {
  regionList: (): string => `${INTERNAL_REPORTS[1].report}?reg=`,
  utsList: (): string => `${INTERNAL_REPORTS[2].report}?uts=`,
  municipalityList: (): string => `${INTERNAL_REPORTS[3].report}?com=`,
  regionEvents: (q: RegionRecordQuery): string =>
    `${INTERNAL_REPORTS[4].report}?&codreg=${q.code}&reg=${q.name}&reg_tipo=${regionTypeToIstat(q.type)}`,
  utsEvents: (q: UtsRecordQuery): string =>
    `${INTERNAL_REPORTS[5].report}?&uts=${q.name}&coduts=${q.code}&uts_tipo=${utsTypeToIstat(q.type)}`,
  municipalityEvents: (q: MunicipalityRecordQuery): string =>
    `${INTERNAL_REPORTS[6].report}?procom=${q.code}&com=${q.name}`,
  regionEventDetails: (q: RegionEventQuery): string =>
    `${INTERNAL_REPORTS[7].report}?&reg_tipo=${regionTypeToIstat(q.regionType)}&idprovv=${q.actId}` +
    `&mcrvar=${q.event}&id_regione_origine=${q.originId}`,
  utsEventDetails: (q: UtsEventQuery): string =>
    `${INTERNAL_REPORTS[8].report}?&id_uts_origine=${q.originId}&idprovv=${q.actId}` +
    `&uts_tipo=${utsTypeToIstat(q.utsType)}&mcrvar=${q.event}`,
  municipalityEventDetails: (q: MunicipalityEventQuery): string =>
    `${INTERNAL_REPORTS[9].report}?idcomuneorig=${q.originId}&mcrvar=${q.event}&idprovv=${q.actId}`,
};

/** `POST ReportByUrl` carrying an unencoded report URL (§3.3). */
export function internalRequest(endpointUrl: string, reportUrl: string): HttpRequest {
  return {
    method: 'POST',
    url: endpointUrl,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: { url: reportUrl },
  };
}
