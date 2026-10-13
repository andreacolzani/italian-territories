/**
 * Explicit rules per `(level, event code)` (§4.3, §6.2, D27): which effect an event has on the
 * versions of its subject, which side identifies the subject and the related territory of an event
 * row (§3.5 item 6), and the direction of the territory flow that becomes a link.
 *
 * - `closing` (`ES`, `ESCT`, `AS`): the subject's version ends on the event date `D`; the subject is
 *   identified on `D − 1`, a related successor on `D`; territory flows subject → related.
 * - `opening` (`CS`, `CSCT`, `AN`): the subject's version starts on `D`; the subject is identified on
 *   `D`, a related predecessor on `D − 1`; territory flows related → subject.
 * - `attribute` (`CD`, `AP`, `CDAP`, `RN`, `RNAPUTS`, `CT`, `VACST`): the subject continues with a new
 *   version on `D`; the row's code is the one of `D − 1` (§6.6); the related territory, when any,
 *   is the subject itself, so there is no flow.
 * - `territorial` (`AQES`, `AQ`, `CE`, `CECS`): the subject survives (identified on `D`); `AQES` takes
 *   territory from an extinct predecessor (`D − 1`), `AQ` from a surviving territory, `CE` gives to
 *   a surviving territory, `CECS` to a new one (all on `D`).
 * - `first-validity` (`PV`): never a variation (§4.3).
 *
 * A pair without a rule is a `blocking` anomaly: the per-level code sets are not documented by
 * ISTAT, so they are closed here on purpose and checked against the codes the build observes.
 * The pairs below are those of the public lists (§3.2) plus those observed in the internal
 * histories of every region and UTS record (r4/r5, 2026-10).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import type { EventCodeSummary } from '../enrich/index.ts';
import { ISTAT_EVENT_CODES, LEVELS, type IstatEventCode, type Level } from '../model/common.ts';
import type { ResolutionSide } from '../resolve/index.ts';

export type EventEffect = 'first-validity' | 'closing' | 'opening' | 'attribute' | 'territorial';

export interface TerritoryFlow {
  direction: 'subject-to-related' | 'related-to-subject';
  /** Side identifying the related territory of a row. */
  relatedSide: ResolutionSide;
}

export interface EventRule {
  effect: EventEffect;
  /** Side identifying the subject of a public row. */
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

/** Two event codes of a level that may describe the same event in the public lists and in r4–r6. */
export interface EventCodeEquivalence {
  level: Level;
  codes: readonly [IstatEventCode, IstatEventCode];
  reason: string;
}

/**
 * The closed table of equivalent event codes for matching public rows to internal events (§6.9,
 * D48): never deduced from the codes themselves. A pair must have the same rule at its level, so
 * the match changes no effect; the variation keeps the code of the public list (§3).
 */
export const EVENT_CODE_EQUIVALENCES: readonly EventCodeEquivalence[] = [
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

/** The codes equivalent to `event` at `level` (§6.9, D48), without `event` itself. */
export function equivalentEventCodes(level: Level, event: IstatEventCode): IstatEventCode[] {
  return EVENT_CODE_EQUIVALENCES.flatMap(({ level: l, codes: [a, b] }) =>
    l !== level ? [] : a === event ? [b] : b === event ? [a] : [],
  );
}

export const EVENT_RULE_ANOMALIES = {
  /** An observed `(level, event code)` pair without a rule (D27). */
  missing: 'event-rule-missing',
} as const;

/**
 * Checks the pairs observed by the build (the event code summary of the internal crawl)
 * against the rules: one `blocking` anomaly per pair without a rule.
 */
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
