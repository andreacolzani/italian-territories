import type { Clock } from './clock.ts';

export class TokenBucket {
  readonly #rate: number;
  readonly #capacity: number;
  readonly #clock: Clock;
  #tokens: number;
  #last: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(ratePerSecond: number, clock: Clock, capacity = 1) {
    if (!(ratePerSecond > 0)) throw new RangeError('ratePerSecond must be positive');
    if (!(capacity >= 1)) throw new RangeError('capacity must be at least 1');
    this.#rate = ratePerSecond / 1000;
    this.#capacity = capacity;
    this.#clock = clock;
    this.#tokens = capacity;
    this.#last = clock.now();
  }

  take(): Promise<void> {
    this.#queue = this.#queue.then(() => this.#takeOne());
    return this.#queue;
  }

  async #takeOne(): Promise<void> {
    this.#refill();
    if (this.#tokens < 1) {
      await this.#clock.sleep(Math.ceil((1 - this.#tokens) / this.#rate));
      this.#refill();
    }
    this.#tokens = Math.max(0, this.#tokens - 1);
  }

  #refill(): void {
    const now = this.#clock.now();
    this.#tokens = Math.min(this.#capacity, this.#tokens + (now - this.#last) * this.#rate);
    this.#last = now;
  }
}
