/**
 * golden-22 (§11.3) on the release: Occisla-Clanzo and the UTS Venezia Giulia, suppressed on
 * 1923-02-08, are partially ceded (§7, D45). Their successor paths span 1923 to 1947, a history the
 * fixture worlds do not cover (the synthetic case is in `test/unit/derived-fields.test.ts`), so this
 * is asserted on `dist/` once it holds a release.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPublishedDataset } from '../../src/emit/index.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const dataset = await loadPublishedDataset({ dist: join(ROOT, 'dist'), reports: join(ROOT, 'reports') });

describe('golden-22: partially ceded', () => {
  it.skipIf(dataset === null)('Occisla-Clanzo and Venezia Giulia', () => {
    const find = <E extends { versions: { istat_code: string }[] }>(list: readonly E[] | undefined, code: string) => {
      const found = list?.find((e) => e.versions.some((v) => v.istat_code === code));
      if (found === undefined) throw new Error(`no entity ${code}`);
      return found;
    };
    const occisla = find(dataset?.municipalities, '801136');
    const sanDorligo = find(dataset?.municipalities, '032004');
    expect(occisla).toMatchObject({ status: 'suppressed', is_former_italian: false, partially_ceded: true });
    expect(occisla.successors.map((l) => l.kind)).toEqual(['split_into', 'split_into']);
    expect(occisla.current_successors).toEqual([sanDorligo.id]);
    const veneziaGiulia = find(dataset?.provinces, '801');
    expect(veneziaGiulia).toMatchObject({ is_former_italian: false, partially_ceded: true });
    expect(veneziaGiulia.successors.every((l) => l.kind === 'split_into')).toBe(true);
  });
});
