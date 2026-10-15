/**
 * §6.6. A successor is identified by its code on the event date `D`, a predecessor by its code on
 * `D − 1` (§3.5 item 6). The result is a snapshot interval, never an entity (§6.7). `Stato estero`
 * counterparts never get here (§3.5 item 15).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { previousDay, type IsoDate } from '../dates/index.ts';
import type { Level } from '../model/common.ts';
import type { Anomaly } from '../model/internal.ts';
import type { CodeAlias } from './aliases.ts';
import type { IntervalIndex, SnapshotInterval } from './interval-index.ts';

export type ResolutionSide = 'successor' | 'predecessor';
export type ResolutionPath = 'direct' | 'alias' | 'cadastral';

export interface ResolveQuery<L extends Level = Level> {
  level: L;
  code: string;
  date: IsoDate;
  side: ResolutionSide;
  cadastralCode?: string | null;
}

export interface Resolution<L extends Level = Level> {
  /** Not an identity: stable only within one store. */
  intervalKey: string;
  interval: SnapshotInterval<L>;
  path: ResolutionPath;
}

export type ResolutionFailure = 'not-found' | 'ambiguous';

export class ResolutionError extends Error {
  readonly query: ResolveQuery;
  readonly lookupDate: IsoDate;
  readonly reason: ResolutionFailure;
  readonly aliasCodes: readonly string[];
  readonly candidates: readonly string[];

  constructor(init: {
    query: ResolveQuery;
    lookupDate: IsoDate;
    reason: ResolutionFailure;
    aliasCodes: readonly string[];
    candidates: readonly string[];
  }) {
    const { query, lookupDate, reason } = init;
    super(
      `${query.level} code ${query.code} (${query.side} of ${query.date}) ${
        reason === 'ambiguous'
          ? `is ambiguous on ${lookupDate}: ${init.candidates.join(', ')}`
          : `not found on ${lookupDate}`
      }`,
    );
    this.name = 'ResolutionError';
    this.query = query;
    this.lookupDate = lookupDate;
    this.reason = reason;
    this.aliasCodes = init.aliasCodes;
    this.candidates = init.candidates;
  }
}

export const RESOLVER_ANOMALIES = {
  unresolved: 'code-unresolved',
} as const;

export type IntervalIndexes = { [L in Level]?: IntervalIndex<L> };

export class CodeResolver {
  readonly #indexes: IntervalIndexes;
  readonly #aliases = new Map<string, CodeAlias[]>();

  constructor(indexes: IntervalIndexes, aliases: readonly CodeAlias[] = []) {
    this.#indexes = indexes;
    for (const alias of aliases) {
      const key = `${alias.level}|${alias.date}`;
      const list = this.#aliases.get(key);
      if (list === undefined) this.#aliases.set(key, [alias]);
      else list.push(alias);
    }
  }

  resolve<L extends Level>(query: ResolveQuery<L>): Resolution<L> {
    const index = this.#indexes[query.level];
    if (index === undefined) throw new RangeError(`no interval index for level ${query.level}`);
    const lookupDate = query.side === 'successor' ? query.date : previousDay(query.date);
    const fail = (reason: ResolutionFailure, aliasCodes: readonly string[], candidates: SnapshotInterval[] = []) =>
      new ResolutionError({ query, lookupDate, reason, aliasCodes, candidates: candidates.map(intervalKey) });

    const direct = index.at(query.code, lookupDate);
    if (direct !== undefined) return resolution(direct, 'direct');

    const aliasCodes = this.#aliasCodes(query);
    const viaAlias = unique(aliasCodes.flatMap((code) => index.at(code, lookupDate) ?? []));
    if (viaAlias.length > 1) throw fail('ambiguous', aliasCodes, viaAlias);
    if (viaAlias[0] !== undefined) return resolution(viaAlias[0], 'alias');

    const cadastral = query.cadastralCode ?? null;
    if (query.level === 'municipality' && cadastral !== null) {
      const viaCadastral = index.findAt(lookupDate, (row) => 'cadastralCode' in row && row.cadastralCode === cadastral);
      if (viaCadastral.length > 1) throw fail('ambiguous', aliasCodes, viaCadastral);
      if (viaCadastral[0] !== undefined) return resolution(viaCadastral[0], 'cadastral');
    }
    throw fail('not-found', aliasCodes);
  }

  resolveOrReport<L extends Level>(
    query: ResolveQuery<L>,
    anomalies: AnomalyCollector,
    context: Record<string, unknown> = {},
  ): Resolution<L> | null {
    try {
      return this.resolve(query);
    } catch (error) {
      if (!(error instanceof ResolutionError)) throw error;
      anomalies.add(resolutionAnomaly(error, context));
      return null;
    }
  }

  #aliasCodes(query: ResolveQuery): string[] {
    const aliases = this.#aliases.get(`${query.level}|${query.date}`) ?? [];
    const visited = new Set([query.code]);
    const reached: string[] = [];
    let frontier = [query.code];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const alias of aliases) {
        const [known, other] = query.side === 'predecessor' ? [alias.to, alias.from] : [alias.from, alias.to];
        if (!frontier.includes(known) || visited.has(other)) continue;
        visited.add(other);
        reached.push(other);
        next.push(other);
      }
      frontier = next;
    }
    return reached;
  }
}

export function resolutionAnomaly(error: ResolutionError, context: Record<string, unknown> = {}): Anomaly {
  const { query } = error;
  return {
    level: 'blocking',
    code: RESOLVER_ANOMALIES.unresolved,
    message: error.message,
    context: {
      ...context,
      level: query.level,
      code: query.code,
      date: query.date,
      side: query.side,
      cadastral_code: query.cadastralCode ?? null,
      lookup_date: error.lookupDate,
      reason: error.reason,
      alias_codes: error.aliasCodes,
      candidates: error.candidates,
    },
  };
}

function intervalKey(interval: SnapshotInterval): string {
  return `${interval.code}@${interval.validFrom}`;
}

function resolution<L extends Level>(interval: SnapshotInterval<L>, path: ResolutionPath): Resolution<L> {
  return { intervalKey: intervalKey(interval), interval, path };
}

function unique<L extends Level>(intervals: SnapshotInterval<L>[]): SnapshotInterval<L>[] {
  return [...new Map(intervals.map((i) => [intervalKey(i), i])).values()];
}
