/** Retry delays (§6.1). */

/**
 * Exponential backoff with full jitter: uniform in `[0, min(maxMs, baseMs · 2^(retry−1)))`,
 * where `retry` is 1 for the first retry.
 */
export function fullJitterDelay(retry: number, baseMs: number, maxMs: number, random: () => number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (retry - 1));
  return Math.floor(random() * ceiling);
}

/**
 * `Retry-After` in milliseconds from `nowMs`: delay-seconds or an HTTP-date. Returns `null`
 * when absent or unparseable; dates in the past yield 0.
 */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}
