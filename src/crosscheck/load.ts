/**
 * Loading ANPR for the cross-check (§6.11, D22). ANPR is a non-blocking source: any failure of the
 * download or of the file as a whole (`AnprFormatError`, exhausted retries, open circuit, HTTP
 * status, disabled endpoint, validation) skips the cross-check for the run with a single `warning`;
 * the rows the adapter dropped become one aggregated `info`. Any other error is a bug and propagates.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { HttpClientError, ResponseValidationError, type RequestOptions } from '../http/index.ts';
import { AnprFormatError, type AnprData, type AnprSource } from '../sources/anpr/index.ts';
import { ANPR_ANOMALIES } from './anomalies.ts';

/** The ANPR rows, or `null` when the cross-check must be skipped (already reported). */
export async function loadAnpr(options: {
  source: AnprSource;
  anomalies: AnomalyCollector;
  request?: RequestOptions;
}): Promise<AnprData | null> {
  const { source, anomalies } = options;
  let data: AnprData;
  try {
    ({ data } = await source.fetchAnpr(options.request));
  } catch (error) {
    if (!(
      error instanceof AnprFormatError ||
      error instanceof HttpClientError ||
      error instanceof ResponseValidationError
    )) {
      throw error;
    }
    anomalies.add({
      level: 'warning',
      code: ANPR_ANOMALIES.unavailable,
      message: `ANPR cross-check skipped: ${error.message}`,
      context: { error: error.name, message: error.message },
    });
    return null;
  }
  if (data.issues.length > 0) {
    anomalies.add({
      level: 'info',
      code: ANPR_ANOMALIES.rowDropped,
      message: `${data.issues.length} malformed ANPR rows dropped`,
      context: { count: data.issues.length, items: data.issues },
    });
  }
  return data;
}
