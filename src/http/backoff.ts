/** Full jitter; `retry` is 1 for the first retry. */
export function fullJitterDelay(retry: number, baseMs: number, maxMs: number, random: () => number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (retry - 1));
  return Math.floor(random() * ceiling);
}

/** Milliseconds; `Retry-After` is delay-seconds or an HTTP-date. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}
