/**
 * The real fetch transport and the client against a local HTTP server: encoding, headers,
 * 429/5xx with `Retry-After`, timeouts, connection resets and the SITUAS body quirks.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConfigInput } from '../../src/config.ts';
import { HttpClient, type HttpClientEvent } from '../../src/http/client.ts';
import { CONTENT_TYPES, jsonRowsDecoder, textDecoder, type Endpoint } from '../../src/http/decode.ts';
import { RetriesExhaustedError } from '../../src/http/errors.ts';
import { createFetchTransport } from '../../src/http/fetch-transport.ts';
import { NetworkError } from '../../src/http/transport.ts';
import { createFixtureTransport } from '../helpers/fixtures.ts';
import { fakeClock, httpSettings, publicEndpoint, withTempDir } from '../helpers/http.ts';

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let base: string;
let received: Received[];
const routes = new Map<string, Handler[]>();

/** Handlers for a path are used in order; the last one repeats. */
function route(path: string, ...handlers: Handler[]): void {
  routes.set(path, handlers);
}

const send =
  (status: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): Handler =>
  (_req, res) => {
    res.writeHead(status, headers).end(body);
  };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const path = (req.url ?? '').split('?', 1)[0] ?? '';
      const handlers = routes.get(path);
      const handler = handlers !== undefined && handlers.length > 1 ? handlers.shift() : handlers?.[0];
      if (handler === undefined) send(404, '{}')(req, res, body);
      else handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = [];
  routes.clear();
});

function client(dir: string, http: NonNullable<ConfigInput['http']> = {}) {
  const clock = fakeClock();
  const events: HttpClientEvent[] = [];
  const instance = new HttpClient({
    http: httpSettings(http),
    cacheDir: dir,
    transport: createFetchTransport(),
    clock: clock.clock,
    random: () => 0,
    onEvent: (e) => events.push(e),
  });
  return { client: instance, sleeps: clock.sleeps, events };
}

const resultset = JSON.stringify({ resultset: [{ CODE: '090' }] });

describe('fetch transport against a local server', () => {
  it('encodes public query values and sends the User-Agent', () =>
    withTempDir(async (dir) => {
      route('/publish/reportspooljson', send(200, resultset));
      const { client: c } = client(dir, { userAgent: 'italian-territories-test (+https://example.org)' });
      const result = await c.request(publicEndpoint(), {
        method: 'GET',
        url: `${base}/publish/reportspooljson?pfun=61&pdata=21/01/2024`,
      });
      expect(result.data).toEqual([{ CODE: '090' }]);
      expect(received[0]?.url).toBe('/publish/reportspooljson?pfun=61&pdata=21%2F01%2F2024');
      expect(received[0]?.headers['user-agent']).toBe('italian-territories-test (+https://example.org)');
    }));

  it('posts internal reports with the report URL encoded inside the JSON body', () =>
    withTempDir(async (dir) => {
      const document = { items: [{ 'tipo variazione': 'CS' }] };
      // Non-empty internal results are a JSON string containing the document (§3.3).
      route(
        '/api/Report/ReportByUrl',
        send(200, JSON.stringify(JSON.stringify(document)), {
          'content-type': 'application/json; charset=utf-8',
        }),
      );
      const endpoint: Endpoint<unknown[]> = {
        id: 'r4:region-events',
        family: 'situas-internal',
        timeoutClass: 'default',
        decode: jsonRowsDecoder({
          contentTypes: CONTENT_TYPES.situasInternal,
          envelope: 'items',
          nonEmpty: false,
          row: z.object({ 'tipo variazione': z.string() }),
        }),
      };
      const { client: c } = client(dir);
      const result = await c.request(endpoint, {
        method: 'POST',
        url: `${base}/api/Report/ReportByUrl`,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: { url: "var_get_ua_reg_lov_rs?&codreg=02&reg=Valle d'Aosta/Vallée d'Aoste&reg_tipo=2" },
      });
      expect(result.data).toEqual([{ 'tipo variazione': 'CS' }]);
      expect(received[0]?.method).toBe('POST');
      expect(received[0]?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(received[0]?.body ?? '')).toEqual({
        url: 'var_get_ua_reg_lov_rs?&codreg=02&reg=Valle%20d%27Aosta%2FVall%C3%A9e%20d%27Aoste&reg_tipo=2',
      });

      // Empty internal results come as text/plain.
      route(
        '/api/Report/ReportByUrl',
        send(200, '{\n"items":[\n]\n}', { 'content-type': 'text/plain; charset=utf-8' }),
      );
      const empty = await c.request(endpoint, {
        method: 'POST',
        url: `${base}/api/Report/ReportByUrl`,
        body: { url: 'var_get_ua_comuni_lov_rs?procom=999999&com=Nulla' },
      });
      expect(empty.data).toEqual([]);
    }));

  it('honours 429 Retry-After and retries 5xx until success', () =>
    withTempDir(async (dir) => {
      route(
        '/flaky',
        send(429, '{}', { 'content-type': 'application/json', 'retry-after': '2' }),
        send(503, '{}'),
        send(200, resultset),
      );
      const { client: c, events } = client(dir);
      const result = await c.request(publicEndpoint(), { method: 'GET', url: `${base}/flaky` });
      expect(result.source).toBe('network');
      expect(received).toHaveLength(3);
      // random = 0: the backoff is 0, so the first delay is exactly the Retry-After.
      expect(events.flatMap((e) => (e.type === 'retry' ? [[e.reason, e.delayMs]] : []))).toEqual([
        ['HTTP 429', 2000],
        ['HTTP 503', 0],
      ]);
    }));

  it('times out a server that never answers', () =>
    withTempDir(async (dir) => {
      route('/hang', () => undefined);
      const { client: c } = client(dir, { maxAttempts: 2, timeouts: { defaultMs: 100 } });
      const error = await c.request(publicEndpoint(), { method: 'GET', url: `${base}/hang` }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetriesExhaustedError);
      expect(error).toMatchObject({ attempts: 2, lastFailure: 'timeout after 100 ms' });
      // Alone in its family, it keeps trying up to the circuit threshold (10), then gives up (D38).
      expect(received).toHaveLength(10);
    }));

  it('reports connection resets as network errors and retries them', () =>
    withTempDir(async (dir) => {
      route(
        '/reset',
        (req) => {
          req.socket.destroy();
        },
        send(200, resultset),
      );
      const raw = await createFetchTransport()({ method: 'GET', url: `${base}/reset` }).catch((e: unknown) => e);
      expect(raw).toBeInstanceOf(NetworkError);

      route(
        '/reset',
        (req) => {
          req.socket.destroy();
        },
        send(200, resultset),
      );
      const { client: c, events } = client(dir);
      const result = await c.request(publicEndpoint(), { method: 'GET', url: `${base}/reset` });
      expect(result.data).toEqual([{ CODE: '090' }]);
      expect(events.flatMap((e) => (e.type === 'retry' ? [e.reason] : []))).toEqual([
        expect.stringMatching(/^network error: /),
      ]);
    }));

  it('reports a refused connection as a network error', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const error = await createFetchTransport()({ method: 'GET', url: `http://127.0.0.1:${port}/` }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).code).toBe('ECONNREFUSED');
  });

  it('lowercases response headers and passes CSV through', () =>
    withTempDir(async (dir) => {
      route('/anpr.csv', send(200, '"A";"B"\r\n"1";"2"\r\n', { 'Content-Type': 'text/csv', 'X-Extra': 'y' }));
      const endpoint: Endpoint<string> = {
        id: 'anpr:archivio-comuni',
        family: 'anpr',
        timeoutClass: 'default',
        decode: textDecoder({ contentTypes: CONTENT_TYPES.anpr, nonEmpty: true }),
      };
      const { client: c } = client(dir);
      const result = await c.request(endpoint, { method: 'GET', url: `${base}/anpr.csv` });
      expect(result.data).toBe('"A";"B"\r\n"1";"2"\r\n');
      const raw = await createFetchTransport()({ method: 'GET', url: `${base}/anpr.csv` });
      expect(raw.headers['x-extra']).toBe('y');
    }));
});

describe('client over recorded fixtures', () => {
  it('decodes a raw, double-encoded internal fixture', () =>
    withTempDir(async (dir) => {
      const endpoint: Endpoint<{ 'tipo variazione': string; denominazione: string }[]> = {
        id: 'r6:municipality-events',
        family: 'situas-internal',
        timeoutClass: 'default',
        decode: jsonRowsDecoder({
          contentTypes: CONTENT_TYPES.situasInternal,
          envelope: 'items',
          nonEmpty: false,
          row: z.object({ 'tipo variazione': z.string(), denominazione: z.string() }),
        }),
      };
      const c = new HttpClient({ http: httpSettings(), cacheDir: dir, transport: await createFixtureTransport() });
      const result = await c.request(endpoint, {
        method: 'POST',
        url: 'https://situas.istat.it/ShibO2Module/api/Report/ReportByUrl',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: { url: 'var_get_ua_comuni_lov_rs?procom=007022&com=Courmayeur' },
      });
      // Golden case 10: Courmayeur → Cormaiore → Courmayeur.
      expect(result.data.map((r) => r.denominazione)).toEqual(expect.arrayContaining(['Courmayeur', 'Cormaiore']));
    }));

  it('decodes a public snapshot fixture', () =>
    withTempDir(async (dir) => {
      const c = new HttpClient({ http: httpSettings(), cacheDir: dir, transport: await createFixtureTransport() });
      const endpoint = {
        ...publicEndpoint({ timeoutClass: 'snapshot' }),
        decode: jsonRowsDecoder({
          contentTypes: CONTENT_TYPES.situasPublic,
          envelope: 'resultset',
          nonEmpty: true,
          row: z.object({ COD_UTS: z.string() }),
        }),
      };
      const result = await c.request(endpoint, {
        method: 'GET',
        url: 'https://situas-servizi.istat.it/publish/reportspooljson?pfun=64&pdata=01/01/2026',
      });
      expect(result.data.map((r) => r.COD_UTS)).toEqual(expect.arrayContaining(['114', '115', '312', '318']));
    }));
});
