import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config.ts';
import { cacheKey, ResponseCache } from '../../src/http/cache.ts';
import { HttpClient, type HttpClientEvent } from '../../src/http/client.ts';
import {
  CircuitOpenError,
  EndpointDisabledError,
  HttpStatusError,
  ResponseValidationError,
  RetriesExhaustedError,
} from '../../src/http/errors.ts';
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from '../../src/http/transport.ts';
import { deferred, fakeClock, httpSettings, json, ok, publicEndpoint, withTempDir } from '../helpers/http.ts';

const HOST = 'situas-servizi.istat.it';
const URL = `https://${HOST}/publish/reportspooljson`;
const get = (pdata = '01/01/2026', pfun = 64): HttpRequest => ({
  method: 'GET',
  url: `${URL}?pfun=${pfun}&pdata=${pdata}`,
});
const INTERNAL_HOST = 'situas.istat.it';
const post = (report = 'var_get_ua_reg_lov_diffusione'): HttpRequest => ({
  method: 'POST',
  url: `https://${INTERNAL_HOST}/ShibO2Module/api/Report/ReportByUrl`,
  body: { url: report },
});
/** A second endpoint of the same family as `publicEndpoint()`. */
const otherEndpoint = () => ({ ...publicEndpoint(), id: 'snapshot:pfun-49' });
const invalidRows = () => json({ resultset: [{ CODE: '090' }, { CODE: 'x' }] });

type Reply = HttpResponse | Error | (() => Promise<HttpResponse>);

/** Transport answering from a script (the last reply repeats), recording every request. */
function scripted(...replies: Reply[]): Transport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const transport = (request: HttpRequest): Promise<HttpResponse> => {
    calls.push(request);
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    if (reply === undefined) throw new Error('empty script');
    if (reply instanceof Error) return Promise.reject(reply);
    return typeof reply === 'function' ? reply() : Promise.resolve(reply);
  };
  return Object.assign(transport, { calls });
}

interface Harness {
  client: HttpClient;
  events: HttpClientEvent[];
  sleeps: number[];
  clock: ReturnType<typeof fakeClock>;
  cacheDir: string;
}

function harness(
  cacheDir: string,
  transport: Transport,
  http: NonNullable<ConfigInput['http']> = {},
  clock = fakeClock(),
): Harness {
  const events: HttpClientEvent[] = [];
  const client = new HttpClient({
    http: httpSettings(http),
    cacheDir,
    transport,
    clock: clock.clock,
    random: () => 0.5,
    onEvent: (e) => events.push(e),
  });
  return { client, events, sleeps: clock.sleeps, clock, cacheDir };
}

const eventsOf = <T extends HttpClientEvent['type']>(events: HttpClientEvent[], type: T) =>
  events.filter((e): e is Extract<HttpClientEvent, { type: T }> => e.type === type);

describe('HttpClient: retries', () => {
  it('retries 5xx and 429 with full-jitter exponential backoff', () =>
    withTempDir(async (dir) => {
      const transport = scripted(json({}, 503), json({}, 500), json({}, 429), ok(['090', '091']));
      const h = harness(dir, transport);
      const result = await h.client.request(publicEndpoint(), get());
      expect(result).toMatchObject({ data: [{ CODE: '090' }, { CODE: '091' }], source: 'network', changed: false });
      expect(transport.calls).toHaveLength(4);
      // random = 0.5, base 100 ms: 0.5 · 100, 0.5 · 200, 0.5 · 400.
      expect(h.sleeps).toEqual([50, 100, 200]);
      expect(eventsOf(h.events, 'retry').map((e) => [e.attempt, e.reason])).toEqual([
        [1, 'HTTP 503'],
        [2, 'HTTP 500'],
        [3, 'HTTP 429'],
      ]);
    }));

  it('respects Retry-After (seconds and HTTP-date), capped by retryAfterMaxMs', () =>
    withTempDir(async (dir) => {
      const transport = scripted(
        json({}, 429, { 'retry-after': '7' }),
        json({}, 503, { 'retry-after': 'Thu, 01 Oct 2026 10:00:30 GMT' }),
        json({}, 429, { 'retry-after': '3600' }),
        ok(),
      );
      const h = harness(dir, transport, { retryAfterMaxMs: 60_000 });
      await h.client.request(publicEndpoint(), get());
      // The second wait is measured from the virtual now, already 7 s later.
      expect(h.sleeps).toEqual([7000, 23_000, 60_000]);
    }));

  it('never waits less than the backoff when Retry-After is shorter', () =>
    withTempDir(async (dir) => {
      const h = harness(dir, scripted(json({}, 429, { 'retry-after': '0' }), ok()));
      await h.client.request(publicEndpoint(), get());
      expect(h.sleeps).toEqual([50]);
    }));

  it('gives up after maxAttempts', () =>
    withTempDir(async (dir) => {
      const transport = scripted(json({}, 502));
      const h = harness(dir, transport, { circuitBreakerThreshold: 100 });
      const error = await h.client.request(publicEndpoint(), get()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetriesExhaustedError);
      expect(error).toMatchObject({ attempts: 6, lastFailure: 'HTTP 502', endpoint: 'snapshot:pfun-64' });
      expect(transport.calls).toHaveLength(6);
      expect(h.sleeps).toHaveLength(5);
    }));

  it('retries network errors but not other transport errors', () =>
    withTempDir(async (dir) => {
      const reset = scripted(new NetworkError('socket hang up', { code: 'ECONNRESET' }), ok());
      expect((await harness(dir, reset).client.request(publicEndpoint(), get())).source).toBe('network');
      expect(reset.calls).toHaveLength(2);

      const bug = scripted(new Error('no fixture'));
      await expect(harness(dir, bug).client.request(publicEndpoint(), get('02/01/2026'))).rejects.toThrow('no fixture');
      expect(bug.calls).toHaveLength(1);
    }));

  it('does not retry other 4xx statuses and leaves the circuit alone', () =>
    withTempDir(async (dir) => {
      const transport = scripted(json({}, 404));
      const h = harness(dir, transport, { circuitBreakerThreshold: 1 });
      const error = await h.client.request(publicEndpoint(), get()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpStatusError);
      expect(error).toMatchObject({ status: 404 });
      expect(transport.calls).toHaveLength(1);
      expect(h.client.isCircuitOpen('situas-public-snapshots')).toBe(false);
    }));

  it('sends the configured User-Agent', () =>
    withTempDir(async (dir) => {
      const transport = scripted(ok());
      const h = harness(dir, transport, { userAgent: 'test-agent (+https://example.org)' });
      await h.client.request(publicEndpoint(), { ...get(), headers: { Accept: 'application/json' } });
      expect(transport.calls[0]?.headers).toEqual({
        Accept: 'application/json',
        'User-Agent': 'test-agent (+https://example.org)',
      });
    }));
});

describe('HttpClient: timeouts', () => {
  const slow = (ms: number) => () =>
    new Promise<HttpResponse>((resolve) =>
      setTimeout(() => {
        resolve(ok());
      }, ms),
    );

  it('applies the timeout of the endpoint class', () =>
    withTempDir(async (dir) => {
      const settings = { maxAttempts: 2, timeouts: { snapshotMs: 20, defaultMs: 2000 } };
      const snapshot = harness(dir, scripted(slow(200)), settings);
      const error = await snapshot.client
        .request(publicEndpoint({ timeoutClass: 'snapshot' }), get())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetriesExhaustedError);
      expect(error).toMatchObject({ attempts: 2, lastFailure: 'timeout after 20 ms' });

      const regular = harness(dir, scripted(slow(50)), settings);
      expect((await regular.client.request(publicEndpoint(), get())).source).toBe('network');
    }));

  it('aborts the transport signal on timeout', () =>
    withTempDir(async (dir) => {
      let signal: AbortSignal | undefined;
      const hanging: Transport = (_request, options) => {
        signal = options?.signal;
        return new Promise(() => undefined);
      };
      const h = harness(dir, hanging, { maxAttempts: 1, timeouts: { defaultMs: 10 } });
      await expect(h.client.request(publicEndpoint(), get())).rejects.toThrow(/timeout after 10 ms/);
      expect(signal?.aborted).toBe(true);
    }));
});

describe('HttpClient: concurrency', () => {
  it('never runs more requests than the concurrency limit', () =>
    withTempDir(async (dir) => {
      let inFlight = 0;
      let peak = 0;
      const gates: (() => void)[] = [];
      const transport: Transport = async () => {
        peak = Math.max(peak, ++inFlight);
        const gate = deferred<undefined>();
        gates.push(() => {
          gate.resolve(undefined);
        });
        await gate.promise;
        inFlight--;
        return ok();
      };
      const h = harness(dir, transport, { concurrency: 3, maxConcurrency: 3 });
      const all = Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          h.client.request(publicEndpoint(), get(`${String(i + 1).padStart(2, '0')}/01/2026`)),
        ),
      );
      const state = { done: false };
      void all.then(() => (state.done = true));
      while (!state.done) {
        await new Promise((r) => setTimeout(r, 1));
        expect(inFlight).toBeLessThanOrEqual(3);
        gates.splice(0).forEach((open) => {
          open();
        });
      }
      expect(peak).toBe(3);
    }));

  it('grows by one after K fast successes and halves on congestion', () =>
    withTempDir(async (dir) => {
      const transport = scripted(ok());
      const h = harness(dir, transport, { concurrency: 2, maxConcurrency: 4, aimdIncreaseAfter: 3 });
      for (let i = 1; i <= 7; i++) await h.client.request(publicEndpoint(), get(`0${i}/02/2026`));
      expect(h.client.concurrency(HOST)).toBe(4);

      const failing = scripted(json({}, 503), ok());
      const h2 = harness(join(dir, 'b'), failing, { concurrency: 4, maxConcurrency: 4 });
      await h2.client.request(publicEndpoint(), get());
      expect(h2.client.concurrency(HOST)).toBe(2);
      expect(eventsOf(h2.events, 'concurrency')).toEqual([{ type: 'concurrency', host: HOST, limit: 2 }]);
    }));

  it('does not count slow successes towards growth', () =>
    withTempDir(async (dir) => {
      const clock = fakeClock();
      // 30 s timeout, fraction 0.25: 8 s is slow.
      const transport = scripted(() => {
        clock.advance(8000);
        return Promise.resolve(ok());
      });
      const h = harness(dir, transport, { concurrency: 1, aimdIncreaseAfter: 1 }, clock);
      for (let i = 1; i <= 3; i++) await h.client.request(publicEndpoint(), get(`0${i}/03/2026`));
      expect(h.client.concurrency(HOST)).toBe(1);
    }));

  it('halves only once when concurrent requests fail together', () =>
    withTempDir(async (dir) => {
      const failures = new Set<string>();
      const gate = deferred<undefined>();
      const transport: Transport = async (request) => {
        await gate.promise;
        if (failures.has(request.url)) return ok();
        failures.add(request.url);
        return json({}, 503);
      };
      const h = harness(dir, transport, { concurrency: 8, maxConcurrency: 8 });
      const all = Promise.all(
        Array.from({ length: 8 }, (_, i) => h.client.request(publicEndpoint(), get(`0${i + 1}/04/2026`))),
      );
      await new Promise((r) => setTimeout(r, 5));
      gate.resolve(undefined);
      await all;
      expect(h.client.concurrency(HOST)).toBe(4);
    }));

  it('rate-limits through the token bucket', () =>
    withTempDir(async (dir) => {
      const h = harness(dir, scripted(ok()), { requestsPerSecond: 2 });
      await Promise.all([1, 2, 3].map((d) => h.client.request(publicEndpoint(), get(`0${d}/05/2026`))));
      expect(h.sleeps).toEqual([500, 500]);
    }));

  it('keeps pool, AIMD and rate limit separate per host', () =>
    withTempDir(async (dir) => {
      let publicCalls = 0;
      const transport: Transport = (request) =>
        Promise.resolve(request.method === 'GET' && ++publicCalls === 1 ? json({}, 503) : ok());
      const h = harness(dir, transport, { concurrency: 4, maxConcurrency: 4, requestsPerSecond: 2 });
      await h.client.request(publicEndpoint(), get());
      expect(h.client.concurrency(HOST)).toBe(2);

      await Promise.all([
        h.client.request(publicEndpoint({ family: 'situas-internal' }), post('a')),
        h.client.request(publicEndpoint({ family: 'situas-internal' }), post('b')),
      ]);
      expect(h.client.concurrency(INTERNAL_HOST)).toBe(4);
      expect(eventsOf(h.events, 'concurrency').map((e) => e.host)).toEqual([HOST]);
      // Public: the retry waits for a token (500 ms) after its backoff. Internal: the first
      // request finds a full bucket of its own, the second waits 500 ms.
      expect(h.sleeps).toEqual([50, 450, 500]);
    }));
});

describe('HttpClient: circuit breaker', () => {
  it('opens a family after N consecutive failed attempts, for the rest of the run', () =>
    withTempDir(async (dir) => {
      const transport = scripted(json({}, 503));
      const h = harness(dir, transport, { circuitBreakerThreshold: 3, maxAttempts: 10 });
      const error = await h.client.request(publicEndpoint(), get()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CircuitOpenError);
      expect(error).toMatchObject({
        family: 'situas-public-snapshots',
        reason: '3 consecutive failures, last: HTTP 503',
      });
      expect(transport.calls).toHaveLength(3);

      await expect(h.client.request(publicEndpoint(), get('02/01/2026'))).rejects.toBeInstanceOf(CircuitOpenError);
      expect(transport.calls).toHaveLength(3);
      expect(eventsOf(h.events, 'circuit-open')).toEqual([
        {
          type: 'circuit-open',
          family: 'situas-public-snapshots',
          reason: '3 consecutive failures, last: HTTP 503',
        },
      ]);
    }));

  it('keeps families independent and resets the count on success', () =>
    withTempDir(async (dir) => {
      const transport = scripted(json({}, 503), json({}, 503), ok(), json({}, 503), json({}, 503), ok());
      const h = harness(dir, transport, { circuitBreakerThreshold: 3 });
      await h.client.request(publicEndpoint(), get());
      await h.client.request(publicEndpoint(), get('02/01/2026'));
      expect(h.client.isCircuitOpen('situas-public-snapshots')).toBe(false);

      const internal = scripted(json({}, 503));
      const h2 = harness(join(dir, 'b'), internal, { circuitBreakerThreshold: 2 });
      await expect(h2.client.request(publicEndpoint({ family: 'situas-internal' }), get())).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
      expect(h2.client.isCircuitOpen('situas-internal')).toBe(true);
      expect(h2.client.isCircuitOpen('situas-public-snapshots')).toBe(false);
    }));

  it('separates heavy snapshots from light reports on the same host', () =>
    withTempDir(async (dir) => {
      const transport: Transport = (request) => Promise.resolve(request.url.includes('pfun=61') ? json({}, 504) : ok());
      const h = harness(dir, transport, { circuitBreakerThreshold: 2 });
      await expect(h.client.request(publicEndpoint(), get('01/01/2026', 61))).rejects.toBeInstanceOf(CircuitOpenError);
      const reports = { ...publicEndpoint({ family: 'situas-public-reports' }), id: 'events:pfun-98' };
      expect((await h.client.request(reports, get('01/01/2026', 98))).source).toBe('network');
      expect(h.client.isCircuitOpen('situas-public-snapshots')).toBe(true);
      expect(h.client.isCircuitOpen('situas-public-reports')).toBe(false);
    }));
});

describe('HttpClient: response validation', () => {
  const html = (): HttpResponse => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: '<html>maintenance</html>',
  });

  it('retries transient invalid responses within their separate budget', () =>
    withTempDir(async (dir) => {
      const transport = scripted(html(), json({ resultset: [] }), ok());
      const h = harness(dir, transport);
      expect((await h.client.request(publicEndpoint(), get())).data).toEqual([{ CODE: '090' }]);
      expect(eventsOf(h.events, 'retry').map((e) => e.reason)).toEqual([
        "invalid response (text/html): unexpected content type 'text/html', expected application/json",
        "invalid response (application/json): 'resultset' is empty",
      ]);
      // Transient failures halve AIMD like a 5xx (once per episode: the second starts in the new epoch).
      expect(h.client.concurrency(HOST)).toBe(1);
    }));

  it('gives up after 2 extra attempts and caches nothing', () =>
    withTempDir(async (dir) => {
      const transport = scripted(html());
      const h = harness(dir, transport, { circuitBreakerThreshold: 100 });
      const error = await h.client.request(publicEndpoint(), get()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetriesExhaustedError);
      expect(error).toMatchObject({ attempts: 3 });
      expect(transport.calls).toHaveLength(3);
      expect(await readdir(dir)).toEqual([]);
    }));

  it('counts transient invalid responses for the circuit breaker', () =>
    withTempDir(async (dir) => {
      const h = harness(dir, scripted(html()), { circuitBreakerThreshold: 2 });
      await expect(h.client.request(publicEndpoint(), get())).rejects.toBeInstanceOf(CircuitOpenError);
    }));

  it('fails permanently on schema violations, disabling only that endpoint', () =>
    withTempDir(async (dir) => {
      const transport = scripted(invalidRows(), ok());
      const h = harness(dir, transport);
      const error = await h.client.request(publicEndpoint(), get()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResponseValidationError);
      const rve = error as ResponseValidationError;
      expect(rve.endpoint).toBe('snapshot:pfun-64');
      expect(rve.request).toEqual(get());
      expect(rve.issues).toMatchObject([{ index: 1, row: { CODE: 'x' } }]);
      expect(transport.calls).toHaveLength(1);
      expect(eventsOf(h.events, 'validation-error')).toHaveLength(1);
      expect(await readdir(dir)).toEqual([]);

      const again = await h.client.request(publicEndpoint(), get('02/01/2026')).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(EndpointDisabledError);
      expect(again).toMatchObject({ endpoint: 'snapshot:pfun-64', reason: `invalid rows: ${rve.message}` });
      expect(transport.calls).toHaveLength(1);
      expect(h.client.isEndpointDisabled('snapshot:pfun-64')).toBe(true);

      // The rest of the family keeps working, so one run collects every problem.
      expect((await h.client.request(otherEndpoint(), get('01/01/2026', 49))).source).toBe('network');
      expect(h.client.isEndpointDisabled('snapshot:pfun-49')).toBe(false);
      expect(h.client.isCircuitOpen('situas-public-snapshots')).toBe(false);
      expect(eventsOf(h.events, 'circuit-open')).toEqual([]);
    }));

  it('does not count schema violations for the circuit breaker, either way', () =>
    withTempDir(async (dir) => {
      const h = harness(dir, scripted(invalidRows()), { circuitBreakerThreshold: 1 });
      await expect(h.client.request(publicEndpoint(), get())).rejects.toBeInstanceOf(ResponseValidationError);
      expect(h.client.isCircuitOpen('situas-public-snapshots')).toBe(false);

      // Nor do they reset the count: 503, invalid rows, 503 opens a threshold-2 circuit.
      const transport = scripted(json({}, 503), invalidRows(), json({}, 503));
      const h2 = harness(join(dir, 'b'), transport, { circuitBreakerThreshold: 2 });
      await expect(h2.client.request(publicEndpoint(), get())).rejects.toBeInstanceOf(ResponseValidationError);
      await expect(h2.client.request(otherEndpoint(), get('01/01/2026', 49))).rejects.toBeInstanceOf(CircuitOpenError);
      expect(transport.calls).toHaveLength(3);
    }));

  it('leaves AIMD untouched on schema violations', () =>
    withTempDir(async (dir) => {
      const transport = scripted(ok(), invalidRows(), ok());
      const h = harness(dir, transport, { concurrency: 2, maxConcurrency: 4, aimdIncreaseAfter: 2 });
      await h.client.request(otherEndpoint(), get('01/01/2026', 49));
      await expect(h.client.request(publicEndpoint(), get())).rejects.toBeInstanceOf(ResponseValidationError);
      expect(h.client.concurrency(HOST)).toBe(2);
      // Not a failure either: the streak of fast successes goes on.
      await h.client.request(otherEndpoint(), get('02/01/2026', 49));
      expect(h.client.concurrency(HOST)).toBe(3);
      await expect(h.client.request(publicEndpoint(), get('02/01/2026'))).rejects.toBeInstanceOf(EndpointDisabledError);
      expect(h.client.concurrency(HOST)).toBe(3);
    }));
});

describe('HttpClient: response cache', () => {
  it('serves cached responses with the prefer policy', () =>
    withTempDir(async (dir) => {
      const transport = scripted(ok());
      const h = harness(dir, transport);
      const first = await h.client.request(publicEndpoint(), get());
      const second = await h.client.request(publicEndpoint(), { ...get(), url: `${URL}?pdata=01/01/2026&pfun=64` });
      expect(first.source).toBe('network');
      expect(second).toEqual({ ...first, source: 'cache' });
      expect(transport.calls).toHaveLength(1);

      const entry = await new ResponseCache(dir).get(cacheKey(get()));
      expect(entry).toMatchObject({
        request: get(),
        fetched_at: '2026-10-01',
        status: 200,
        content_type: 'application/json',
        previous_content_hash: null,
        content_hash: first.contentHash,
      });
    }));

  it('refetches with refresh and with an exceeded maxAgeDays', () =>
    withTempDir(async (dir) => {
      const transport = scripted(ok());
      const h = harness(dir, transport);
      await h.client.request(publicEndpoint(), get());
      expect((await h.client.request(publicEndpoint(), get(), { cache: 'refresh' })).source).toBe('network');
      expect(transport.calls).toHaveLength(2);

      h.clock.advance(2 * 86_400_000);
      expect((await h.client.request(publicEndpoint(), get(), { cache: { maxAgeDays: 2 } })).source).toBe('cache');
      const refetched = await h.client.request(publicEndpoint(), get(), { cache: { maxAgeDays: 1 } });
      expect(refetched).toMatchObject({ source: 'network', fetchedAt: '2026-10-03', changed: false });
      expect(transport.calls).toHaveLength(3);
    }));

  it('reports changed content on refresh and keeps the previous hash', () =>
    withTempDir(async (dir) => {
      const transport = scripted(ok(['090']), ok(['090', '091']), ok(['090', '091']));
      const h = harness(dir, transport);
      const before = await h.client.request(publicEndpoint(), get());
      const after = await h.client.request(publicEndpoint(), get(), { cache: 'refresh' });
      expect(after.changed).toBe(true);
      expect(eventsOf(h.events, 'changed')).toEqual([
        {
          type: 'changed',
          endpoint: 'snapshot:pfun-64',
          request: get(),
          key: cacheKey(get()),
          previousContentHash: before.contentHash,
          contentHash: after.contentHash,
        },
      ]);
      const again = await h.client.request(publicEndpoint(), get(), { cache: 'refresh' });
      expect(again.changed).toBe(false);
      expect(await new ResponseCache(dir).get(cacheKey(get()))).toMatchObject({
        content_hash: after.contentHash,
        previous_content_hash: before.contentHash,
      });
    }));

  it('refetches a cached body unusable as a whole, but surfaces schema violations', () =>
    withTempDir(async (dir) => {
      const transport = scripted(json({ resultset: [] }), ok(['091']));
      const h = harness(dir, transport);
      await h.client.request(publicEndpoint({ nonEmpty: false }), get());
      // The same entry read by an endpoint for which zero rows are impossible: a miss.
      const refetched = await h.client.request(publicEndpoint(), get());
      expect(refetched).toMatchObject({ source: 'network', changed: true, data: [{ CODE: '091' }] });
      expect(transport.calls).toHaveLength(2);

      const strict = {
        ...publicEndpoint(),
        decode: () => {
          throw new ResponseValidationError('rows changed');
        },
      };
      const error = await h.client.request(strict, get()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResponseValidationError);
      expect(error).toMatchObject({ endpoint: 'snapshot:pfun-64', request: get() });
      expect(transport.calls).toHaveLength(2);
      expect(h.client.isEndpointDisabled('snapshot:pfun-64')).toBe(true);
      expect(eventsOf(h.events, 'validation-error')).toHaveLength(1);
    }));

  it('resumes after an interruption without refetching completed responses', () =>
    withTempDir(async (dir) => {
      const dates = Array.from({ length: 10 }, (_, i) => get(`${String(i + 1).padStart(2, '0')}/06/2026`));
      let served = 0;
      const crashing: Transport = () => {
        if (++served > 6) return Promise.reject(new Error('process killed'));
        return Promise.resolve(ok());
      };
      const first = harness(dir, crashing, { concurrency: 1 });
      const outcomes = await Promise.allSettled(dates.map((r) => first.client.request(publicEndpoint(), r)));
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(6);

      const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(6);
      expect((await readdir(dir, { recursive: true })).some((f) => f.endsWith('.tmp'))).toBe(false);

      const resumed = scripted(ok());
      const second = harness(dir, resumed);
      const results = await Promise.all(dates.map((r) => second.client.request(publicEndpoint(), r)));
      expect(results.filter((r) => r.source === 'cache')).toHaveLength(6);
      expect(resumed.calls).toHaveLength(4);
    }));

  it('stores the unencoded request in the entry', () =>
    withTempDir(async (dir) => {
      const request: HttpRequest = {
        method: 'POST',
        url: 'https://situas.istat.it/ShibO2Module/api/Report/ReportByUrl',
        headers: { 'Content-Type': 'application/json' },
        body: { url: "var_get_ua_reg_lov_rs?&codreg=02&reg=Valle d'Aosta&reg_tipo=2" },
      };
      const h = harness(dir, scripted(ok()));
      await h.client.request(publicEndpoint(), request);
      const file = new ResponseCache(dir).pathFor(cacheKey(request));
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
        request: { method: 'POST', url: request.url, body: request.body },
      });
    }));
});

describe('HttpClient: degradation', () => {
  const seed = async (dir: string) => {
    await harness(dir, scripted(ok(['095']))).client.request(publicEndpoint({ family: 'situas-internal' }), get());
  };

  it('falls back to a stale entry when retries are exhausted', () =>
    withTempDir(async (dir) => {
      await seed(dir);
      const clock = fakeClock(Date.UTC(2026, 11, 1, 10));
      const h = harness(dir, scripted(json({}, 503)), { maxAttempts: 2 }, clock);
      const result = await h.client.request(publicEndpoint({ family: 'situas-internal' }), get(), {
        cache: 'refresh',
        staleFallback: true,
      });
      expect(result).toMatchObject({ source: 'stale-cache', fetchedAt: '2026-10-01', data: [{ CODE: '095' }] });
      expect(eventsOf(h.events, 'degraded')).toMatchObject([
        { endpoint: 'snapshot:pfun-64', fetchedAt: '2026-10-01', request: get() },
      ]);
    }));

  it('falls back when the circuit is open, and fails without an entry or opt-in', () =>
    withTempDir(async (dir) => {
      await seed(dir);
      const h = harness(dir, scripted(json({}, 503)), { circuitBreakerThreshold: 1 });
      const endpoint = publicEndpoint({ family: 'situas-internal' });
      await expect(h.client.request(endpoint, get('09/09/2026'), { staleFallback: true })).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
      expect((await h.client.request(endpoint, get(), { cache: { maxAgeDays: 0 }, staleFallback: true })).source).toBe(
        'cache',
      );
      expect((await h.client.request(endpoint, get(), { cache: 'refresh', staleFallback: true })).source).toBe(
        'stale-cache',
      );
      await expect(h.client.request(endpoint, get(), { cache: 'refresh' })).rejects.toBeInstanceOf(CircuitOpenError);
    }));

  it('does not mask schema violations with stale data', () =>
    withTempDir(async (dir) => {
      await seed(dir);
      const h = harness(dir, scripted(json({ resultset: [{ CODE: 'bad' }] })));
      await expect(
        h.client.request(publicEndpoint({ family: 'situas-internal' }), get(), {
          cache: 'refresh',
          staleFallback: true,
        }),
      ).rejects.toBeInstanceOf(ResponseValidationError);
    }));

  it('does not fall back to stale data for a disabled endpoint', () =>
    withTempDir(async (dir) => {
      await seed(dir);
      const transport = scripted(json({ resultset: [{ CODE: 'bad' }] }));
      const h = harness(dir, transport);
      const endpoint = publicEndpoint({ family: 'situas-internal' });
      await expect(h.client.request(endpoint, get(), { cache: 'refresh' })).rejects.toBeInstanceOf(
        ResponseValidationError,
      );
      for (const cache of ['prefer', 'refresh'] as const) {
        await expect(h.client.request(endpoint, get(), { cache, staleFallback: true })).rejects.toBeInstanceOf(
          EndpointDisabledError,
        );
      }
      expect(transport.calls).toHaveLength(1);
      expect(eventsOf(h.events, 'degraded')).toEqual([]);
    }));
});
