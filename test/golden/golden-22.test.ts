/**
 * golden-22 (§11.3) on the release: Occisla-Clanzo, suppressed on 1923-02-08, has a single current
 * successor, but another of its successors was ceded abroad in 1947: by the resolution rule of §7
 * (D45), computed from the public files only, a reference to it is not migrated automatically. Its
 * successor paths span 1923 to 1947, a history the fixture worlds do not cover (the rule itself is
 * tested on a synthetic world in `test/unit/resolution.test.ts`), so this is asserted on `dist/` once
 * it holds a release.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPublishedDataset } from '../../src/emit/index.ts';
import { resolve } from '../helpers/resolution.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const dataset = await loadPublishedDataset({ dist: join(ROOT, 'dist'), reports: join(ROOT, 'reports') });

describe('golden-22: a single current successor next to a former Italian one', () => {
  it.skipIf(dataset === null)('Occisla-Clanzo is left to supervision', () => {
    const municipalities = dataset?.municipalities ?? [];
    const find = (code: string) => {
      const found = municipalities.find((e) => e.versions.some((v) => v.istat_code === code));
      if (found === undefined) throw new Error(`no municipality ${code}`);
      return found;
    };
    const occisla = find('801136');
    const sanDorligo = find('032004');
    const erpelle = find('702713');
    expect(occisla).toMatchObject({ status: 'suppressed', is_former_italian: false });
    expect(occisla.current_successors).toEqual([sanDorligo.id]);
    expect(occisla.successors.map((l) => [l.id, l.kind]).sort()).toEqual(
      [
        [sanDorligo.id, 'split_into'],
        [erpelle.id, 'split_into'],
      ].sort(),
    );
    expect(erpelle.is_former_italian).toBe(true);
    expect(resolve(municipalities, occisla.id)).toEqual({ kind: 'supervision', reason: 'former-italian-successor' });
  });
});
