import type { ClientResult, Endpoint, HttpClient, RequestOptions } from '../../http/index.ts';
import { INTERNAL_ENDPOINTS } from './reports.ts';
import {
  internalRequest,
  reportUrls,
  type MunicipalityEventQuery,
  type MunicipalityRecordQuery,
  type RegionEventQuery,
  type RegionRecordQuery,
  type UtsEventQuery,
  type UtsRecordQuery,
} from './requests.ts';
import type {
  InternalMunicipalityEvent,
  InternalRegionEvent,
  InternalUtsEvent,
  MunicipalityEventDetail,
  MunicipalityListRecord,
  RegionEventDetail,
  RegionListRecord,
  UtsEventDetail,
  UtsListRecord,
} from './reports.ts';

export * from './reports.ts';
export * from './requests.ts';

export class SituasInternalSource {
  readonly #client: HttpClient;
  readonly #endpointUrl: string;

  constructor(client: HttpClient, endpointUrl: string) {
    this.#client = client;
    this.#endpointUrl = endpointUrl;
  }

  /** r1. */
  regionList(options?: RequestOptions): Promise<ClientResult<RegionListRecord[]>> {
    return this.#request(INTERNAL_ENDPOINTS.regionList, reportUrls.regionList(), options);
  }

  /** r2. */
  utsList(options?: RequestOptions): Promise<ClientResult<UtsListRecord[]>> {
    return this.#request(INTERNAL_ENDPOINTS.utsList, reportUrls.utsList(), options);
  }

  /** r3. */
  municipalityList(options?: RequestOptions): Promise<ClientResult<MunicipalityListRecord[]>> {
    return this.#request(INTERNAL_ENDPOINTS.municipalityList, reportUrls.municipalityList(), options);
  }

  /** r4. */
  regionEvents(query: RegionRecordQuery, options?: RequestOptions): Promise<ClientResult<InternalRegionEvent[]>> {
    return this.#request(INTERNAL_ENDPOINTS.regionEvents, reportUrls.regionEvents(query), options);
  }

  /** r5. */
  utsEvents(query: UtsRecordQuery, options?: RequestOptions): Promise<ClientResult<InternalUtsEvent[]>> {
    return this.#request(INTERNAL_ENDPOINTS.utsEvents, reportUrls.utsEvents(query), options);
  }

  /** r6: the full history of the municipality owning the pair. */
  municipalityEvents(
    query: MunicipalityRecordQuery,
    options?: RequestOptions,
  ): Promise<ClientResult<InternalMunicipalityEvent[]>> {
    return this.#request(INTERNAL_ENDPOINTS.municipalityEvents, reportUrls.municipalityEvents(query), options);
  }

  /** r7. */
  regionEventDetails(query: RegionEventQuery, options?: RequestOptions): Promise<ClientResult<RegionEventDetail[]>> {
    return this.#request(INTERNAL_ENDPOINTS.regionEventDetails, reportUrls.regionEventDetails(query), options);
  }

  /** r8. */
  utsEventDetails(query: UtsEventQuery, options?: RequestOptions): Promise<ClientResult<UtsEventDetail[]>> {
    return this.#request(INTERNAL_ENDPOINTS.utsEventDetails, reportUrls.utsEventDetails(query), options);
  }

  /** r9. */
  municipalityEventDetails(
    query: MunicipalityEventQuery,
    options?: RequestOptions,
  ): Promise<ClientResult<MunicipalityEventDetail[]>> {
    return this.#request(
      INTERNAL_ENDPOINTS.municipalityEventDetails,
      reportUrls.municipalityEventDetails(query),
      options,
    );
  }

  #request<T>(endpoint: Endpoint<T>, reportUrl: string, options?: RequestOptions): Promise<ClientResult<T>> {
    return this.#client.request(endpoint, internalRequest(this.#endpointUrl, reportUrl), options);
  }
}
