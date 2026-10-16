/** Each list feeds both the TypeScript union and the zod enum. */

/** `province` covers every UTS type (§2). */
export const LEVELS = ['region', 'province', 'municipality'] as const;
export type Level = (typeof LEVELS)[number];

/** `CT` is undocumented by ISTAT and appears only in the internal UTS events (§3.5 item 18). */
export const ISTAT_EVENT_CODES = [
  'PV',
  'CS',
  'CSCT',
  'AN',
  'AQES',
  'AQ',
  'CE',
  'CECS',
  'CD',
  'AP',
  'CDAP',
  'RN',
  'RNAPUTS',
  'VACST',
  'CT',
  'ES',
  'ESCT',
  'AS',
] as const;
export type IstatEventCode = (typeof ISTAT_EVENT_CODES)[number];

const TERRITORIAL_EVENT_CODES = ['AQ', 'CE', 'AQES', 'CECS'] as const satisfies readonly IstatEventCode[];

/**
 * The counterpart may be a foreign state with no code (§3.5 item 15; `AQ` verified in r7: Lombardia,
 * 1866-11-20, act 3619).
 */
export const ABROAD_EVENT_CODES = ['AS', 'AN', 'CE', 'AQ'] as const satisfies readonly IstatEventCode[];

/** Indexed by the ISTAT `tipo regione` value minus one. */
export const REGION_TYPES = ['compartment', 'region'] as const;
export type RegionType = (typeof REGION_TYPES)[number];

/** Indexed by the ISTAT `TIPO_UTS` value minus one. */
export const UTS_TYPES = [
  'province',
  'autonomous_province',
  'metropolitan_city',
  'free_municipal_consortium',
  'non_administrative_unit',
] as const;
export type UtsType = (typeof UTS_TYPES)[number];

export const ENTITY_STATUSES = ['active', 'suppressed'] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export const LINK_KINDS = ['merged_into', 'detached_into', 'transferred_to'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** `transferred_to` is never published; `split_into` is derived (D44). */
export const PUBLIC_LINK_KINDS = ['merged_into', 'split_into', 'detached_into'] as const;
export type PublicLinkKind = (typeof PUBLIC_LINK_KINDS)[number];

export const ENTITY_ID_PREFIXES: Readonly<Record<Level, string>> = {
  region: 'reg',
  province: 'prv',
  municipality: 'mun',
};

/** `<prefix>-<code>`, the code of 6 Crockford base32 characters (D42). */
export const ENTITY_ID_PATTERN = /^(reg|prv|mun)-[0-9A-HJKMNP-TV-Z]{6}$/;
export type EntityId = string;

export const VARIATION_ORIGINS = ['istat', 'inferred'] as const;
export type VariationOrigin = (typeof VARIATION_ORIGINS)[number];

export const PARTICIPANT_ROLES = [
  'established',
  'annexed',
  'suppressed',
  'ceded',
  'changed',
  'territory_changed',
  'indirect',
] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const ANOMALY_LEVELS = ['blocking', 'warning', 'info'] as const;
export type AnomalyLevel = (typeof ANOMALY_LEVELS)[number];

export const ISTAT_CODE_PATTERNS: Readonly<Record<Level, RegExp>> = {
  region: /^\d{2}$/,
  province: /^\d{3}$/,
  municipality: /^\d{6}$/,
};
export const CADASTRAL_CODE_PATTERN = /^[A-Z]\d{3}$/;
export const ABBREVIATION_PATTERN = /^[A-Z]{2}$/;

export function regionTypeFromIstat(value: number): RegionType {
  const type = REGION_TYPES[value - 1];
  if (!Number.isInteger(value) || type === undefined) throw new RangeError(`unknown ISTAT region type ${value}`);
  return type;
}

export function utsTypeFromIstat(value: number): UtsType {
  const type = UTS_TYPES[value - 1];
  if (!Number.isInteger(value) || type === undefined) throw new RangeError(`unknown ISTAT UTS type ${value}`);
  return type;
}

export function regionTypeToIstat(type: RegionType): number {
  return REGION_TYPES.indexOf(type) + 1;
}

export function utsTypeToIstat(type: UtsType): number {
  return UTS_TYPES.indexOf(type) + 1;
}

export interface ParticipantRoleRule {
  versionBefore: boolean;
  versionAfter: boolean;
  oneOf?: readonly IstatEventCode[];
  /** An empty list means "no own event". */
  only?: readonly IstatEventCode[];
  requiresOwnEvent: boolean;
}

export const PARTICIPANT_ROLE_RULES: Readonly<Record<ParticipantRole, ParticipantRoleRule>> = {
  established: { versionBefore: false, versionAfter: true, oneOf: ['CS', 'CSCT'], requiresOwnEvent: true },
  annexed: { versionBefore: false, versionAfter: true, oneOf: ['AN'], requiresOwnEvent: true },
  suppressed: { versionBefore: true, versionAfter: false, oneOf: ['ES', 'ESCT'], requiresOwnEvent: true },
  ceded: { versionBefore: true, versionAfter: false, oneOf: ['AS'], requiresOwnEvent: true },
  changed: { versionBefore: true, versionAfter: true, requiresOwnEvent: true },
  territory_changed: {
    versionBefore: false,
    versionAfter: false,
    only: TERRITORIAL_EVENT_CODES,
    requiresOwnEvent: true,
  },
  indirect: { versionBefore: true, versionAfter: true, only: [], requiresOwnEvent: false },
};

export function participantRoleViolations(participant: {
  role: ParticipantRole;
  istatEvents: readonly IstatEventCode[];
  /** `validFrom` of the closed version. */
  versionBefore: string | null;
  /** `validFrom` of the opened version. */
  versionAfter: string | null;
}): string[] {
  const { role, istatEvents, versionBefore, versionAfter } = participant;
  const rule = PARTICIPANT_ROLE_RULES[role];
  const violations: string[] = [];
  const presence = (present: boolean): string => (present ? 'required' : 'forbidden');
  if ((versionBefore !== null) !== rule.versionBefore) {
    violations.push(`role ${role}: version_before is ${presence(rule.versionBefore)}`);
  }
  if ((versionAfter !== null) !== rule.versionAfter) {
    violations.push(`role ${role}: version_after is ${presence(rule.versionAfter)}`);
  }
  if (rule.requiresOwnEvent && istatEvents.length === 0) {
    violations.push(`role ${role}: at least one own ISTAT event is required`);
  }
  const { oneOf, only } = rule;
  if (oneOf && !istatEvents.some((e) => oneOf.includes(e))) {
    violations.push(`role ${role}: requires one of the events ${oneOf.join(', ')}`);
  }
  if (only) {
    const extra = istatEvents.filter((e) => !only.includes(e));
    if (extra.length > 0) violations.push(`role ${role}: events ${extra.join(', ')} are not allowed`);
  }
  return violations;
}
