/**
 * HTTP client of §6.1, shared by every adapter: AIMD worker pool and token bucket per host,
 * retries with full-jitter backoff and `Retry-After`, per-class timeouts, circuit breaker per
 * family (half-open probes, given up after a maximum open time), endpoints disabled by permanent validation errors, `User-Agent`, response cache with
 * per-call freshness, response validation and degradation.
 */
import type { Config } from '../config.ts';
import { currentDate, type IsoDate } from '../dates/index.ts';
import { AdaptiveLimiter } from './adaptive-limiter.ts';
import { fullJitterDelay, parseRetryAfter } from './backoff.ts';
import { cacheKey, isFresh, ResponseCache, sha256, type CacheEntry, type CachePolicy } from './cache.ts';
import { CircuitBreaker, type Transition } from './circuit-breaker.ts';
import { systemClock, type Clock } from './clock.ts';
import { mediaType, type Endpoint, type Family } from './decode.ts';
import {
  CircuitOpenError,
  EndpointDisabledError,
  HttpStatusError,
  isUnavailable,
  ResponseValidationError,
  RetriesExhaustedError,
  TransientResponseError,
} from './errors.ts';
import { createFetchTransport } from './fetch-transport.ts';
import { TokenBucket } from './token-bucket.ts';
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from './transport.ts';

export type HttpSettings = Config['http'];

/** Notifications for logging and anomaly reporting (§8.2); the client never decides severity. */
export type HttpClientEvent =
  | { type: 'retry'; endpoint: string; request: HttpRequest; attempt: number; reason: string; delayMs: number }
  | { type: 'concurrency'; host: string; limit: number }
  /** The family's circuit opened (or a probe failed and it reopened); a probe follows in `retryInMs`. */
  | { type: 'circuit-open'; family: Family; reason: string; retryInMs: number; reopened: boolean }
  | { type: 'circuit-closed'; family: Family; openMs: number }
  /**
   * The request ran out of attempts while other requests of its family were failing too: it waits
   * for the family's verdict instead of failing (once per request).
   */
  | { type: 'request-held'; endpoint: string; request: HttpRequest; attempts: number; reason: string }
  /** Open for `circuitBreakerMaxOpenMs` in total: the family is given up for the run. */
  | { type: 'circuit-lost'; family: Family; reason: string; openMs: number }
  /**
   * A permanent validation error; `disabled` when it is the one that disabled the endpoint for the
   * rest of the run (once per endpoint; later errors of requests already in flight are `false`).
   */
  | {
      type: 'validation-error';
      endpoint: string;
      request: HttpRequest;
      error: ResponseValidationError;
      disabled: boolean;
    }
  | {
      type: 'changed';
      endpoint: string;
      request: HttpRequest;
      key: string;
      previousContentHash: string;
      contentHash: string;
    }
  | { type: 'degraded'; endpoint: string; request: HttpRequest; fetchedAt: IsoDate; reason: string };

export interface HttpClientOptions {
  http: HttpSettings;
  /** Directory of the response cache (`config.paths.httpCache`). */
  cacheDir: string;
  transport?: Transport;
  clock?: Clock;
  /** Uniform in `[0, 1)`; drives the backoff jitter. */
  random?: () => number;
  onEvent?: (event: HttpClientEvent) => void;
}

export interface RequestOptions {
  /** Freshness policy (default `prefer`). */
  cache?: CachePolicy;
  /** On unavailability (open circuit, exhausted retries) return any cached entry as stale. */
  staleFallback?: boolean;
}

export interface ClientResult<T> {
  data: T;
  /** `stale-cache`: the network failed and an older entry was used (§6.1 degradation). */
  source: 'network' | 'cache' | 'stale-cache';
  fetchedAt: IsoDate;
  contentHash: string;
  /** A refetch replaced cached content with different content. */
  changed: boolean;
}

type AttemptOutcome<T> =
  | { ok: true; response: HttpResponse; data: T; latencyMs: number }
  | { ok: false; reason: string; transient: boolean; retryAfterMs: number | null };

const TIMEOUT = Symbol('timeout');

/** Congestion state of one host (§6.1 host scope). */
interface HostScope {
  limiter: AdaptiveLimiter;
  bucket: TokenBucket;
}

export class HttpClient {
  readonly #http: HttpSettings;
  readonly #cache: ResponseCache;
  readonly #transport: Transport;
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #onEvent: (event: HttpClientEvent) => void;
  readonly #hosts = new Map<string, HostScope>();
  readonly #breaker: CircuitBreaker;
  /** Endpoint id → reason, for endpoints disabled by a permanent validation error. */
  readonly #disabled = new Map<string, string>();
  /** Endpoint id → requests refused because the endpoint was disabled. */
  readonly #refused = new Map<string, number>();

  constructor(options: HttpClientOptions) {
    this.#http = options.http;
    this.#cache = new ResponseCache(options.cacheDir);
    this.#transport = options.transport ?? createFetchTransport();
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#breaker = new CircuitBreaker(
      {
        threshold: options.http.circuitBreakerThreshold,
        minFailureMs: options.http.circuitBreakerMinFailureMs,
        cooldownMs: options.http.circuitBreakerCooldownMs,
        maxCooldownMs: options.http.circuitBreakerMaxCooldownMs,
        maxOpenMs: options.http.circuitBreakerMaxOpenMs,
      },
      this.#clock,
    );
  }

  /** Current AIMD concurrency limit of a host (e.g. `situas.istat.it`). */
  concurrency(host: string): number {
    return this.#hosts.get(host)?.limiter.limit ?? this.#http.concurrency;
  }

  /** Open (requests held until a probe succeeds) or lost for the run. */
  isCircuitOpen(family: Family): boolean {
    return this.#breaker.isOpen(family);
  }

  /** Given up for the rest of the run (open for `circuitBreakerMaxOpenMs` in total). */
  isCircuitLost(family: Family): boolean {
    return this.#breaker.isLost(family);
  }

  /** Endpoints disabled in this run, with the cause and the requests refused since, by endpoint id. */
  disabledEndpoints(): { endpoint: string; cause: string; refused: number }[] {
    return [...this.#disabled]
      .map(([endpoint, cause]) => ({ endpoint, cause, refused: this.#refused.get(endpoint) ?? 0 }))
      .sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0));
  }

  isEndpointDisabled(endpoint: string): boolean {
    return this.#disabled.has(endpoint);
  }

  async request<T>(
    endpoint: Endpoint<T>,
    request: HttpRequest,
    options: RequestOptions = {},
  ): Promise<ClientResult<T>> {
    const disabled = this.#disabled.get(endpoint.id);
    if (disabled !== undefined) {
      this.#refused.set(endpoint.id, (this.#refused.get(endpoint.id) ?? 0) + 1);
      throw new EndpointDisabledError(endpoint.id, request, disabled);
    }

    const key = cacheKey(request);
    const cached = await this.#cache.get(key);
    const today = currentDate(new Date(this.#clock.now()));

    if (cached !== undefined && isFresh(cached, options.cache ?? 'prefer', today)) {
      try {
        return this.#fromCache(endpoint, cached, 'cache');
      } catch (error) {
        // A cached body that is unusable as a whole is a miss; schema violations surface.
        if (error instanceof ResponseValidationError) this.#disable(error, endpoint, request);
        if (!(error instanceof TransientResponseError)) throw error;
      }
    }

    let response: HttpResponse;
    let data: T;
    try {
      ({ response, data } = await this.#fetch(endpoint, request));
    } catch (error) {
      if (options.staleFallback === true && cached !== undefined && isUnavailable(error)) {
        const result = this.#fromCache(endpoint, cached, 'stale-cache');
        this.#onEvent({
          type: 'degraded',
          endpoint: endpoint.id,
          request,
          fetchedAt: cached.fetched_at,
          reason: error.message,
        });
        return result;
      }
      throw error;
    }

    const contentHash = sha256(response.body);
    const changed = cached !== undefined && cached.content_hash !== contentHash;
    await this.#cache.put({
      version: 1,
      key,
      request: {
        method: request.method,
        url: request.url,
        ...(request.body === undefined ? {} : { body: request.body }),
      },
      fetched_at: today,
      status: response.status,
      content_type: response.headers['content-type'] ?? null,
      content_hash: contentHash,
      previous_content_hash: changed ? cached.content_hash : (cached?.previous_content_hash ?? null),
      body: response.body,
    });
    if (changed) {
      this.#onEvent({
        type: 'changed',
        endpoint: endpoint.id,
        request,
        key,
        previousContentHash: cached.content_hash,
        contentHash,
      });
    }
    return { data, source: 'network', fetchedAt: today, contentHash, changed };
  }

  #fromCache<T>(endpoint: Endpoint<T>, entry: CacheEntry, source: 'cache' | 'stale-cache'): ClientResult<T> {
    const headers: Record<string, string> = entry.content_type === null ? {} : { 'content-type': entry.content_type };
    return {
      data: endpoint.decode({ status: entry.status, headers, body: entry.body }),
      source,
      fetchedAt: entry.fetched_at,
      contentHash: entry.content_hash,
      changed: false,
    };
  }

  /** Permanent validation error: disables the endpoint only, never the family or the host. */
  #disable(error: ResponseValidationError, endpoint: Endpoint<unknown>, request: HttpRequest): void {
    error.endpoint = endpoint.id;
    error.request = request;
    const disabling = !this.#disabled.has(endpoint.id);
    if (disabling) this.#disabled.set(endpoint.id, `invalid rows: ${error.message}`);
    this.#onEvent({ type: 'validation-error', endpoint: endpoint.id, request, error, disabled: disabling });
  }

  #hostScope(request: HttpRequest): HostScope {
    const host = new URL(request.url).host;
    let scope = this.#hosts.get(host);
    if (scope === undefined) {
      scope = {
        limiter: new AdaptiveLimiter({
          initial: this.#http.concurrency,
          max: this.#http.maxConcurrency,
          increaseAfter: this.#http.aimdIncreaseAfter,
          onChange: (limit) => {
            this.#onEvent({ type: 'concurrency', host, limit });
          },
        }),
        bucket: new TokenBucket(this.#http.requestsPerSecond, this.#clock),
      };
      this.#hosts.set(host, scope);
    }
    return scope;
  }

  async #fetch<T>(endpoint: Endpoint<T>, request: HttpRequest): Promise<{ response: HttpResponse; data: T }> {
    const { family } = endpoint;
    const { limiter, bucket } = this.#hostScope(request);
    const timeoutMs =
      endpoint.timeoutClass === 'snapshot' ? this.#http.timeouts.snapshotMs : this.#http.timeouts.defaultMs;
    let transientFailures = 0;
    /** Successes of the family when this request first failed: a later one means the family works. */
    let successesAtFailure: number | undefined;
    /** Identifies this request in its family's failure streak. */
    const token = Symbol(endpoint.id);
    let held = false;

    for (let attempt = 1; ;) {
      // An open circuit holds the request (no attempt spent) until it closes, probes or is lost.
      const admission = await this.#breaker.admit(family);
      if (admission.kind === 'lost') throw new CircuitOpenError(endpoint.id, request, family, admission.reason);
      const probe = admission.kind === 'probe';

      const epoch = await limiter.acquire();
      let outcome: AttemptOutcome<T>;
      try {
        await bucket.take();
        outcome = await this.#attempt(endpoint, request, timeoutMs);
      } catch (error) {
        // Neither AIMD nor the circuit breaker hear about it: only transport failures and
        // transient validation errors are congestion or availability signals.
        if (error instanceof ResponseValidationError) this.#disable(error, endpoint, request);
        if (probe) this.#breaker.abandonProbe(family);
        throw error;
      } finally {
        limiter.release();
      }

      if (outcome.ok) {
        this.#transition(family, this.#breaker.recordSuccess(family));
        limiter.recordSuccess(outcome.latencyMs <= this.#http.aimdFastFraction * timeoutMs);
        return outcome;
      }

      limiter.recordFailure(epoch);
      successesAtFailure ??= this.#breaker.successes(family);
      const transition = this.#breaker.recordFailure(family, outcome.reason, probe, token);
      // Failing alone for as long as it takes to open a circuit: this request, not its family.
      if (transition?.kind === 'alone') throw new RetriesExhaustedError(endpoint.id, request, attempt, outcome.reason);
      this.#transition(family, transition);
      // A failed probe is the circuit's attempt, not the request's: it waits for the next one.
      if (probe) continue;
      if (outcome.transient) transientFailures++;
      if (attempt >= this.#http.maxAttempts || transientFailures > this.#http.transientValidationRetries) {
        // Out of attempts: the request fails alone only when its family works (D38).
        const reason = this.#breaker.lostReason(family);
        if (reason !== undefined) throw new CircuitOpenError(endpoint.id, request, family, reason);
        if (this.#breaker.isOpen(family)) continue;
        if (this.#breaker.successes(family) !== successesAtFailure) {
          throw new RetriesExhaustedError(endpoint.id, request, attempt, outcome.reason);
        }
        if (!held) {
          held = true;
          this.#onEvent({
            type: 'request-held',
            endpoint: endpoint.id,
            request,
            attempts: attempt,
            reason: outcome.reason,
          });
        }
        const verdict = await this.#breaker.awaitVerdict(family, this.#http.backoffMaxMs);
        if (verdict.kind === 'lost') throw new CircuitOpenError(endpoint.id, request, family, verdict.reason);
        continue;
      }
      attempt++;
      if (this.#breaker.isOpen(family)) continue;

      const backoff = fullJitterDelay(attempt - 1, this.#http.backoffBaseMs, this.#http.backoffMaxMs, this.#random);
      const delayMs = Math.max(backoff, Math.min(outcome.retryAfterMs ?? 0, this.#http.retryAfterMaxMs));
      this.#onEvent({
        type: 'retry',
        endpoint: endpoint.id,
        request,
        attempt: attempt - 1,
        reason: outcome.reason,
        delayMs,
      });
      await this.#clock.sleep(delayMs);
    }
  }

  #transition(family: Family, transition: Transition | null): void {
    if (transition === null) return;
    switch (transition.kind) {
      case 'opened':
      case 'reopened':
        this.#onEvent({
          type: 'circuit-open',
          family,
          reason: transition.reason,
          retryInMs: transition.retryInMs,
          reopened: transition.kind === 'reopened',
        });
        return;
      case 'closed':
        this.#onEvent({ type: 'circuit-closed', family, openMs: transition.openMs });
        return;
      case 'lost':
        this.#onEvent({ type: 'circuit-lost', family, reason: transition.reason, openMs: transition.openMs });
        return;
      case 'alone':
        return;
    }
  }

  /** One attempt. Returns retryable failures; throws non-retryable ones. */
  async #attempt<T>(endpoint: Endpoint<T>, request: HttpRequest, timeoutMs: number): Promise<AttemptOutcome<T>> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMEOUT);
      }, timeoutMs);
    });
    const started = this.#clock.now();
    const sent: HttpRequest = { ...request, headers: { ...request.headers, 'User-Agent': this.#http.userAgent } };

    let response: HttpResponse | typeof TIMEOUT;
    try {
      // Racing makes the timeout hold even for transports that ignore the abort signal; a
      // transport that settles after the timeout must not surface as an unhandled rejection.
      const pending = this.#transport(sent, { signal: controller.signal });
      pending.catch(() => undefined);
      response = await Promise.race([pending, timeout]);
    } catch (error) {
      if (controller.signal.aborted) return failure(`timeout after ${timeoutMs} ms`);
      if (error instanceof NetworkError) return failure(`network error: ${error.message}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response === TIMEOUT) return failure(`timeout after ${timeoutMs} ms`);

    const { status } = response;
    if (status === 429 || status >= 500) {
      return failure(`HTTP ${status}`, false, parseRetryAfter(response.headers['retry-after'], this.#clock.now()));
    }
    if (status < 200 || status >= 300) throw new HttpStatusError(endpoint.id, request, status);

    try {
      return { ok: true, response, data: endpoint.decode(response), latencyMs: this.#clock.now() - started };
    } catch (error) {
      if (error instanceof TransientResponseError) {
        return failure(`invalid response (${mediaType(response) ?? 'no content type'}): ${error.message}`, true);
      }
      throw error;
    }
  }
}

function failure(reason: string, transient = false, retryAfterMs: number | null = null): AttemptOutcome<never> {
  return { ok: false, reason, transient, retryAfterMs };
}

/** Client wired to the configuration paths and settings. */
export function createHttpClient(
  config: Pick<Config, 'http' | 'paths'>,
  options: Omit<HttpClientOptions, 'http' | 'cacheDir'> = {},
): HttpClient {
  return new HttpClient({ ...options, http: config.http, cacheDir: config.paths.httpCache });
}
