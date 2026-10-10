/**
 * Bilingual names of regions and UTS (§4.2, D7, golden-23): the closed table, checked against the
 * decomposition rule.
 */
import { describe, expect, it } from 'vitest';
import {
  BILINGUAL_NAMES,
  BilingualNameTableError,
  checkBilingualTable,
  decomposeBilingual,
  isUnknownBilingual,
  regionalNames,
} from '../../src/build/index.ts';

describe('the decomposition rule', () => {
  it('separates territories on "-" and languages on "/"', () => {
    expect(decomposeBilingual('Trentino-Alto Adige/Südtirol')).toEqual({
      italianName: 'Trentino-Alto Adige',
      foreignName: 'Trentino-Südtirol',
    });
    expect(decomposeBilingual("Valle d'Aosta/Vallée d'Aoste")).toEqual({
      italianName: "Valle d'Aosta",
      foreignName: "Vallée d'Aoste",
    });
    expect(decomposeBilingual('Bolzano/Bozen')).toEqual({ italianName: 'Bolzano', foreignName: 'Bozen' });
  });

  it('suggests nothing for a name without "/" or with a malformed territory', () => {
    expect(decomposeBilingual('Forlì-Cesena')).toBeNull();
    expect(decomposeBilingual('A/B/C')).toBeNull();
    expect(decomposeBilingual('A/')).toBeNull();
  });
});

describe('the table', () => {
  it('coincides with the rule, every entry with a source', () => {
    for (const entry of BILINGUAL_NAMES) {
      expect(decomposeBilingual(entry.officialName)).toEqual({
        italianName: entry.italianName,
        foreignName: entry.foreignName,
      });
      expect(entry.source.length).toBeGreaterThan(0);
    }
    expect(BILINGUAL_NAMES.map((e) => e.officialName)).toEqual([
      'Trentino-Alto Adige/Südtirol',
      "Valle d'Aosta/Vallée d'Aoste",
      'Bolzano/Bozen',
    ]);
    expect(BILINGUAL_NAMES[0]?.source).toContain('D.P.R. 31 agosto 1972, n. 670');
  });

  it('refuses an entry that differs from the rule, a duplicate or an entry without source', () => {
    const [trentino] = BILINGUAL_NAMES;
    if (trentino === undefined) throw new Error('empty table');
    expect(() => {
      checkBilingualTable([{ ...trentino, foreignName: 'Südtirol' }]);
    }).toThrow(BilingualNameTableError);
    expect(() => {
      checkBilingualTable([trentino, trentino]);
    }).toThrow(BilingualNameTableError);
    expect(() => {
      checkBilingualTable([{ ...trentino, source: ' ' }]);
    }).toThrow(BilingualNameTableError);
  });

  it('gives the names of a denomination: as is without "/", from the table with it, none when unknown', () => {
    expect(regionalNames('Lombardia')).toEqual({
      officialName: 'Lombardia',
      italianName: 'Lombardia',
      foreignName: null,
    });
    expect(regionalNames('Bolzano/Bozen')).toEqual({
      officialName: 'Bolzano/Bozen',
      italianName: 'Bolzano',
      foreignName: 'Bozen',
    });
    expect(regionalNames('Nuova/Neue')).toEqual({ officialName: 'Nuova/Neue', italianName: null, foreignName: null });
    expect(isUnknownBilingual('Nuova/Neue')).toBe(true);
    expect(isUnknownBilingual('Bolzano/Bozen')).toBe(false);
    expect(isUnknownBilingual('Lombardia')).toBe(false);
  });
});
