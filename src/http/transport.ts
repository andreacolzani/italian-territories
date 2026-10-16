/** URLs and bodies are unencoded: the real transport encodes them. */
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

/** Connection-level failures must be `NetworkError` to be retried; any other error is a bug. */
export type Transport = (request: HttpRequest, options?: TransportOptions) => Promise<HttpResponse>;

export class NetworkError extends Error {
  override name = 'NetworkError';
  readonly code: string | undefined;

  constructor(message: string, options: { code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.code = options.code;
  }
}
