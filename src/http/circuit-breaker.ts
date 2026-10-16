/**
 * D38. A streak must last `minFailureMs` (a blip never opens the circuit) and involve more than one
 * request (a URL that always fails gives up alone instead). A request out of attempts with no family
 * success since its first failure waits for the family's verdict: the family may be down, not the
 * request. The last probe is scheduled at `maxOpenMs`, so a family is lost only after a failed probe.
 * Only the request that probes or retries sleeps, so a virtual clock advances once per cooldown or
 * cycle.
 */
import type { Clock } from './clock.ts';

export interface CircuitBreakerOptions {
  threshold: number;
  minFailureMs: number;
  cooldownMs: number;
  maxCooldownMs: number;
  maxOpenMs: number;
}

export type Admission = { kind: 'closed' } | { kind: 'probe' } | { kind: 'lost'; reason: string };

export type Verdict = { kind: 'retry' } | { kind: 'open' } | { kind: 'lost'; reason: string };

/** `alone` is not an event: the request must give up. */
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
      members: Set<unknown>;
      /** One request retries on behalf of the waiting ones. */
      driving: boolean;
    }
  | {
      kind: 'open';
      reason: string;
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
  readonly #openMs = new Map<string, number>();
  readonly #waiters = new Map<string, (() => void)[]>();
  readonly #successes = new Map<string, number>();

  constructor(options: CircuitBreakerOptions, clock: Clock) {
    this.#options = options;
    this.#clock = clock;
  }

  isOpen(family: string): boolean {
    return this.#state(family).kind !== 'closed';
  }

  isLost(family: string): boolean {
    return this.#state(family).kind === 'lost';
  }

  lostReason(family: string): string | undefined {
    const state = this.#state(family);
    return state.kind === 'lost' ? state.reason : undefined;
  }

  /** A request compares it with the count at its first failure. */
  successes(family: string): number {
    return this.#successes.get(family) ?? 0;
  }

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

  /** `token` identifies the request, so a single request's streak never opens the circuit. */
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

  /** A probe without a verdict (D26): the next waiting request probes at once. */
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
