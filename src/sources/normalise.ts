/**
 * Normalisation building blocks shared by the adapters (§6.2, §3.5 items 1–3), as zod schemas
 * that validate and convert in one step: a row that cannot be normalised fails its endpoint
 * schema, which the decoder turns into a `ResponseValidationError`.
 *
 * - Missing values: absent, `""`, `" "` and `"ND"` become `null`.
 * - Strings are trimmed and NFC-normalised.
 * - Codes are zero-padded strings of a fixed width, accepted as string or number.
 * - Numeric enums and flags are accepted as number or numeric string.
 * - Dates come as `DD/MM/YYYY` or `YYYY-MM-DDT00:00:00Z` and become ISO `YYYY-MM-DD`.
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

/** Trimmed NFC text, or `null` for a missing value (§3.5 item 3). */
export function cleanText(value: string): string | null {
  const text = value.trim().normalize('NFC');
  return MISSING.has(text) ? null : text;
}

type Ctx = z.core.$RefinementCtx;

function fail(ctx: Ctx, input: unknown, message: string): never {
  ctx.issues.push({ code: 'custom', input, message });
  return z.NEVER;
}

/** Optional text: absent or missing values become `null`. */
export const optionalText = z
  .string()
  .nullish()
  .transform((value) => (value == null ? null : cleanText(value)));

/** Required text: a missing value is a schema violation. */
export const requiredText = z.string().transform((value, ctx) => cleanText(value) ?? fail(ctx, value, 'missing value'));

const codeInput = z.union([z.string(), z.int().nonnegative()]);

/** Zero-padded code, `null` for a missing value; anything else than at most `width` digits fails. */
function codeOrFail(value: string | number, width: number, ctx: Ctx): string | null {
  const text = typeof value === 'number' ? String(value) : cleanText(value);
  if (text === null) return null;
  if (!/^\d+$/.test(text) || text.length > width) return fail(ctx, value, `not a code of at most ${width} digits`);
  return text.padStart(width, '0');
}

/** Required ISTAT code zero-padded to `width` digits (region 2, UTS 3, municipality 6). */
export function requiredCode(width: number) {
  return codeInput.transform((value, ctx) => codeOrFail(value, width, ctx) ?? fail(ctx, value, 'missing code'));
}

/** Optional ISTAT code: absent or missing values become `null`. */
export function optionalCode(width: number) {
  return codeInput.nullish().transform((value, ctx) => (value == null ? null : codeOrFail(value, width, ctx)));
}

/** Cadastral code (`A001`) or `null` when missing (`ND`, §3.5 item 3). */
export const cadastralCode = z
  .string()
  .nullish()
  .transform((value, ctx) => {
    const text = value == null ? null : cleanText(value);
    if (text === null || CADASTRAL_CODE_PATTERN.test(text)) return text;
    return fail(ctx, value, 'not a cadastral code');
  });

/** Positive integer given as number or numeric string (§3.5 item 1). */
export const integer = z.union([z.int(), z.string()]).transform((value, ctx) => {
  if (typeof value === 'number') return value;
  const text = value.trim();
  return /^-?\d+$/.test(text) ? Number(text) : fail(ctx, value, 'not an integer');
});

/** `0`/`1` flag as number or string; absent means `false` (§3.5 item 1). */
export const flag = z
  .union([z.literal(0), z.literal(1), z.literal('0'), z.literal('1'), z.literal('')])
  .nullish()
  .transform((value) => value === 1 || value === '1');

/** ISTAT region type (1 compartment, 2 region). */
export const regionType = integer.transform((value, ctx): RegionType => {
  try {
    return regionTypeFromIstat(value);
  } catch (error) {
    return fail(ctx, value, (error as Error).message);
  }
});

/** ISTAT UTS type (1..5). */
export const utsType = integer.transform((value, ctx): UtsType => {
  try {
    return utsTypeFromIstat(value);
  } catch (error) {
    return fail(ctx, value, (error as Error).message);
  }
});

/**
 * UTS type given by its ISTAT description, as in internal event details (r8), where the type is
 * a label rather than a number. Labels are those listed by r2 (`descrizione tipo uts`).
 */
const UTS_TYPE_LABELS: Readonly<Record<string, UtsType>> = {
  Provincia: 'province',
  'Provincia autonoma': 'autonomous_province',
  'Città metropolitana': 'metropolitan_city',
  'Libero consorzio di comuni': 'free_municipal_consortium',
  'Unità non amministrativa': 'non_administrative_unit',
};

export const utsTypeLabel = z.string().transform((value, ctx): UtsType => {
  const label = cleanText(value);
  const type = label === null ? undefined : UTS_TYPE_LABELS[label];
  return type ?? fail(ctx, value, `unknown UTS type label '${value}'`);
});

/** `DD/MM/YYYY` → ISO. */
export const italianDate = z.string().transform((value, ctx): IsoDate => {
  try {
    return fromItalianDate(value.trim());
  } catch (error) {
    return fail(ctx, value, (error as Error).message);
  }
});

/** `YYYY-MM-DDT00:00:00Z` → ISO. */
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

/**
 * ISTAT event code restricted to the codes an endpoint may carry (§6.2, D21): an unknown or
 * unexpected code is a schema violation.
 */
export function eventCode(allowed: readonly IstatEventCode[] = ISTAT_EVENT_CODES) {
  return z.string().transform((value, ctx) => eventOrFail(value.trim(), value, allowed, ctx));
}

/** Name SITUAS gives to a related territory that is a foreign state; it carries no code. */
export const FOREIGN_STATE_NAME = 'Stato estero';

/** Related territory of an event row, or the foreign state flag (§3.5 item 15). */
export interface RelatedTerritory<T> {
  /** `null` when the row has no related territory or the related territory is a foreign state. */
  related: T | null;
  /** The related territory is a foreign state. */
  abroad: boolean;
}

/**
 * Splits the `*_REL` / associated fields of an event row. A foreign state (`Stato estero`, no
 * other field) is accepted only for `AS`, `AN` and `CE`; it is never returned as a territory to
 * resolve, only as `abroad`. Anywhere else, or with a code, it is a schema violation.
 */
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

/** Event code taken from a `<code>-<label>` description, e.g. `ES-Estinzione` (internal details). */
export function describedEventCode(allowed: readonly IstatEventCode[] = ISTAT_EVENT_CODES) {
  return z.string().transform((value, ctx) => {
    const separator = value.indexOf('-');
    return eventOrFail((separator < 0 ? value : value.slice(0, separator)).trim(), value, allowed, ctx);
  });
}
