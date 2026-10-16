/** The only place requests are encoded (§6.1). */
import { encodeRequest } from './encode.ts';
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from './transport.ts';

function errorCode(error: unknown): string | undefined {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function createFetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return async (request: HttpRequest, options = {}): Promise<HttpResponse> => {
    const encoded = encodeRequest(request);
    const init: RequestInit = { method: encoded.method, headers: encoded.headers ?? {} };
    if (options.signal !== undefined) init.signal = options.signal;
    if (encoded.body !== undefined) {
      init.body = typeof encoded.body === 'string' ? encoded.body : JSON.stringify(encoded.body);
    }
    try {
      const response = await fetchImpl(encoded.url, init);
      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return { status: response.status, headers, body };
    } catch (error) {
      // Aborts are reported by the client as timeouts; undici reports socket errors as TypeError.
      if (options.signal?.aborted !== true && error instanceof TypeError) {
        const code = errorCode(error);
        throw new NetworkError(`${error.message}${code === undefined ? '' : ` (${code})`}`, { code, cause: error });
      }
      throw error;
    }
  };
}
