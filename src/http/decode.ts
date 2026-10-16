import type { z } from 'zod';
import { ResponseValidationError, TransientResponseError, type RowIssue } from './errors.ts';
import type { HttpResponse } from './transport.ts';

/** `snapshot` is for municipality snapshots. */
export type TimeoutClass = 'snapshot' | 'default';

/**
 * Heavy snapshots and light reports share a host but not a family, so timeouts on the former do not
 * stop the latter (§6.1).
 */
export type Family = 'situas-public-snapshots' | 'situas-public-reports' | 'situas-internal' | 'anpr';

export interface Endpoint<T> {
  /** As in the fixture manifest; a permanent validation error disables it for the run. */
  id: string;
  family: Family;
  timeoutClass: TimeoutClass;
  decode: (response: HttpResponse) => T;
}

export const CONTENT_TYPES = {
  situasPublic: ['application/json'],
  situasInternal: ['application/json', 'text/plain'],
  anpr: ['text/csv'],
} as const;

export function mediaType(response: HttpResponse): string | null {
  const value = response.headers['content-type'];
  if (value === undefined) return null;
  const type = value.split(';', 1)[0]?.trim().toLowerCase();
  return type === undefined || type === '' ? null : type;
}

export function assertContentType(response: HttpResponse, accepted: readonly string[]): void {
  const type = mediaType(response);
  if (type === null || !accepted.includes(type)) {
    throw new TransientResponseError(
      `unexpected content type '${type ?? '(none)'}', expected ${accepted.join(' or ')}`,
    );
  }
}

/** The internal API serves non-empty results as a JSON string containing the document (§3.3). */
export function parseJsonBody(body: string): unknown {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new TransientResponseError(`body is not valid JSON: ${(error as Error).message}`);
  }
}

const MAX_REPORTED_ISSUES = 20;

export interface JsonRowsDecoderOptions<S extends z.ZodType> {
  contentTypes: readonly string[];
  /** Key of the array holding the rows: `resultset` (public) or `items` (internal). */
  envelope: string;
  /** Zero rows are impossible here (snapshots, list reports), so they are transient. */
  nonEmpty: boolean;
  row: S;
}

export function jsonRowsDecoder<S extends z.ZodType>(
  options: JsonRowsDecoderOptions<S>,
): (response: HttpResponse) => z.output<S>[] {
  return (response) => {
    assertContentType(response, options.contentTypes);
    const document = parseJsonBody(response.body);
    const rows =
      typeof document === 'object' && document !== null
        ? (document as Record<string, unknown>)[options.envelope]
        : undefined;
    if (!Array.isArray(rows)) throw new TransientResponseError(`missing '${options.envelope}' array`);
    if (options.nonEmpty && rows.length === 0) throw new TransientResponseError(`'${options.envelope}' is empty`);

    const decoded: z.output<S>[] = [];
    const issues: RowIssue[] = [];
    rows.forEach((row: unknown, index) => {
      const result = options.row.safeParse(row);
      if (result.success) decoded.push(result.data);
      else issues.push({ index, message: result.error.message, row });
    });
    if (issues.length > 0) {
      throw new ResponseValidationError(
        `${issues.length} of ${rows.length} rows violate the schema`,
        issues.slice(0, MAX_REPORTED_ISSUES),
      );
    }
    return decoded;
  };
}

export function textDecoder(options: {
  contentTypes: readonly string[];
  nonEmpty: boolean;
}): (response: HttpResponse) => string {
  return (response) => {
    assertContentType(response, options.contentTypes);
    if (options.nonEmpty && response.body.trim() === '') throw new TransientResponseError('body is empty');
    return response.body;
  };
}
