/** ANPR is non-blocking (D22): a failure of the whole file skips the cross-check; other errors are bugs. */
import type { AnomalyCollector } from '../anomalies.ts';
import type { IsoDate } from '../dates/index.ts';
import { HttpClientError, ResponseValidationError, type RequestOptions } from '../http/index.ts';
import { AnprFormatError, type AnprData, type AnprIssue, type AnprSource } from '../sources/anpr/index.ts';
import { ANPR_ANOMALIES } from './anomalies.ts';

/** `null`: skip the cross-check (already reported). */
export async function loadAnpr(options: {
  source: AnprSource;
  anomalies: AnomalyCollector;
  request?: RequestOptions;
}): Promise<(AnprData & { fetchedAt: IsoDate }) | null> {
  const { source, anomalies } = options;
  let data: AnprData;
  let fetchedAt: IsoDate;
  try {
    ({ data, fetchedAt } = await source.fetchAnpr(options.request));
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
  reportDroppedRows(data.issues, anomalies);
  return { ...data, fetchedAt };
}

export function reportDroppedRows(issues: readonly AnprIssue[], anomalies: AnomalyCollector): void {
  if (issues.length === 0) return;
  anomalies.add({
    level: 'info',
    code: ANPR_ANOMALIES.rowDropped,
    message: `${issues.length} malformed ANPR rows dropped`,
    context: { count: issues.length, items: [...issues].sort((a, b) => a.line - b.line) },
  });
}
