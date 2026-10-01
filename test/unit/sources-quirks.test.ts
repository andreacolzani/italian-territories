/** Data quirks of §3.5 items 1–3, on real fixtures and on the normalisation building blocks. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ResponseValidationError } from '../../src/http/errors.ts';
import {
  cadastralCode,
  cleanText,
  flag,
  optionalCode,
  optionalText,
  requiredCode,
  requiredText,
  utsType,
} from '../../src/sources/normalise.ts';
import { mapResultset, patchedFixtureTransport, withSources } from '../helpers/sources.ts';

const UNIFICATION = '1861-03-17';

describe('quirk 1: inconsistent types', () => {
  it('reads TIPO_UTS as a number in snapshots and as a string in event lists', async () => {
    await withSources(async ({ situasPublic }) => {
      const snapshot = (await situasPublic.fetchSnapshot('province', '2026-01-01')).data.snapshot.rows;
      const events = (await situasPublic.fetchEventList('province', 113, UNIFICATION, '2026-10-01')).data;
      expect(snapshot.find((r) => r.code === '312')?.type).toBe('metropolitan_city');
      expect(events.find((r) => r.code === '312' && r.event === 'CSCT')?.type).toBe('metropolitan_city');
    });
  });

  it('reads flags given as numbers (FLAG_CAMBIO_REGIONE) and as strings (FLAG_ES_SCORPORO)', async () => {
    await withSources(async ({ situasPublic }) => {
      const changes = (await situasPublic.fetchEventList('municipality', 105, UNIFICATION, '2026-09-30')).data;
      expect(changes.find((r) => r.code === '023820' && r.event === 'AP')?.regionChanged).toBe(true);
      expect(changes.find((r) => r.code === '090001' && r.event === 'AP')?.regionChanged).toBe(false);
      const suppressions = (await situasPublic.fetchEventList('municipality', 98, UNIFICATION, '2026-09-30')).data;
      expect(suppressions.find((r) => r.code === '048805')?.multipleSuccessors).toBe(true);
      expect(suppressions.find((r) => r.code === '024027')?.multipleSuccessors).toBe(false);
    });
  });

  it('accepts codes and enums as strings or numbers', () => {
    expect(requiredCode(3).parse(90)).toBe('090');
    expect(requiredCode(3).parse('090')).toBe('090');
    expect(utsType.parse(3)).toBe('metropolitan_city');
    expect(utsType.parse('3')).toBe('metropolitan_city');
    expect(flag.parse(1)).toBe(true);
    expect(flag.parse('0')).toBe(false);
    expect(flag.parse(undefined)).toBe(false);
    expect(requiredCode(3).safeParse('0901').success).toBe(false);
    expect(requiredCode(3).safeParse('09a').success).toBe(false);
    expect(utsType.safeParse(6).success).toBe(false);
  });
});

describe('quirk 2: unstable field sets', () => {
  it('ignores optional fields missing for some rows (COD_NUTS2_2024)', async () => {
    await withSources(async ({ situasPublic }) => {
      const { rows } = (await situasPublic.fetchSnapshot('region', '2025-12-31')).data.snapshot;
      expect(rows).toHaveLength(20);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(['code', 'name', 'type']);
    });
  });

  it('ignores unknown fields and fails only when a required field is missing', async () => {
    const transport = await patchedFixtureTransport((response) =>
      mapResultset(response, (rows) =>
        rows.map((row, i) => {
          const extended: Record<string, unknown> = { ...row, COD_NUTS2_2099: 'ITX', NEW_FIELD: 1 };
          if (i === 7) delete extended.COD_REG;
          return extended;
        }),
      ),
    );
    await withSources(
      async ({ situasPublic }) => {
        const error: unknown = await situasPublic.fetchSnapshot('region', '2025-12-31').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ResponseValidationError);
        expect((error as ResponseValidationError).issues.map((i) => i.index)).toEqual([7]);
      },
      { transport },
    );
  });
});

describe('quirk 3: missing values', () => {
  it('maps "", " " and "ND" to null', () => {
    for (const value of ['', ' ', 'ND', ' ND ']) expect(cleanText(value), JSON.stringify(value)).toBeNull();
    expect(cleanText('  Agliè ')).toBe('Agliè');
    expect(cleanText('Agliè')).toBe('Agliè');
    expect(optionalText.parse(undefined)).toBeNull();
    expect(optionalCode(6).parse(' ')).toBeNull();
    expect(cadastralCode.parse('ND')).toBeNull();
    expect(cadastralCode.safeParse('X12').success).toBe(false);
    expect(requiredText.safeParse('ND').success).toBe(false);
    expect(z.object({ a: requiredText }).safeParse({}).success).toBe(false);
  });

  it('turns ND cadastral codes into null in real snapshots and event lists', async () => {
    await withSources(async ({ situasPublic }) => {
      const rows = (await situasPublic.fetchSnapshot('municipality', '1927-01-11')).data.snapshot.rows;
      expect(rows.filter((r) => r.cadastralCode === null)).toHaveLength(11);
      const territorial = (await situasPublic.fetchEventList('municipality', 103, UNIFICATION, '2026-10-01')).data;
      expect(territorial.filter((r) => r.related?.code != null && r.related.cadastralCode === null)).toHaveLength(11);
    });
  });
});
