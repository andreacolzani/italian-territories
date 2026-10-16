import type { Family } from './decode.ts';
import type { HttpRequest } from './transport.ts';

/** Retried within `transientValidationRetries`. */
export class TransientResponseError extends Error {
  override name = 'TransientResponseError';
}

export interface RowIssue {
  index: number;
  message: string;
  row: unknown;
}

/** Never retried and not a congestion or availability signal: AIMD and the circuit breaker ignore it (D26). */
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

/** 4xx other than 429. */
export class HttpStatusError extends HttpClientError {
  override name = 'HttpStatusError';
  readonly status: number;

  constructor(endpoint: string, request: HttpRequest, status: number) {
    super(`unexpected HTTP status ${status}`, endpoint, request);
    this.status = status;
  }
}

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

export class CircuitOpenError extends HttpClientError {
  override name = 'CircuitOpenError';
  readonly family: Family;
  readonly reason: string;

  constructor(endpoint: string, request: HttpRequest, family: Family, reason: string) {
    super(`circuit open for family '${family}' (${reason})`, endpoint, request);
    this.family = family;
    this.reason = reason;
  }
}

export class EndpointDisabledError extends HttpClientError {
  override name = 'EndpointDisabledError';
  readonly reason: string;

  constructor(endpoint: string, request: HttpRequest, reason: string) {
    super(`endpoint disabled (${reason})`, endpoint, request);
    this.reason = reason;
  }
}

/** Validation errors never qualify for a stale cache entry (D26). */
export function isUnavailable(error: unknown): error is RetriesExhaustedError | CircuitOpenError {
  return error instanceof RetriesExhaustedError || error instanceof CircuitOpenError;
}
