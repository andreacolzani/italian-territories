/**
 * Low-level transport contract shared by the HTTP client (§6.1) and test doubles.
 * URLs and bodies are carried unencoded; the client encodes parameter values when sending.
 */
export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  /** Header names are lowercase. */
  headers: Record<string, string>;
  body: string;
}

export interface TransportOptions {
  /** Aborted by the client on timeout. Transports should honour it; the client does not rely on it. */
  signal?: AbortSignal;
}

/**
 * Sends one request. Connection-level failures (reset, refused, DNS…) must be reported as
 * `NetworkError` so the client can retry them; any other thrown error is treated as a bug.
 */
export type Transport = (request: HttpRequest, options?: TransportOptions) => Promise<HttpResponse>;

/** A connection-level failure: retryable, counts for AIMD and the circuit breaker (§6.1). */
export class NetworkError extends Error {
  override name = 'NetworkError';
  readonly code: string | undefined;

  constructor(message: string, options: { code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.code = options.code;
  }
}
