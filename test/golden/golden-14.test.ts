/**
 * golden-14 (§11.3) on the published release: the ANPR classification of the full run cannot be
 * reproduced on fixtures (the test worlds lack the history it needs, Step 17), so it is asserted on
 * `dist/` once it holds a release. The number was fixed by the first full run (2026-10-06).
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPublishedDataset } from '../../src/emit/index.ts';

const DIST = join(import.meta.dirname, '..', '..', 'dist');
const dataset = await loadPublishedDataset(DIST);

/** Suppressed municipalities absent from ANPR, fixed by the first full run (§11.3 golden-14). */
const MISSING_SUPPRESSED = 493;

describe('golden-14: suppressed municipalities absent from ANPR', () => {
  it.skipIf(dataset === null)(`are ${MISSING_SUPPRESSED}, info only, all suppressed`, () => {
    const missing = dataset?.anomalies.filter((a) => a.code === 'anpr-missing-entity') ?? [];
    expect(missing.map((a) => a.level)).toEqual(['info']);
    const context = missing[0]?.context as { count: number; items: { entityId: number }[] };
    expect(context.count).toBe(MISSING_SUPPRESSED);
    const status = new Map(dataset?.municipalities.map((m) => [m.id, m.status]));
    expect(context.items.filter((i) => status.get(i.entityId) !== 'suppressed')).toEqual([]);
  });
});
