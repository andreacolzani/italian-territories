import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config.ts';
import { cacheKey, ResponseCache } from '../../src/http/cache.ts';
import { HttpClient, type HttpClientEvent } from '../../src/http/client.ts';
import type { Endpoint } from '../../src/http/decode.ts';
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

/** The circuit opens on the N-th failure and the family is given up at once (no probes). */
const GIVE_UP_AT_ONCE = { circuitBreakerMinFailureMs: 0, circuitBreakerMaxOpenMs: 0 };

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

const macrotask = () => new Promise((resolve) => setImmediate(resolve));
const NEIGHBOUR = 'https://neighbour.example/publish/reportspooljson';

/**
 * Answers the neighbours (same family, another host, so another AIMD pool) with success; the rest
 * goes to `transport`, each attempt only after one of those successes, so the family visibly works
 * between attempts.
 */
function withNeighbours(transport: Transport): Transport {
  let waiting: (() => void)[] = [];
  return async (request, options) => {
    await macrotask();
    if (request.url.startsWith(NEIGHBOUR)) {
      const served = waiting;
      waiting = [];
      // Released once the client has recorded this success.
      setImmediate(() => {
        for (const release of served) release();
      });
      return ok();
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    return transport(request, options);
  };
}

/**
 * Settles `main` while other requests of its family keep succeeding, so the family visibly works
 * and a request failing alone gives up with `RetriesExhaustedError` (D38). The harness transport
 * must be wrapped with `withNeighbours`.
 */
async function whileFamilyWorks(h: Harness, main: Promise<unknown>): Promise<{ result: unknown; successes: number }> {
  const main$ = { settled: false };
  let successes = 0;
  const neighbours = (async () => {
    while (!main$.settled) {
      await h.client.request(
        otherEndpoint(),
        { method: 'GET', url: `${NEIGHBOUR}?pfun=49&pdata=01/01/2026` },
        {
          cache: 'refresh',
        },
      );
      successes++;
    }
  })();
  const result = await main.then(
    (value) => value,
    (error: unknown) => error,
  );
  main$.settled = true;
  await neighbours;
  return { result, successes };
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
      const h = harness(dir, withNeighbours(transport), { circuitBreakerThreshold: 100 });
      const { result: error } = await whileFamilyWorks(h, h.client.request(publicEndpoint(), get()));
      expect(error).toBeInstanceOf(RetriesExhaustedError);
      expect(error).toMatchObject({ attempts: 6, lastFailure: 'HTTP 502', endpoint: 'snapshot:pfun-64' });
      expect(transport.calls).toHaveLength(6);
      expect(eventsOf(h.events, 'retry')).toHaveLength(5);
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
      const snapshot = harness(dir, withNeighbours(scripted(slow(200))), settings);
      const { result: error } = await whileFamilyWorks(
        snapshot,
        snapshot.client.request(publicEndpoint({ timeoutClass: 'snapshot' }), get()),
      );
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
      // The gate opens only when all 8 first attempts are inside the transport: they all started
      // before the halving, whatever the scheduling (no wall-clock wait).
      let arrived = 0;
      const transport: Transport = async (request) => {
        if (!failures.has(request.url) && ++arrived === 8) gate.resolve(undefined);
        await gate.promise;
        if (failures.has(request.url)) return ok();
        failures.add(request.url);
        return json({}, 503);
      };
      const h = harness(dir, transport, { concurrency: 8, maxConcurrency: 8 });
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => h.client.request(publicEndpoint(), get(`0${i + 1}/04/2026`))),
      );
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

/**
 * Holds the first `n` attempts until all of them are sent, so `n` requests sent together fail in
 * the same streak whatever the order in which they read the cache.
 */
function inStep(transport: Transport, n = 2): Transport {
  let waiting = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => (release = resolve));
  return async (request, options) => {
    if (waiting < n) {
      if (++waiting === n) release();
      await all;
    }
    return transport(request, options);
  };
}

/** Sends the requests at once; each settles to its result or error. */
function together(h: Harness, endpoint: Endpoint<unknown>, requests: HttpRequest[]): Promise<unknown[]> {
  return Promise.all(requests.map((r) => h.client.request(endpoint, r).catch((e: unknown) => e)));
}

describe('HttpClient: circuit breaker', () => {
  it('without open time allowed, gives a family up after N consecutive failed attempts', () =>
    withTempDir(async (dir) => {
      const transport = scripted(json({}, 503));
      const h = harness(dir, inStep(transport), {
        ...GIVE_UP_AT_ONCE,
        circuitBreakerThreshold: 3,
        maxAttempts: 10,
      });
      const errors = await together(h, publicEndpoint(), [get(), get('02/01/2026')]);
      for (const error of errors) {
        expect(error).toBeInstanceOf(CircuitOpenError);
        expect(error).toMatchObject({
          family: 'situas-public-snapshots',
          reason: expect.stringMatching(/^3 consecutive failures in \d+ ms, last: HTTP 503$/) as string,
        });
      }
      const sent = transport.calls.length;
      expect(sent).toBeLessThanOrEqual(4);

      await expect(h.client.request(publicEndpoint(), get('03/01/2026'))).rejects.toBeInstanceOf(CircuitOpenError);
      expect(transport.calls).toHaveLength(sent);
      expect(h.client.isCircuitLost('situas-public-snapshots')).toBe(true);
      expect(eventsOf(h.events, 'circuit-open')).toEqual([]);
      expect(eventsOf(h.events, 'circuit-lost')).toMatchObject([{ family: 'situas-public-snapshots', openMs: 0 }]);
    }));

  it('keeps families independent and resets the count on success', () =>
    withTempDir(async (dir) => {
      const transport = scripted(json({}, 503), json({}, 503), ok(), json({}, 503), json({}, 503), ok());
      const h = harness(dir, transport, { circuitBreakerThreshold: 3 });
      await h.client.request(publicEndpoint(), get());
      await h.client.request(publicEndpoint(), get('02/01/2026'));
      expect(h.client.isCircuitOpen('situas-public-snapshots')).toBe(false);

      const h2 = harness(join(dir, 'b'), inStep(scripted(json({}, 503))), {
        ...GIVE_UP_AT_ONCE,
        circuitBreakerThreshold: 2,
      });
      const errors = await together(h2, publicEndpoint({ family: 'situas-internal' }), [get(), get('02/01/2026')]);
      expect(errors.every((e) => e instanceof CircuitOpenError)).toBe(true);
      expect(h2.client.isCircuitOpen('situas-internal')).toBe(true);
      expect(h2.client.isCircuitOpen('situas-public-snapshots')).toBe(false);
    }));

  it('separates heavy snapshots from light reports on the same host', () =>
    withTempDir(async (dir) => {
      const transport = inStep((request) => Promise.resolve(request.url.includes('pfun=61') ? json({}, 504) : ok()));
      const h = harness(dir, transport, { ...GIVE_UP_AT_ONCE, circuitBreakerThreshold: 2 });
      const errors = await together(h, publicEndpoint(), [get('01/01/2026', 61), get('02/01/2026', 61)]);
      expect(errors.every((e) => e instanceof CircuitOpenError)).toBe(true);
      const reports = { ...publicEndpoint({ family: 'situas-public-reports' }), id: 'events:pfun-98' };
      expect((await h.client.request(reports, get('01/01/2026', 98))).source).toBe('network');
      expect(h.client.isCircuitOpen('situas-public-snapshots')).toBe(true);
      expect(h.client.isCircuitOpen('situas-public-reports')).toBe(false);
    }));

  it('a request failing alone never opens the circuit: it gives up at the opening threshold', () =>
    withTempDir(async (dir) => {
      const clock = fakeClock();
      const start = clock.clock.now();
      const transport = scripted(json({}, 503));
      // Default timings of the specification: 6 attempts in about 15 s, then one every 60 s while it waits.
      const h = harness(dir, transport, { backoffBaseMs: 1_000, backoffMaxMs: 60_000 }, clock);
      const error = await h.client.request(publicEndpoint(), get()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetriesExhaustedError);
      expect(error).toMatchObject({ attempts: 6, lastFailure: 'HTTP 503' });
      // Ten failures (the threshold) over more than 60 s: about 4 minutes.
      expect(transport.calls).toHaveLength(10);
      expect(clock.clock.now() - start).toBe(255_500);
      expect(eventsOf(h.events, 'request-held')).toHaveLength(1);
      expect(h.events.filter((e) => e.type.startsWith('circuit-'))).toEqual([]);
      // The streak ended with it: the next request starts from a closed, clean circuit.
      expect(h.client.isCircuitOpen('situas-public-snapshots')).toBe(false);
    }));
});

describe('HttpClient: circuit breaker over time (default timings)', () => {
  const DNS = () => new NetworkError('fetch failed', { code: 'ENOTFOUND' });
  /** Fails at the connection until `ms` after the start of the clock, then answers. */
  function outage(clock: ReturnType<typeof fakeClock>, ms: number): Transport & { calls: number[] } {
    const start = clock.clock.now();
    const calls: number[] = [];
    const transport = async (): Promise<HttpResponse> => {
      const at = clock.clock.now() - start;
      calls.push(at);
      // Answer on a later macrotask, so concurrent requests really overlap.
      await new Promise((resolve) => setImmediate(resolve));
      if (at < ms) throw DNS();
      return ok();
    };
    return Object.assign(transport, { calls });
  }
  // Backoff 10 s, 20 s, 30 s, 30 s…: attempts at 0, 10, 30, 60 s.
  const slow = { circuitBreakerThreshold: 3, backoffBaseMs: 20_000, backoffMaxMs: 60_000 };

  it('a few seconds of failures never open the circuit', () =>
    withTempDir(async (dir) => {
      const clock = fakeClock();
      const transport = outage(clock, 5_000);
      const h = harness(dir, transport, { circuitBreakerThreshold: 3, backoffBaseMs: 2_000 }, clock);
      expect((await h.client.request(publicEndpoint(), get())).source).toBe('network');
      // Three failures (0, 1, 3 s), then the attempt at 7 s succeeds.
      expect(transport.calls).toEqual([0, 1_000, 3_000, 7_000]);
      expect(eventsOf(h.events, 'circuit-open')).toEqual([]);
    }));

  it('a long outage opens the circuit; requests wait, a probe closes it and they go on', () =>
    withTempDir(async (dir) => {
      const clock = fakeClock();
      const transport = outage(clock, 200_000);
      const h = harness(dir, inStep(transport), slow, clock);
      const results = await together(h, publicEndpoint(), [get(), get('02/01/2026')]);
      expect(results.map((r) => (r as { source: string }).source)).toEqual(['network', 'network']);
      const circuit = h.events.filter((e) => e.type.startsWith('circuit-'));
      expect(circuit[0]).toMatchObject({
        type: 'circuit-open',
        reason: expect.stringMatching(/consecutive failures in \d+ ms, last: network error: fetch failed$/) as string,
        retryInMs: 60_000,
        reopened: false,
      });
      expect(circuit.at(-1)).toMatchObject({ type: 'circuit-closed' });
      expect(eventsOf(h.events, 'circuit-lost')).toEqual([]);
      expect(h.client.isCircuitOpen('situas-public-snapshots')).toBe(false);
    }));

  it('an outage of 45 s loses no request: those out of attempts wait for their family', () =>
    withTempDir(async (dir) => {
      const clock = fakeClock();
      const transport = outage(clock, 45_000);
      const h = harness(dir, inStep(transport, 4), {}, clock);
      const dates = ['01/01/2026', '02/01/2026', '03/01/2026', '04/01/2026'];
      const results = await Promise.all(dates.map((d) => h.client.request(publicEndpoint(), get(d))));
      expect(results.map((r) => r.source)).toEqual(['network', 'network', 'network', 'network']);
      // Out of attempts after a few seconds, they waited instead of failing (how many depends on
      // how the concurrent requests interleave); none was lost and the circuit never opened.
      expect(eventsOf(h.events, 'request-held').length).toBeGreaterThan(0);
      expect(eventsOf(h.events, 'request-held').every((e) => e.attempts === 6)).toBe(true);
      expect(h.events.filter((e) => e.type.startsWith('circuit-'))).toEqual([]);
    }));

  it('a request failing alone in a working family still fails with RetriesExhaustedError', () =>
    withTempDir(async (dir) => {
      const h = harness(dir, withNeighbours(scripted(json({}, 504))), {});
      const { result, successes } = await whileFamilyWorks(
        h,
        h.client.request(publicEndpoint(), get('01/01/2026', 61)),
      );
      expect(result).toBeInstanceOf(RetriesExhaustedError);
      expect(successes).toBeGreaterThan(0);
      expect(eventsOf(h.events, 'request-held')).toEqual([]);
    }));

  it('a request failing alone with no other traffic waits: the family may be down', () =>
    withTempDir(async (dir) => {
      const clock = fakeClock();
      const transport = outage(clock, 45_000);
      const h = harness(dir, transport, {}, clock);
      expect((await h.client.request(publicEndpoint(), get())).source).toBe('network');
      expect(eventsOf(h.events, 'request-held')).toMatchObject([{ attempts: 6 }]);
      // Out of attempts at 1.55 s, then one try every backoffMaxMs (10 s) until the outage ends.
      expect(transport.calls.slice(6)).toEqual([11_550, 21_550, 31_550, 41_550, 51_550]);
    }));

  it('an outage longer than the maximum open time gives the family up for the run', () =>
    withTempDir(async (dir) => {
      const clock = fakeClock();
      const transport = outage(clock, Number.POSITIVE_INFINITY);
      const h = harness(dir, inStep(transport), slow, clock);
      const errors = await together(h, publicEndpoint(), [get(), get('02/01/2026')]);
      for (const error of errors) {
        expect(error).toBeInstanceOf(CircuitOpenError);
        expect(error).toMatchObject({
          reason: 'open for 900000 ms in total, last: probe failed: network error: fetch failed',
        });
      }
      // Opened, then reopened by three failed probes (after 60, 120 and 240 s); the fourth, at the
      // 15-minute limit, gives the family up.
      const delays = eventsOf(h.events, 'circuit-open').map((e) => e.retryInMs);
      expect(delays.slice(0, 3)).toEqual([60_000, 120_000, 240_000]);
      // The last cooldown (480 s) is cut at the limit, measured from the opening.
      expect(delays[3]).toBeGreaterThan(470_000);
      expect(delays[3]).toBeLessThanOrEqual(480_000);
      expect(eventsOf(h.events, 'circuit-lost')).toMatchObject([{ openMs: 900_000 }]);
      expect(h.client.isCircuitLost('situas-public-snapshots')).toBe(true);
      // Later requests of the family fail at once, without being sent.
      const sent = transport.calls.length;
      await expect(h.client.request(publicEndpoint(), get('03/01/2026'))).rejects.toBeInstanceOf(CircuitOpenError);
      expect(transport.calls).toHaveLength(sent);
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
      const h = harness(dir, withNeighbours(transport), { circuitBreakerThreshold: 100 });
      const { result: error } = await whileFamilyWorks(h, h.client.request(publicEndpoint(), get()));
      expect(error).toBeInstanceOf(RetriesExhaustedError);
      expect(error).toMatchObject({ attempts: 3 });
      expect(transport.calls).toHaveLength(3);
      expect(await new ResponseCache(dir).get(cacheKey(get()))).toBeUndefined();
    }));

  it('counts transient invalid responses for the circuit breaker', () =>
    withTempDir(async (dir) => {
      const h = harness(dir, inStep(scripted(html())), { ...GIVE_UP_AT_ONCE, circuitBreakerThreshold: 2 });
      const errors = await together(h, publicEndpoint(), [get(), get('02/01/2026')]);
      expect(errors.every((e) => e instanceof CircuitOpenError)).toBe(true);
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
      expect(eventsOf(h.events, 'validation-error')).toMatchObject([{ disabled: true }]);
      expect(h.client.disabledEndpoints()).toEqual([
        { endpoint: 'snapshot:pfun-64', cause: `invalid rows: ${rve.message}`, refused: 1 },
      ]);

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
      const h2 = harness(join(dir, 'b'), transport, { ...GIVE_UP_AT_ONCE, circuitBreakerThreshold: 2 });
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
      const h = harness(dir, inStep(scripted(json({}, 503))), { ...GIVE_UP_AT_ONCE, circuitBreakerThreshold: 2 });
      const endpoint = publicEndpoint({ family: 'situas-internal' });
      // Two requests without a cache entry lose the family (a single one would give up alone).
      const lost = await Promise.all(
        [get('09/09/2026'), get('10/09/2026')].map((r) =>
          h.client.request(endpoint, r, { staleFallback: true }).catch((e: unknown) => e),
        ),
      );
      expect(lost.every((e) => e instanceof CircuitOpenError)).toBe(true);
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
