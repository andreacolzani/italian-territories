/** Injectable so tests run on virtual time. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))),
};
