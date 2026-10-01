/**
 * Worker pool with AIMD concurrency (§6.1): +1 slot after `increaseAfter` consecutive fast
 * successes (up to `max`), halved on congestion. A failure halves only if its attempt started
 * after the last decrease (same epoch), so a burst of in-flight failures halves once.
 */
export interface AdaptiveLimiterOptions {
  initial: number;
  max: number;
  increaseAfter: number;
  onChange?: (limit: number) => void;
}

export class AdaptiveLimiter {
  readonly #max: number;
  readonly #increaseAfter: number;
  readonly #onChange: ((limit: number) => void) | undefined;
  #limit: number;
  #inFlight = 0;
  #fastStreak = 0;
  #epoch = 0;
  readonly #waiters: (() => void)[] = [];

  constructor(options: AdaptiveLimiterOptions) {
    if (!(options.initial >= 1 && options.initial <= options.max)) {
      throw new RangeError('initial concurrency must be within [1, max]');
    }
    this.#limit = options.initial;
    this.#max = options.max;
    this.#increaseAfter = options.increaseAfter;
    this.#onChange = options.onChange;
  }

  get limit(): number {
    return this.#limit;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  /** Waits for a free slot; returns the epoch to pass to `recordFailure`. */
  async acquire(): Promise<number> {
    if (this.#inFlight < this.#limit && this.#waiters.length === 0) {
      this.#inFlight++;
    } else {
      // The releasing side increments `inFlight` on our behalf before waking us.
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.#epoch;
  }

  release(): void {
    this.#inFlight--;
    this.#drain();
  }

  recordSuccess(fast: boolean): void {
    if (!fast) {
      this.#fastStreak = 0;
      return;
    }
    if (++this.#fastStreak < this.#increaseAfter) return;
    this.#fastStreak = 0;
    if (this.#limit < this.#max) {
      this.#limit++;
      this.#onChange?.(this.#limit);
      this.#drain();
    }
  }

  recordFailure(epoch: number): void {
    this.#fastStreak = 0;
    if (epoch !== this.#epoch) return;
    this.#epoch++;
    const halved = Math.max(1, Math.floor(this.#limit / 2));
    if (halved !== this.#limit) {
      this.#limit = halved;
      this.#onChange?.(this.#limit);
    }
  }

  #drain(): void {
    while (this.#inFlight < this.#limit) {
      const wake = this.#waiters.shift();
      if (wake === undefined) return;
      this.#inFlight++;
      wake();
    }
  }
}
