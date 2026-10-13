/**
 * Code resolver (§6.6): the snapshot interval identified by an ISTAT code in an event row.
 *
 * 1. The side picks the lookup date (§3.5 item 6): a successor is identified by its code on the
 *    event date `D`, a predecessor by its code on `D − 1`.
 * 2. Not found: same-day aliases of `D` (`aliases.ts`), followed in the direction of the side
 *    (predecessor: code of `D` → code of `D − 1`; successor: the opposite), through chains.
 * 3. Municipalities only: the cadastral code of the event row, when the row has one, matched
 *    against the snapshot rows of the lookup date.
 * 4. Still unresolved, or more than one candidate at a step: `ResolutionError`, which the caller
 *    turns into a `blocking` anomaly (`code-unresolved`, §8.2).
 *
 * The result is a snapshot interval, not an entity: identity resolution (§6.7) attaches intervals to entities.
 * Foreign state counterparts (`Stato estero`) never reach the resolver (§3.5 item 15).
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
  /** Event date `D`: the first day of the new state. */
  date: IsoDate;
  side: ResolutionSide;
  /** Cadastral code reported next to `code` by the event row (municipalities only). */
  cadastralCode?: string | null;
}

export interface Resolution<L extends Level = Level> {
  /** `<code>@<validFrom>` of the interval: stable for the same store, but not an identity. */
  intervalKey: string;
  interval: SnapshotInterval<L>;
  path: ResolutionPath;
}

export type ResolutionFailure = 'not-found' | 'ambiguous';

export class ResolutionError extends Error {
  readonly query: ResolveQuery;
  readonly lookupDate: IsoDate;
  readonly reason: ResolutionFailure;
  /** Codes reached through same-day aliases, in visit order (the queried code excluded). */
  readonly aliasCodes: readonly string[];
  /** Keys of the competing intervals of an ambiguous step. */
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
  /** Aliases by `<level>|<date>`. */
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

  /**
   * Like {@link resolve}, adding a `blocking` anomaly instead of throwing. `context` describes
   * the event row being resolved (§8.2: full context).
   */
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

  /** Codes reachable from the queried one through the aliases of its date, towards its side. */
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
