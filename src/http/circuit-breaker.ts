/**
 * Circuit breaker per endpoint family (§6.1): `threshold` consecutive failed attempts open the
 * family's circuit, which then stays open for the rest of the run.
 */
export class CircuitBreaker {
  readonly #threshold: number;
  readonly #failures = new Map<string, number>();
  readonly #open = new Map<string, string>();

  constructor(threshold: number) {
    this.#threshold = threshold;
  }

  isOpen(family: string): boolean {
    return this.#open.has(family);
  }

  /** Why the circuit opened, or `undefined` while it is closed. */
  reason(family: string): string | undefined {
    return this.#open.get(family);
  }

  recordSuccess(family: string): void {
    this.#failures.set(family, 0);
  }

  /** Returns `true` when this failure opens the circuit. */
  recordFailure(family: string, reason: string): boolean {
    if (this.isOpen(family)) return false;
    const failures = (this.#failures.get(family) ?? 0) + 1;
    this.#failures.set(family, failures);
    if (failures < this.#threshold) return false;
    this.#open.set(family, `${failures} consecutive failures, last: ${reason}`);
    return true;
  }

  /** Opens the circuit immediately. Returns `true` if it was closed. */
  trip(family: string, reason: string): boolean {
    if (this.isOpen(family)) return false;
    this.#open.set(family, reason);
    return true;
  }
}
