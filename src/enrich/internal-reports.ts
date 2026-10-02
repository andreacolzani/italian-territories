/**
 * Where the internal crawl gets reports from (§6.8, Step 7): the store first. A stored report of
 * the current projection version is used without network unless its refresh is mandatory;
 * otherwise the report is fetched (`cache: prefer`, or `refresh` when mandatory) and stored.
 *
 * Degradation (§6.1): when a mandatory refresh fails because the source is unavailable (open
 * circuit, exhausted retries), the stored copy is used, or the HTTP cache entry when the store
 * has none (`staleFallback`). Validation errors and rejected requests never fall back (D26).
 */
import type { ClientResult, RequestOptions } from '../http/index.ts';
import { isUnavailable } from '../http/index.ts';
import type { InternalReportNumber } from '../sources/situas-internal/index.ts';
import type { InternalRowByReport, Store } from '../store/index.ts';

export interface ObtainedReport<R> {
  rows: R[];
  /**
   * `store`: the stored copy, no refresh required; `fetched`: network or HTTP cache, now stored;
   * `stale`: a mandatory refresh failed and an older copy (store or HTTP cache) was used.
   */
  origin: 'store' | 'fetched' | 'stale';
}

export interface InternalReportRequest<N extends InternalReportNumber> {
  report: N;
  /** Unencoded report URL (`reportUrls`), the store key. */
  reportUrl: string;
  fetch: (options: RequestOptions) => Promise<ClientResult<InternalRowByReport[N][]>>;
  refresh: boolean;
}

/** Throws the HTTP client errors of the fetch when no copy can stand in for it. */
export async function obtainInternalReport<N extends InternalReportNumber>(
  store: Store,
  request: InternalReportRequest<N>,
): Promise<ObtainedReport<InternalRowByReport[N]>> {
  const { report, reportUrl, refresh } = request;
  const stored = await store.getInternalReport(report, reportUrl);
  if (stored !== undefined && !refresh) return { rows: stored.rows, origin: 'store' };
  let result: ClientResult<InternalRowByReport[N][]>;
  try {
    result = await request.fetch({ cache: refresh ? 'refresh' : 'prefer', staleFallback: stored === undefined });
  } catch (error) {
    if (stored !== undefined && isUnavailable(error)) return { rows: stored.rows, origin: 'stale' };
    throw error;
  }
  await store.putInternalReport(report, reportUrl, { fetchedAt: result.fetchedAt, rows: result.data });
  return { rows: result.data, origin: result.source === 'stale-cache' ? 'stale' : 'fetched' };
}
