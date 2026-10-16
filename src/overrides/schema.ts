/**
 * The overridable fields are a closed set (§6.10): adding one is a deliberate extension of this
 * schema and of the applier, never a generic field name.
 */
import { z } from 'zod';
import { compareDates, isIsoDate } from '../dates/index.ts';
import { ABBREVIATION_PATTERN, ISTAT_CODE_PATTERNS } from '../model/common.ts';
import { isoDateSchema } from '../model/public.ts';

const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const abbreviationOverrideSchema = z.strictObject({
  key: z.string().regex(KEY_PATTERN, 'expected a kebab-case key'),
  target: z
    .strictObject({
      level: z.literal('province'),
      istat_code: z.string().regex(ISTAT_CODE_PATTERNS.province),
      date_from: isoDateSchema,
      /** Inclusive; null = no end. */
      date_to: isoDateSchema.nullable(),
    })
    // Invalid dates are already reported by their own schema; compare only valid ones.
    .refine((t) => !isIsoDate(t.date_from) || !isIsoDate(t.date_to) || compareDates(t.date_from, t.date_to) <= 0, {
      message: 'date_to must not precede date_from',
      path: ['date_to'],
    }),
  field: z.literal('abbreviation'),
  value: z.string().regex(ABBREVIATION_PATTERN),
  reason: z.string().min(1),
  source: z.string().min(1),
  source_url: z.url().nullable(),
});

const overrideEntrySchema = z.discriminatedUnion('field', [abbreviationOverrideSchema]);

export const overrideFileSchema = z.array(overrideEntrySchema);

export type OverrideEntry = z.output<typeof overrideEntrySchema>;
export type OverrideField = OverrideEntry['field'];
