/** Only unavailability falls back to an older copy, never validation errors or rejected requests (D26). */
import type { CachePolicy, ClientResult, RequestOptions } from '../http/index.ts';
import { isUnavailable } from '../http/index.ts';
import type { InternalReportNumber } from '../sources/situas-internal/index.ts';
import { NotInStoreError, type InternalRowByReport, type Store } from '../store/index.ts';

export interface ObtainedReport<R> {
  rows: R[];
  /** `fetched` includes the HTTP cache; `stale`: a mandatory refresh failed and an older copy was used. */
  origin: 'store' | 'fetched' | 'stale';
}

export interface InternalReportRequest<N extends InternalReportNumber> {
  report: N;
  /** Unencoded: it is the store key. */
  reportUrl: string;
  fetch: (options: RequestOptions) => Promise<ClientResult<InternalRowByReport[N][]>>;
  refresh: boolean;
  refreshPolicy?: CachePolicy;
  offline?: boolean;
}

export async function obtainInternalReport<N extends InternalReportNumber>(
  store: Store,
  request: InternalReportRequest<N>,
): Promise<ObtainedReport<InternalRowByReport[N]>> {
  const { report, reportUrl, refresh, refreshPolicy = 'refresh' } = request;
  const stored = await store.getInternalReport(report, reportUrl);
  if (stored !== undefined && !refresh) return { rows: stored.rows, origin: 'store' };
  if (request.offline === true) {
    if (stored !== undefined) return { rows: stored.rows, origin: 'store' };
    throw new NotInStoreError(`internal report r${report} ${reportUrl}`);
  }
  let result: ClientResult<InternalRowByReport[N][]>;
  try {
    result = await request.fetch({ cache: refresh ? refreshPolicy : 'prefer', staleFallback: stored === undefined });
  } catch (error) {
    if (stored !== undefined && isUnavailable(error)) return { rows: stored.rows, origin: 'stale' };
    throw error;
  }
  await store.putInternalReport(report, reportUrl, { fetchedAt: result.fetchedAt, rows: result.data });
  return { rows: result.data, origin: result.source === 'stale-cache' ? 'stale' : 'fetched' };
}
