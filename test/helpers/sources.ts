import { resolveConfig, type ConfigInput } from '../../src/config.ts';
import { HttpClient, type HttpClientEvent } from '../../src/http/client.ts';
import type { HttpRequest, HttpResponse, Transport } from '../../src/http/transport.ts';
import { createSources, type Sources } from '../../src/sources/index.ts';
import { createFixtureTransport } from './fixtures.ts';
import { fakeClock, httpSettings, withTempDir } from './http.ts';

export interface SourcesHarness extends Sources {
  client: HttpClient;
  events: HttpClientEvent[];
  calls: HttpRequest[];
}

export interface SourcesHarnessOptions {
  transport?: Transport;
  http?: NonNullable<ConfigInput['http']>;
}

export async function withSources<T>(
  fn: (harness: SourcesHarness) => Promise<T>,
  options: SourcesHarnessOptions = {},
): Promise<T> {
  const transport = options.transport ?? (await createFixtureTransport());
  return withTempDir(async (cacheDir) => {
    const events: HttpClientEvent[] = [];
    const calls: HttpRequest[] = [];
    const client = new HttpClient({
      http: httpSettings(options.http),
      cacheDir,
      clock: fakeClock().clock,
      random: () => 0,
      transport: (request, transportOptions) => {
        calls.push(request);
        return transport(request, transportOptions);
      },
      onEvent: (event) => events.push(event),
    });
    return fn({ ...createSources(client, resolveConfig()), client, events, calls });
  });
}

export async function patchedFixtureTransport(
  patch: (response: HttpResponse, request: HttpRequest) => HttpResponse,
): Promise<Transport> {
  const fixtures = await createFixtureTransport();
  return async (request, options) => patch(await fixtures(request, options), request);
}

export function mapResultset(
  response: HttpResponse,
  map: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
): HttpResponse {
  const document = JSON.parse(response.body) as { resultset: Record<string, unknown>[] };
  return { ...response, body: JSON.stringify({ resultset: map(document.resultset) }) };
}

export function constant(response: HttpResponse): Transport {
  return () => Promise.resolve(response);
}
