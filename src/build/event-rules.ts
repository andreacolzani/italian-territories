/**
 * §4.3, D27. ISTAT does not document which codes each level uses, so the pairs are closed here on
 * purpose and checked against those the build observes: the public lists (§3.2) plus those observed
 * in the internal histories of every region and UTS record (r4/r5, 2026-10). An `attribute` row
 * carries the code of `D − 1` (§6.6).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import type { EventCodeSummary } from '../enrich/index.ts';
import { ISTAT_EVENT_CODES, LEVELS, type IstatEventCode, type Level } from '../model/common.ts';
import type { ResolutionSide } from '../resolve/index.ts';

export type EventEffect = 'first-validity' | 'closing' | 'opening' | 'attribute' | 'territorial';

export interface TerritoryFlow {
  direction: 'subject-to-related' | 'related-to-subject';
  relatedSide: ResolutionSide;
}

export interface EventRule {
  effect: EventEffect;
  subjectSide: ResolutionSide;
  /** `null`: the related territory, if any, is the subject itself. */
  flow: TerritoryFlow | null;
}

const closing: EventRule = {
  effect: 'closing',
  subjectSide: 'predecessor',
  flow: { direction: 'subject-to-related', relatedSide: 'successor' },
};
const opening: EventRule = {
  effect: 'opening',
  subjectSide: 'successor',
  flow: { direction: 'related-to-subject', relatedSide: 'predecessor' },
};
const attribute: EventRule = { effect: 'attribute', subjectSide: 'predecessor', flow: null };
const firstValidity: EventRule = { effect: 'first-validity', subjectSide: 'successor', flow: null };
const territorial = (direction: TerritoryFlow['direction'], relatedSide: ResolutionSide): EventRule => ({
  effect: 'territorial',
  subjectSide: 'successor',
  flow: { direction, relatedSide },
});

const COMMON: Partial<Record<IstatEventCode, EventRule>> = {
  PV: firstValidity,
  CS: opening,
  AN: opening,
  ES: closing,
  AS: closing,
  AQES: territorial('related-to-subject', 'predecessor'),
  AQ: territorial('related-to-subject', 'successor'),
  CE: territorial('subject-to-related', 'successor'),
  CECS: territorial('subject-to-related', 'successor'),
  CD: attribute,
};

export const EVENT_RULES: Readonly<Record<Level, Partial<Record<IstatEventCode, EventRule>>>> = {
  region: { ...COMMON, CSCT: opening, ESCT: closing, VACST: attribute },
  province: { ...COMMON, CSCT: opening, ESCT: closing, AP: attribute, RN: attribute, CT: attribute },
  municipality: { ...COMMON, AP: attribute, CDAP: attribute, RN: attribute, RNAPUTS: attribute },
};

export function eventRule(level: Level, event: IstatEventCode): EventRule | undefined {
  return EVENT_RULES[level][event];
}

export interface EventCodeEquivalence {
  level: Level;
  codes: readonly [IstatEventCode, IstatEventCode];
  reason: string;
}

/**
 * Closed, never deduced from the codes (D48). A pair has the same rule at its level, so a match
 * changes no effect.
 */
const EVENT_CODE_EQUIVALENCES: readonly EventCodeEquivalence[] = [
  {
    level: 'municipality',
    codes: ['RN', 'RNAPUTS'],
    reason:
      'A renumbering with or without the change of UTS: the 66 municipalities moved from UTS 090 to 312 on ' +
      '2026-01-01 (act 6151) were RNAPUTS in pfun 105 until 2026-10-07 and RN from 2026-10-12, while r6 kept RNAPUTS',
  },
];

for (const { level, codes } of EVENT_CODE_EQUIVALENCES) {
  const [a, b] = codes.map((code) => eventRule(level, code));
  if (a === undefined || a !== b) {
    throw new Error(`equivalent ${level} event codes ${codes.join(' ↔ ')} must have the same rule`);
  }
}

export function equivalentEventCodes(level: Level, event: IstatEventCode): IstatEventCode[] {
  return EVENT_CODE_EQUIVALENCES.flatMap(({ level: l, codes: [a, b] }) =>
    l !== level ? [] : a === event ? [b] : b === event ? [a] : [],
  );
}

const EVENT_RULE_ANOMALIES = {
  missing: 'event-rule-missing',
} as const;

export function checkEventRules(summary: EventCodeSummary, anomalies: AnomalyCollector): void {
  for (const level of LEVELS) {
    for (const event of ISTAT_EVENT_CODES) {
      const count = summary[level]?.[event];
      if (count === undefined || eventRule(level, event) !== undefined) continue;
      reportMissingRule(level, event, count, 'event-codes', anomalies);
    }
  }
}

export function reportMissingRule(
  level: Level,
  event: IstatEventCode,
  count: number,
  source: string,
  anomalies: AnomalyCollector,
): void {
  anomalies.add({
    level: 'blocking',
    code: EVENT_RULE_ANOMALIES.missing,
    message: `${level} event ${event} has no variation rule (${count} events)`,
    context: { level, event, count, source },
  });
}
