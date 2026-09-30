import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.ts';

describe('config', () => {
  it('applies the defaults of the plan', () => {
    const config = resolveConfig();
    expect(config.http.concurrency).toBe(4);
    expect(config.http.maxConcurrency).toBe(8);
    expect(config.http.maxAttempts).toBe(6);
    expect(config.http.timeouts).toEqual({ snapshotMs: 120_000, defaultMs: 30_000 });
    expect(config.dates.start).toBe('1861-03-17');
    expect(config.dates.regimeBoundaries).toEqual(['1927-01-12', '1948-01-01']);
    expect(config.update.lookbackDays).toBe(365);
    expect(Object.values(config.paths).every(isAbsolute)).toBe(true);
  });

  it('merges partial overrides', () => {
    const config = resolveConfig({
      http: { concurrency: 2, timeouts: { defaultMs: 5000 } },
      dates: { today: '2026-09-30' },
    });
    expect(config.http.concurrency).toBe(2);
    expect(config.http.timeouts).toEqual({ snapshotMs: 120_000, defaultMs: 5000 });
    expect(config.dates.today).toBe('2026-09-30');
  });

  it('rejects invalid values', () => {
    expect(() => resolveConfig({ http: { concurrency: 9 } })).toThrow();
    expect(() => resolveConfig({ http: { concurrency: 6, maxConcurrency: 5 } })).toThrow();
    expect(() => resolveConfig({ dates: { today: '30/09/2026' } })).toThrow();
  });
});
