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
  headers: Record<string, string>;
  body: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;
