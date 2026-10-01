import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AdaptiveLimiter } from '../../src/http/adaptive-limiter.ts';
import { fullJitterDelay, parseRetryAfter } from '../../src/http/backoff.ts';
import { cacheKey, isFresh, normaliseUrl, ResponseCache, sha256, type CacheEntry } from '../../src/http/cache.ts';
import { CircuitBreaker } from '../../src/http/circuit-breaker.ts';
import {
  assertContentType,
  CONTENT_TYPES,
  jsonRowsDecoder,
  parseJsonBody,
  textDecoder,
} from '../../src/http/decode.ts';
import { encodeQueryComponent, encodeRequest, encodeUrlQuery } from '../../src/http/encode.ts';
import { ResponseValidationError, TransientResponseError } from '../../src/http/errors.ts';
import { TokenBucket } from '../../src/http/token-bucket.ts';
import type { HttpResponse } from '../../src/http/transport.ts';
import { fakeClock, withTempDir } from '../helpers/http.ts';

const PUBLIC = 'https://situas-servizi.istat.it/publish/reportspooljson';
const INTERNAL = 'https://situas.istat.it/ShibO2Module/api/Report/ReportByUrl';

describe('encoding', () => {
  it('encodes strictly per RFC 3986', () => {
    expect(encodeQueryComponent("Valle d'Aosta/Vallée d'Aoste")).toBe('Valle%20d%27Aosta%2FVall%C3%A9e%20d%27Aoste');
    expect(encodeQueryComponent('a(b)*!')).toBe('a%28b%29%2A%21');
    expect(encodeQueryComponent('21/01/2024')).toBe('21%2F01%2F2024');
  });

  it('encodes names and values, keeping empty segments and the first = only', () => {
    expect(encodeUrlQuery(`${PUBLIC}?pfun=61&pdata=21/01/2024`)).toBe(`${PUBLIC}?pfun=61&pdata=21%2F01%2F2024`);
    expect(encodeUrlQuery('var_get_ua_uts_lov_rs?&uts=Sud Sardegna&coduts=111&uts_tipo=1')).toBe(
      'var_get_ua_uts_lov_rs?&uts=Sud%20Sardegna&coduts=111&uts_tipo=1',
    );
    expect(encodeUrlQuery('r?a=x=y&flag')).toBe('r?a=x%3Dy&flag');
    expect(encodeUrlQuery('https://example.org/no-query')).toBe('https://example.org/no-query');
  });

  it('encodes the report URL inside internal API bodies and nothing else', () => {
    const request = {
      method: 'POST' as const,
      url: INTERNAL,
      headers: { Accept: 'application/json' },
      body: { url: 'var_get_ua_comuni_lov_rs?procom=021008&com=Bolzano/Bozen' },
    };
    expect(encodeRequest(request)).toEqual({
      ...request,
      body: { url: 'var_get_ua_comuni_lov_rs?procom=021008&com=Bolzano%2FBozen' },
    });
    expect(request.body.url).toContain('Bolzano/Bozen');
    expect(encodeRequest({ method: 'POST', url: INTERNAL, body: { other: 'a b' } }).body).toEqual({ other: 'a b' });
  });
});

describe('backoff', () => {
  it('uses full jitter under an exponential, capped ceiling', () => {
    expect(fullJitterDelay(1, 1000, 60_000, () => 0.999)).toBe(999);
    expect(fullJitterDelay(3, 1000, 60_000, () => 0.5)).toBe(2000);
    expect(fullJitterDelay(10, 1000, 60_000, () => 0.5)).toBe(30_000);
    expect(fullJitterDelay(4, 1000, 60_000, () => 0)).toBe(0);
  });

  it('parses Retry-After as seconds or HTTP-date', () => {
    const now = Date.UTC(2026, 9, 1, 10);
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter(' 7 ', now)).toBe(7000);
    expect(parseRetryAfter('Thu, 01 Oct 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Thu, 01 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
  });
});

describe('TokenBucket', () => {
  it('spaces requests at the configured rate after the initial burst', async () => {
    const { clock, sleeps } = fakeClock();
    const bucket = new TokenBucket(2, clock);
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, () =>
        bucket.take().then(() => {
          times.push(clock.now());
        }),
      ),
    );
    const start = times[0] ?? 0;
    expect(times.map((t) => t - start)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(sleeps).toEqual([500, 500, 500, 500]);
  });

  it('refills while idle up to its capacity', async () => {
    const { clock, sleeps, advance } = fakeClock();
    const bucket = new TokenBucket(1, clock, 2);
    await bucket.take();
    await bucket.take();
    advance(10_000);
    await bucket.take();
    await bucket.take();
    expect(sleeps).toEqual([]);
    await bucket.take();
    expect(sleeps).toEqual([1000]);
  });
});

describe('AdaptiveLimiter', () => {
  it('never exceeds its limit and hands slots over in FIFO order', async () => {
    const limiter = new AdaptiveLimiter({ initial: 2, max: 4, increaseAfter: 100 });
    await limiter.acquire();
    await limiter.acquire();
    const order: number[] = [];
    const waiting = [1, 2].map((n) =>
      limiter.acquire().then(() => {
        order.push(n);
      }),
    );
    expect(limiter.inFlight).toBe(2);
    limiter.release();
    await waiting[0];
    expect(order).toEqual([1]);
    expect(limiter.inFlight).toBe(2);
    limiter.release();
    await waiting[1];
    expect(order).toEqual([1, 2]);
  });

  it('adds one slot after K consecutive fast successes, up to max', () => {
    const changes: number[] = [];
    const limiter = new AdaptiveLimiter({ initial: 1, max: 2, increaseAfter: 2, onChange: (l) => changes.push(l) });
    limiter.recordSuccess(true);
    limiter.recordSuccess(false); // a slow success resets the streak
    limiter.recordSuccess(true);
    expect(limiter.limit).toBe(1);
    limiter.recordSuccess(true);
    expect(limiter.limit).toBe(2);
    for (let i = 0; i < 10; i++) limiter.recordSuccess(true);
    expect(limiter.limit).toBe(2);
    expect(changes).toEqual([2]);
  });

  it('halves once per congestion episode, never below 1', async () => {
    const limiter = new AdaptiveLimiter({ initial: 8, max: 8, increaseAfter: 1 });
    const epochs = await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    for (const epoch of epochs) {
      limiter.recordFailure(epoch);
      limiter.release();
    }
    expect(limiter.limit).toBe(4);
    const failOnce = async (): Promise<void> => {
      limiter.recordFailure(await limiter.acquire());
      limiter.release();
    };
    await failOnce();
    expect(limiter.limit).toBe(2);
    await failOnce();
    await failOnce();
    expect(limiter.limit).toBe(1);
  });

  it('wakes waiters when the limit grows', async () => {
    const limiter = new AdaptiveLimiter({ initial: 1, max: 2, increaseAfter: 1 });
    await limiter.acquire();
    let woken = false;
    const waiting = limiter.acquire().then(() => (woken = true));
    limiter.recordSuccess(true);
    await waiting;
    expect(woken).toBe(true);
    expect(limiter.inFlight).toBe(2);
  });
});

describe('CircuitBreaker', () => {
  it('opens a family after N consecutive failures and stays open', () => {
    const breaker = new CircuitBreaker(3);
    expect(breaker.recordFailure('a', 'HTTP 503')).toBe(false);
    expect(breaker.recordFailure('a', 'HTTP 503')).toBe(false);
    breaker.recordSuccess('a');
    expect(breaker.recordFailure('a', 'HTTP 503')).toBe(false);
    expect(breaker.recordFailure('a', 'HTTP 503')).toBe(false);
    expect(breaker.recordFailure('a', 'timeout')).toBe(true);
    expect(breaker.reason('a')).toBe('3 consecutive failures, last: timeout');
    breaker.recordSuccess('a');
    expect(breaker.isOpen('a')).toBe(true);
    expect(breaker.isOpen('b')).toBe(false);
  });
});

describe('cache keys', () => {
  it('normalises scheme, host and query order', () => {
    expect(normaliseUrl('HTTPS://Situas-Servizi.Istat.IT/publish/reportspooljson?pdata=01/01/2026&pfun=64')).toBe(
      `${PUBLIC}?pdata=01/01/2026&pfun=64`,
    );
    expect(normaliseUrl('var_get_ua_uts_lov_rs?&uts=Nuoro&coduts=114&uts_tipo=1')).toBe(
      'var_get_ua_uts_lov_rs?coduts=114&uts=Nuoro&uts_tipo=1',
    );
  });

  it('depends on method, URL and body only', () => {
    const get = { method: 'GET' as const, url: `${PUBLIC}?pfun=64&pdata=01/01/2026` };
    expect(cacheKey(get)).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({ ...get, url: `${PUBLIC}?pdata=01/01/2026&pfun=64`, headers: { 'User-Agent': 'x' } })).toBe(
      cacheKey(get),
    );
    expect(cacheKey({ ...get, url: `${PUBLIC}?pfun=64&pdata=02/01/2026` })).not.toBe(cacheKey(get));
    expect(cacheKey({ ...get, method: 'POST' })).not.toBe(cacheKey(get));

    const post = (url: string, extra = {}) => ({ method: 'POST' as const, url: INTERNAL, body: { url, ...extra } });
    expect(cacheKey(post('var_get_ua_uts_lov_rs?&uts=Nuoro&coduts=114&uts_tipo=1'))).toBe(
      cacheKey(post('var_get_ua_uts_lov_rs?coduts=114&uts=Nuoro&uts_tipo=1')),
    );
    expect(cacheKey(post('r?a=1', { b: 1, c: 2 }))).toBe(
      cacheKey({ method: 'POST', url: INTERNAL, body: { c: 2, url: 'r?a=1', b: 1 } }),
    );
    expect(cacheKey(post('var_get_ua_uts_lov_rs?uts=Nuoro'))).not.toBe(
      cacheKey(post('var_get_ua_uts_lov_rs?uts=Oristano')),
    );
  });

  it('evaluates freshness policies', () => {
    const entry = { fetched_at: '2026-09-28' } as CacheEntry;
    expect(isFresh(entry, 'prefer', '2027-01-01')).toBe(true);
    expect(isFresh(entry, 'refresh', '2026-09-28')).toBe(false);
    expect(isFresh(entry, { maxAgeDays: 3 }, '2026-10-01')).toBe(true);
    expect(isFresh(entry, { maxAgeDays: 2 }, '2026-10-01')).toBe(false);
    expect(isFresh(entry, { maxAgeDays: 0 }, '2026-09-28')).toBe(true);
  });
});

describe('ResponseCache', () => {
  const entry = (key: string, body = '{"resultset":[]}'): CacheEntry => ({
    version: 1,
    key,
    request: { method: 'GET', url: `${PUBLIC}?pfun=64&pdata=01/01/2026` },
    fetched_at: '2026-10-01',
    status: 200,
    content_type: 'application/json',
    content_hash: sha256(body),
    previous_content_hash: null,
    body,
  });

  it('round-trips entries and leaves no temporary files', () =>
    withTempDir(async (dir) => {
      const cache = new ResponseCache(dir);
      const key = sha256('k');
      expect(await cache.get(key)).toBeUndefined();
      await cache.put(entry(key));
      expect(await cache.get(key)).toEqual(entry(key));
      expect(await readdir(dirname(cache.pathFor(key)))).toEqual([`${key}.json`]);
    }));

  it('treats unreadable or foreign entries as misses', () =>
    withTempDir(async (dir) => {
      const cache = new ResponseCache(dir);
      const key = sha256('k');
      await mkdir(dirname(cache.pathFor(key)), { recursive: true });
      await writeFile(cache.pathFor(key), '{"version":1,"key":"trunc');
      expect(await cache.get(key)).toBeUndefined();
      await writeFile(cache.pathFor(key), JSON.stringify(entry(sha256('other'))));
      expect(await cache.get(key)).toBeUndefined();
    }));
});

describe('decoders', () => {
  const response = (body: string, contentType: string | null = 'application/json'): HttpResponse => ({
    status: 200,
    headers: contentType === null ? {} : { 'content-type': contentType },
    body,
  });
  const internal = jsonRowsDecoder({
    contentTypes: CONTENT_TYPES.situasInternal,
    envelope: 'items',
    nonEmpty: false,
    row: z.object({ 'tipo variazione': z.string() }),
  });

  it('decodes double-encoded internal bodies and plain empty ones', () => {
    const document = { items: [{ 'tipo variazione': 'PV', extra: 1 }] };
    expect(internal(response(JSON.stringify(JSON.stringify(document)), 'application/json; charset=utf-8'))).toEqual([
      { 'tipo variazione': 'PV' },
    ]);
    expect(internal(response('{\n"items":[\n]\n}', 'text/plain; charset=utf-8'))).toEqual([]);
    expect(parseJsonBody(JSON.stringify(document))).toEqual(document);
  });

  it('classifies whole-response problems as transient', () => {
    const snapshot = jsonRowsDecoder({
      contentTypes: CONTENT_TYPES.situasPublic,
      envelope: 'resultset',
      nonEmpty: true,
      row: z.object({ CODE: z.string() }),
    });
    expect(() => snapshot(response('<html>maintenance</html>', 'text/html'))).toThrow(TransientResponseError);
    expect(() => snapshot(response('{}', null))).toThrow(/content type '\(none\)'/);
    expect(() => snapshot(response('{"resultset":'))).toThrow(/not valid JSON/);
    expect(() => snapshot(response('{"items":[]}'))).toThrow(/missing 'resultset'/);
    expect(() => snapshot(response('null'))).toThrow(TransientResponseError);
    expect(() => snapshot(response('{"resultset":[]}'))).toThrow(/is empty/);
  });

  it('reports schema violations as permanent, with the offending rows', () => {
    const decode = jsonRowsDecoder({
      contentTypes: CONTENT_TYPES.situasPublic,
      envelope: 'resultset',
      nonEmpty: true,
      row: z.object({ CODE: z.string() }),
    });
    const error = (() => {
      try {
        decode(response(JSON.stringify({ resultset: [{ CODE: '001' }, { NAME: 'x' }, { CODE: 2 }] })));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ResponseValidationError);
    const rve = error as ResponseValidationError;
    expect(rve.message).toBe('2 of 3 rows violate the schema');
    expect(rve.issues.map((i) => [i.index, i.row])).toEqual([
      [1, { NAME: 'x' }],
      [2, { CODE: 2 }],
    ]);
  });

  it('checks content types for text bodies', () => {
    const csv = textDecoder({ contentTypes: CONTENT_TYPES.anpr, nonEmpty: true });
    expect(csv(response('A;B\r\n', 'text/csv'))).toBe('A;B\r\n');
    expect(() => csv(response('', 'text/csv'))).toThrow(TransientResponseError);
    expect(() => {
      assertContentType(response('x', 'text/html; charset=utf-8'), CONTENT_TYPES.anpr);
    }).toThrow(/unexpected content type 'text\/html'/);
  });
});
