/**
 * Endpoint descriptors and response decoders (§6.1). Each adapter (§12 step 4) declares its
 * endpoint with a decoder; decoders classify failures as transient (whole response unusable)
 * or permanent (`ResponseValidationError`: rows violate the schema).
 */
import type { z } from 'zod';
import { ResponseValidationError, TransientResponseError, type RowIssue } from './errors.ts';
import type { HttpResponse } from './transport.ts';

/** Endpoint class selecting the timeout (§6.1): `snapshot` is for municipality snapshots. */
export type TimeoutClass = 'snapshot' | 'default';

/**
 * Circuit-breaker families (§6.1). Heavy snapshots and light reports share a host but not a
 * family, so timeouts on the former do not stop the latter.
 */
export const FAMILIES = ['situas-public-snapshots', 'situas-public-reports', 'situas-internal', 'anpr'] as const;
export type Family = (typeof FAMILIES)[number];

/**
 * Declared by the adapter, one per `pfun`, internal report or the ANPR CSV. The host scope
 * (pool, AIMD, rate limit) is derived from the request URL by the client.
 */
export interface Endpoint<T> {
  /**
   * Endpoint id as in the fixture manifest, e.g. `snapshot:pfun-61`, `r5:uts-events`. A permanent
   * validation error disables this id for the rest of the run.
   */
  id: string;
  /** Circuit-breaker family. */
  family: Family;
  timeoutClass: TimeoutClass;
  /** Validates and converts a 2xx response. Throws `TransientResponseError` or `ResponseValidationError`. */
  decode: (response: HttpResponse) => T;
}

/** Content types accepted per source (§3.3, §6.1). */
export const CONTENT_TYPES = {
  situasPublic: ['application/json'],
  situasInternal: ['application/json', 'text/plain'],
  anpr: ['text/csv'],
} as const;

/** Media type without parameters, lowercase, or `null`. */
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

/**
 * Parses a JSON body. The internal API serves non-empty results as a JSON string containing
 * the document (§3.3): when the first parse yields a string, it is parsed again.
 */
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
  /** Zero rows are impossible for this endpoint (snapshots, list reports): treat as transient. */
  nonEmpty: boolean;
  /** Per-row schema checking only the required fields. */
  row: S;
}

/** Decoder for `{ <envelope>: [ row, … ] }` JSON responses. */
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

/** Decoder returning the raw body after checking its content type (e.g. the ANPR CSV). */
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
