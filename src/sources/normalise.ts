/**
 * §6.2, §3.5 items 1–3. SITUAS writes a missing value as absent, `""`, `" "` or `"ND"`, and numbers
 * as number or numeric string. A row that cannot be normalised fails its endpoint schema, so the
 * decoder turns it into a `ResponseValidationError`.
 */
import { z } from 'zod';
import { fromItalianDate, fromUtcMidnightTimestamp, type IsoDate } from '../dates/index.ts';
import {
  ABROAD_EVENT_CODES,
  CADASTRAL_CODE_PATTERN,
  ISTAT_EVENT_CODES,
  regionTypeFromIstat,
  utsTypeFromIstat,
  type IstatEventCode,
  type RegionType,
  type UtsType,
} from '../model/common.ts';

const MISSING = new Set(['', 'ND']);

export function cleanText(value: string): string | null {
  const text = value.trim().normalize('NFC');
  return MISSING.has(text) ? null : text;
}

type Ctx = z.core.$RefinementCtx;

function fail(ctx: Ctx, input: unknown, message: string): never {
  ctx.issues.push({ code: 'custom', input, message });
  return z.NEVER;
}

export const optionalText = z
  .string()
  .nullish()
  .transform((value) => (value == null ? null : cleanText(value)));

export const requiredText = z.string().transform((value, ctx) => cleanText(value) ?? fail(ctx, value, 'missing value'));

const codeInput = z.union([z.string(), z.int().nonnegative()]);

function codeOrFail(value: string | number, width: number, ctx: Ctx): string | null {
  const text = typeof value === 'number' ? String(value) : cleanText(value);
  if (text === null) return null;
  if (!/^\d+$/.test(text) || text.length > width) return fail(ctx, value, `not a code of at most ${width} digits`);
  return text.padStart(width, '0');
}

/** Width: region 2, UTS 3, municipality 6. */
export function requiredCode(width: number) {
  return codeInput.transform((value, ctx) => codeOrFail(value, width, ctx) ?? fail(ctx, value, 'missing code'));
}

export function optionalCode(width: number) {
  return codeInput.nullish().transform((value, ctx) => (value == null ? null : codeOrFail(value, width, ctx)));
}

export const cadastralCode = z
  .string()
  .nullish()
  .transform((value, ctx) => {
    const text = value == null ? null : cleanText(value);
    if (text === null || CADASTRAL_CODE_PATTERN.test(text)) return text;
    return fail(ctx, value, 'not a cadastral code');
  });

export const integer = z.union([z.int(), z.string()]).transform((value, ctx) => {
  if (typeof value === 'number') return value;
  const text = value.trim();
  return /^-?\d+$/.test(text) ? Number(text) : fail(ctx, value, 'not an integer');
});

/** Absent means `false`. */
export const flag = z
  .union([z.literal(0), z.literal(1), z.literal('0'), z.literal('1'), z.literal('')])
  .nullish()
  .transform((value) => value === 1 || value === '1');

/** 1 compartment, 2 region. */
export const regionType = integer.transform((value, ctx): RegionType => {
  try {
    return regionTypeFromIstat(value);
  } catch (error) {
    return fail(ctx, value, (error as Error).message);
  }
});

export const utsType = integer.transform((value, ctx): UtsType => {
  try {
    return utsTypeFromIstat(value);
  } catch (error) {
    return fail(ctx, value, (error as Error).message);
  }
});

/** r8 gives the UTS type as a label (those of r2's `descrizione tipo uts`), not a number. */
const UTS_TYPE_LABELS: Readonly<Record<string, UtsType>> = {
  Provincia: 'province',
  'Provincia autonoma': 'autonomous_province',
  'Città metropolitana': 'metropolitan_city',
  'Libero consorzio di comuni': 'free_municipal_consortium',
  'Unità non amministrativa': 'non_administrative_unit',
};

export const utsTypeLabel = z.string().transform((value, ctx): UtsType => parseUtsTypeLabel(value, ctx));

export function parseUtsTypeLabel(value: string, ctx: Ctx): UtsType {
  const label = cleanText(value);
  const type = label === null ? undefined : UTS_TYPE_LABELS[label];
  return type ?? fail(ctx, value, `unknown UTS type label '${value}'`);
}

export const italianDate = z.string().transform((value, ctx): IsoDate => {
  try {
    return fromItalianDate(value.trim());
  } catch (error) {
    return fail(ctx, value, (error as Error).message);
  }
});

export const timestampDate = z.string().transform((value, ctx): IsoDate => {
  try {
    return fromUtcMidnightTimestamp(value.trim());
  } catch (error) {
    return fail(ctx, value, (error as Error).message);
  }
});

function isEventCode(value: string): value is IstatEventCode {
  return (ISTAT_EVENT_CODES as readonly string[]).includes(value);
}

function eventOrFail(text: string, input: unknown, allowed: readonly IstatEventCode[], ctx: Ctx): IstatEventCode {
  if (!isEventCode(text)) return fail(ctx, input, `unknown ISTAT event code '${text}'`);
  if (!allowed.includes(text)) return fail(ctx, input, `event code '${text}' not allowed here (${allowed.join(', ')})`);
  return text;
}

/** An unexpected code is a schema violation (D21). */
export function eventCode(allowed: readonly IstatEventCode[] = ISTAT_EVENT_CODES) {
  return z.string().transform((value, ctx) => eventOrFail(value.trim(), value, allowed, ctx));
}

/** SITUAS's name for a related foreign state, which carries no code. */
export const FOREIGN_STATE_NAME = 'Stato estero';

export interface RelatedTerritory<T> {
  /** Also `null` for a foreign state. */
  related: T | null;
  abroad: boolean;
}

/** A foreign state only for `AS`, `AN`, `CE` and `AQ`, and never as a territory to resolve (D31). */
export function relatedTerritory<T extends { name: string | null }>(
  event: IstatEventCode,
  related: T,
  ctx: Ctx,
): RelatedTerritory<T> {
  const fields = Object.entries(related);
  if (fields.every(([, value]) => value === null)) return { related: null, abroad: false };
  if (related.name?.toLowerCase() !== FOREIGN_STATE_NAME.toLowerCase()) return { related, abroad: false };
  if (fields.some(([key, value]) => key !== 'name' && value !== null)) {
    return fail(ctx, related, `a foreign state related territory must have no code (${JSON.stringify(related)})`);
  }
  if (!(ABROAD_EVENT_CODES as readonly string[]).includes(event)) {
    return fail(ctx, related, `a foreign state related territory is not allowed for event ${event}`);
  }
  return { related: null, abroad: true };
}

/** Internal details give the event as `<code>-<label>` (`ES-Estinzione`). */
export function describedEventCode(allowed: readonly IstatEventCode[] = ISTAT_EVENT_CODES) {
  return z.string().transform((value, ctx) => {
    const separator = value.indexOf('-');
    return eventOrFail((separator < 0 ? value : value.slice(0, separator)).trim(), value, allowed, ctx);
  });
}
