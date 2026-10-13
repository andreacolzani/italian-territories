/**
 * golden-14 (§11.3) on the published release: the ANPR classification of the full run cannot be
 * reproduced on fixtures (the test worlds lack the history it needs), so it is asserted on
 * `dist/` and `reports/` once they hold a release. The number was fixed by the first full run (2026-10-06), then
 * lowered from 493 by the ISTAT-code join of ANPR rows without a cadastral code and the retry by
 * ISTAT code (§6.11, 2026-10-08).
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPublishedDataset } from '../../src/emit/index.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const dataset = await loadPublishedDataset({ dist: join(ROOT, 'dist'), reports: join(ROOT, 'reports') });

/** Suppressed municipalities absent from ANPR, fixed by the first full run (§11.3 golden-14). */
const MISSING_SUPPRESSED = 491;

describe('golden-14: suppressed municipalities absent from ANPR', () => {
  it.skipIf(dataset === null)(`are ${MISSING_SUPPRESSED}, info only, all suppressed`, () => {
    const missing = dataset?.anomalies.filter((a) => a.code === 'anpr-missing-entity') ?? [];
    expect(missing.map((a) => a.level)).toEqual(['info']);
    const context = missing[0]?.context as { count: number; items: { entityId: string }[] };
    expect(context.count).toBe(MISSING_SUPPRESSED);
    const status = new Map(dataset?.municipalities.map((m) => [m.id, m.status]));
    expect(context.items.filter((i) => status.get(i.entityId) !== 'suppressed')).toEqual([]);
  });
});
