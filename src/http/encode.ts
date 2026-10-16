/**
 * The internal API answers `500 System Error` to unencoded spaces, `/` or apostrophes, so every name
 * and value is encoded per RFC 3986 (`encodeURIComponent` leaves `!'()*` alone).
 */
import type { HttpRequest } from './transport.ts';

export function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** Only the first `=` of a segment separates name and value; empty segments are preserved. */
export function encodeUrlQuery(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const segments = url
    .slice(q + 1)
    .split('&')
    .map((segment) => {
      if (segment === '') return segment;
      const eq = segment.indexOf('=');
      if (eq < 0) return encodeQueryComponent(segment);
      return `${encodeQueryComponent(segment.slice(0, eq))}=${encodeQueryComponent(segment.slice(eq + 1))}`;
    });
  return `${url.slice(0, q)}?${segments.join('&')}`;
}

/** `{ "url": "<report url>" }` (§3.3). */
export function isReportBody(body: unknown): body is { url: string } {
  return typeof body === 'object' && body !== null && typeof (body as { url?: unknown }).url === 'string';
}

export function encodeRequest(request: HttpRequest): HttpRequest {
  const encoded: HttpRequest = { ...request, url: encodeUrlQuery(request.url) };
  if (isReportBody(request.body)) encoded.body = { ...request.body, url: encodeUrlQuery(request.body.url) };
  return encoded;
}
