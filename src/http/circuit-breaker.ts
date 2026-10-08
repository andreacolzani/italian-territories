/**
 * Circuit breaker per request family (§6.1, D38).
 *
 * - **Closed**: failed attempts (transport failures and transient validation errors) are counted;
 *   a success resets the count. The circuit opens when the consecutive failures reach `threshold`
 *   **and** have lasted at least `minFailureMs` (a blip of a few seconds never opens it), and come
 *   from more than one request: a single request failing alone (no other traffic, e.g. a URL that
 *   always fails) never opens it; at that point it gives up instead (`alone`) and the streak ends.
 *   A request out of attempts with no success of its family since its first failure (the family
 *   may be down, not just this request) waits for the family's verdict (`awaitVerdict`) instead
 *   of failing alone: a success of the family gives it another attempt, an opening holds it like
 *   the others, a lost family fails it. Meanwhile one of the waiting requests tries again every
 *   `cycleMs`, so the streak goes on towards a verdict.
 * - **Open**: requests are not sent; they wait. After a cooldown (`cooldownMs`, doubled at every
 *   reopening up to `maxCooldownMs`) one request is let through as a probe: its success closes the
 *   circuit, its failure reopens it. A success of a request already in flight closes it as well.
 * - **Lost**: once the open periods of the run add up to `maxOpenMs`, the family is given up for
 *   the rest of the run and every request fails immediately (the caller throws `CircuitOpenError`).
 *   The last probe is scheduled at that limit, so a family is lost only after a failed probe.
 *
 * Time comes from the injectable `Clock`; only the request that will probe (or try again for the
 * waiting ones) sleeps, the others wait for the next state change, so a virtual clock advances once
 * per cooldown or cycle.
 */
import type { Clock } from './clock.ts';

export interface CircuitBreakerOptions {
  threshold: number;
  minFailureMs: number;
  cooldownMs: number;
  maxCooldownMs: number;
  maxOpenMs: number;
}

/** What a request may do: send normally, send as the probe of an open circuit, or give up. */
export type Admission = { kind: 'closed' } | { kind: 'probe' } | { kind: 'lost'; reason: string };

/** The verdict a request out of attempts waited for: try again, wait for the open circuit, or give up. */
export type Verdict = { kind: 'retry' } | { kind: 'open' } | { kind: 'lost'; reason: string };

/** A state change, for the client's notifications; `alone`: the request must give up (not an event). */
export type Transition =
  | { kind: 'alone' }
  | { kind: 'opened'; reason: string; retryInMs: number }
  | { kind: 'reopened'; reason: string; retryInMs: number }
  | { kind: 'closed'; openMs: number }
  | { kind: 'lost'; reason: string; openMs: number };

type FamilyState =
  | {
      kind: 'closed';
      failures: number;
      since: number;
      /** Requests (tokens) with a failure in the current streak. */
      members: Set<unknown>;
      /** A request out of attempts is waiting for its next try on behalf of the waiting ones. */
      driving: boolean;
    }
  | {
      kind: 'open';
      reason: string;
      /** Start of this open period. */
      openedAt: number;
      cooldownMs: number;
      probeAt: number;
      probing: boolean;
    }
  | { kind: 'lost'; reason: string };

export class CircuitBreaker {
  readonly #options: CircuitBreakerOptions;
  readonly #clock: Clock;
  readonly #states = new Map<string, FamilyState>();
  /** Open time of the periods already closed, by family. */
  readonly #openMs = new Map<string, number>();
  readonly #waiters = new Map<string, (() => void)[]>();
  readonly #successes = new Map<string, number>();

  constructor(options: CircuitBreakerOptions, clock: Clock) {
    this.#options = options;
    this.#clock = clock;
  }

  /** Open or lost: requests of the family are not being sent. */
  isOpen(family: string): boolean {
    return this.#state(family).kind !== 'closed';
  }

  isLost(family: string): boolean {
    return this.#state(family).kind === 'lost';
  }

  /** Why the family was given up, `undefined` while it is not lost. */
  lostReason(family: string): string | undefined {
    const state = this.#state(family);
    return state.kind === 'lost' ? state.reason : undefined;
  }

  /** Successful attempts of the family so far: a request compares it with its first failure. */
  successes(family: string): number {
    return this.#successes.get(family) ?? 0;
  }

  /**
   * Holds a request out of attempts until the family has a verdict: a success (`retry`), an
   * opening (`open`: `admit` holds it from now on) or a lost family. One waiting request at a time
   * gets `retry` after `cycleMs` without a verdict, to try again on behalf of the others.
   */
  async awaitVerdict(family: string, cycleMs: number): Promise<Verdict> {
    for (;;) {
      const state = this.#state(family);
      if (state.kind === 'lost') return { kind: 'lost', reason: state.reason };
      if (state.kind === 'open') return { kind: 'open' };
      if (state.failures === 0) return { kind: 'retry' };
      if (!state.driving) {
        state.driving = true;
        await this.#clock.sleep(cycleMs);
        state.driving = false;
        // Hand over: one of the others drives the next cycle, whatever happens to this request.
        this.#wake(family);
        const now = this.#state(family);
        if (now.kind === 'lost') return { kind: 'lost', reason: now.reason };
        return now.kind === 'open' ? { kind: 'open' } : { kind: 'retry' };
      }
      await new Promise<void>((resolve) => this.#waiters.set(family, [...(this.#waiters.get(family) ?? []), resolve]));
    }
  }

  /** Waits until a request of the family may be sent (or the family is lost). */
  async admit(family: string): Promise<Admission> {
    for (;;) {
      const state = this.#state(family);
      if (state.kind === 'closed') return { kind: 'closed' };
      if (state.kind === 'lost') return { kind: 'lost', reason: state.reason };
      if (!state.probing) {
        state.probing = true;
        const wait = state.probeAt - this.#clock.now();
        if (wait > 0) await this.#clock.sleep(wait);
        // Closed (or lost) meanwhile by another request: re-evaluate.
        if (this.#states.get(family) !== state) continue;
        return { kind: 'probe' };
      }
      await new Promise<void>((resolve) => this.#waiters.set(family, [...(this.#waiters.get(family) ?? []), resolve]));
    }
  }

  recordSuccess(family: string): Transition | null {
    const state = this.#state(family);
    if (state.kind === 'lost') return null;
    this.#successes.set(family, this.successes(family) + 1);
    this.#states.set(family, closed());
    if (state.kind === 'closed') {
      // The streak is over: the requests waiting for a verdict try again.
      if (state.failures > 0) this.#wake(family);
      return null;
    }
    const openMs = this.#clock.now() - state.openedAt;
    this.#openMs.set(family, (this.#openMs.get(family) ?? 0) + openMs);
    this.#wake(family);
    return { kind: 'closed', openMs };
  }

  /**
   * `probe`: the attempt was the probe of an open circuit (its failure reopens it); `token`
   * identifies the request, so a streak of a single request never opens the circuit.
   */
  recordFailure(family: string, reason: string, probe = false, token?: unknown): Transition | null {
    const state = this.#state(family);
    const now = this.#clock.now();
    const { threshold, minFailureMs, cooldownMs, maxCooldownMs, maxOpenMs } = this.#options;
    const spent = this.#openMs.get(family) ?? 0;

    if (state.kind === 'closed') {
      const failures = state.failures + 1;
      const since = state.failures === 0 ? now : state.since;
      if (failures < threshold || now - since < minFailureMs) {
        Object.assign(state, { failures, since });
        state.members.add(token);
        return null;
      }
      if (state.members.size === 0 || (state.members.size === 1 && state.members.has(token))) {
        // Only this request has been failing: it gives up, the family is not judged on it.
        this.#states.set(family, closed());
        return { kind: 'alone' };
      }
      const why = `${failures} consecutive failures in ${now - since} ms, last: ${reason}`;
      if (spent >= maxOpenMs) return this.#lose(family, why, spent);
      const probeAt = Math.min(now + cooldownMs, now + (maxOpenMs - spent));
      this.#states.set(family, { kind: 'open', reason: why, openedAt: now, cooldownMs, probeAt, probing: false });
      // Requests waiting for a verdict are held by `admit` from now on.
      this.#wake(family);
      return { kind: 'opened', reason: why, retryInMs: probeAt - now };
    }

    // Failures of requests sent before the circuit opened do not count: only the probe's does.
    if (state.kind === 'lost' || !probe || !state.probing) return null;
    const why = `probe failed: ${reason}`;
    const total = spent + (now - state.openedAt);
    if (total >= maxOpenMs) return this.#lose(family, `open for ${total} ms in total, last: ${why}`, total);
    const next = Math.min(state.cooldownMs * 2, maxCooldownMs);
    const probeAt = Math.min(now + next, state.openedAt + (maxOpenMs - spent));
    this.#states.set(family, { ...state, reason: why, cooldownMs: next, probeAt, probing: false });
    this.#wake(family);
    return { kind: 'reopened', reason: why, retryInMs: probeAt - now };
  }

  /**
   * The probe ended without a verdict (a permanent validation error, a non-retryable status, a
   * bug: D26): the next waiting request probes at once.
   */
  abandonProbe(family: string): void {
    const state = this.#state(family);
    if (state.kind !== 'open' || !state.probing) return;
    this.#states.set(family, { ...state, probeAt: this.#clock.now(), probing: false });
    this.#wake(family);
  }

  #lose(family: string, reason: string, openMs: number): Transition {
    this.#states.set(family, { kind: 'lost', reason });
    this.#wake(family);
    return { kind: 'lost', reason, openMs };
  }

  #state(family: string): FamilyState {
    let state = this.#states.get(family);
    if (state === undefined) {
      state = closed();
      this.#states.set(family, state);
    }
    return state;
  }

  #wake(family: string): void {
    const waiters = this.#waiters.get(family) ?? [];
    this.#waiters.delete(family);
    for (const wake of waiters) wake();
  }
}

function closed(): Extract<FamilyState, { kind: 'closed' }> {
  return { kind: 'closed', failures: 0, since: 0, members: new Set(), driving: false };
}
