/** Errors raised by the HTTP client (§6.1). */
import type { HttpRequest } from './transport.ts';

/**
 * A response that is unusable as a whole (unparseable body, unexpected content type, missing
 * envelope, impossible empty result). Retried within `transientValidationRetries`.
 */
export class TransientResponseError extends Error {
  override name = 'TransientResponseError';
}

export interface RowIssue {
  /** Index of the row inside the envelope array. */
  index: number;
  message: string;
  row: unknown;
}

/**
 * The envelope is valid but rows violate the endpoint schema. Never retried: it opens the
 * circuit of the endpoint family and must become a `blocking` anomaly (§6.1).
 */
export class ResponseValidationError extends Error {
  override name = 'ResponseValidationError';
  readonly issues: RowIssue[];
  /** Set by the client when the error crosses it. */
  endpoint: string | undefined;
  request: HttpRequest | undefined;

  constructor(message: string, issues: RowIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** Base class of the errors the client throws for a request. */
export class HttpClientError extends Error {
  override name = 'HttpClientError';
  readonly endpoint: string;
  readonly request: HttpRequest;

  constructor(message: string, endpoint: string, request: HttpRequest, options?: { cause?: unknown }) {
    super(`${endpoint}: ${message} (${request.method} ${request.url})`, options);
    this.endpoint = endpoint;
    this.request = request;
  }
}

/** A non-retryable HTTP status (4xx other than 429). */
export class HttpStatusError extends HttpClientError {
  override name = 'HttpStatusError';
  readonly status: number;

  constructor(endpoint: string, request: HttpRequest, status: number) {
    super(`unexpected HTTP status ${status}`, endpoint, request);
    this.status = status;
  }
}

/** Every allowed attempt failed with a retryable failure. */
export class RetriesExhaustedError extends HttpClientError {
  override name = 'RetriesExhaustedError';
  readonly attempts: number;
  readonly lastFailure: string;

  constructor(endpoint: string, request: HttpRequest, attempts: number, lastFailure: string) {
    super(`gave up after ${attempts} attempts, last failure: ${lastFailure}`, endpoint, request);
    this.attempts = attempts;
    this.lastFailure = lastFailure;
  }
}

/** The circuit of the endpoint family is open: the request was not sent. */
export class CircuitOpenError extends HttpClientError {
  override name = 'CircuitOpenError';
  readonly family: string;
  readonly reason: string;

  constructor(endpoint: string, request: HttpRequest, family: string, reason: string) {
    super(`circuit open for family '${family}' (${reason})`, endpoint, request);
    this.family = family;
    this.reason = reason;
  }
}

/** The source is unavailable: a stale cache entry may stand in for it (§6.1 degradation). */
export function isUnavailable(error: unknown): error is RetriesExhaustedError | CircuitOpenError {
  return error instanceof RetriesExhaustedError || error instanceof CircuitOpenError;
}
