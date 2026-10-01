/** SITUAS public adapter (§3.2): snapshots, event lists and counts, normalised (§6.2). */
import type { IsoDate } from '../../dates/index.ts';
import type { ClientResult, HttpClient, RequestOptions } from '../../http/index.ts';
import type { Level } from '../../model/common.ts';
import type { Snapshot } from '../../model/internal.ts';
import { countEndpoint } from './counts.ts';
import { eventListEndpoint, type EventRowByLevel } from './events.ts';
import {
  countRequest,
  EVENT_LISTS,
  eventListRequest,
  snapshotPfun,
  snapshotRequest,
  type CountParams,
  type EventListPfun,
  type EventListPfunOf,
  type SnapshotPfun,
} from './pfun.ts';
import { snapshotEndpoint } from './snapshots.ts';

export * from './counts.ts';
export * from './events.ts';
export * from './pfun.ts';
export * from './snapshots.ts';

export interface SnapshotResult<L extends Level = Level> {
  snapshot: Snapshot<L>;
  pfun: SnapshotPfun;
  /** Rows whose historical UTS code is the `COD_PROV_STORICO` fallback (§3.5); `info`. */
  historicalCodeFallbacks: number;
}

export class SituasPublicSource {
  readonly #client: HttpClient;
  readonly #baseUrl: string;

  constructor(client: HttpClient, baseUrl: string) {
    this.#client = client;
    this.#baseUrl = baseUrl;
  }

  /** Snapshot of `level` on `date`, using the `pfun` of the date's regime (§3.2). */
  async fetchSnapshot<L extends Level>(
    level: L,
    date: IsoDate,
    options?: RequestOptions,
  ): Promise<ClientResult<SnapshotResult<L>>> {
    const pfun = snapshotPfun(level, date);
    const result = await this.#client.request(
      snapshotEndpoint(pfun),
      snapshotRequest(this.#baseUrl, pfun, date),
      options,
    );
    const { rows, historicalCodeFallbacks } = result.data;
    return {
      ...result,
      data: {
        snapshot: { level, date, rows: rows as Snapshot<L>['rows'] },
        pfun,
        historicalCodeFallbacks,
      },
    };
  }

  /** Events of list `pfun` (which must belong to `level`) with administrative date in `[from, to]`. */
  async fetchEventList<L extends Level>(
    level: L,
    pfun: EventListPfunOf<L>,
    from: IsoDate,
    to: IsoDate,
    options?: RequestOptions,
  ): Promise<ClientResult<EventRowByLevel[L][]>> {
    const listPfun: EventListPfun = pfun;
    if (EVENT_LISTS[listPfun].level !== level) throw new RangeError(`pfun ${pfun} is not an event list of ${level}`);
    const result = await this.#client.request(
      eventListEndpoint(listPfun),
      eventListRequest(this.#baseUrl, listPfun, from, to),
      options,
    );
    return result as ClientResult<EventRowByLevel[L][]>;
  }

  /** Row count of a snapshot (`{ date }`) or event list (`{ from, to }`) request. */
  fetchCount(
    pfun: SnapshotPfun | EventListPfun,
    params: CountParams,
    options?: RequestOptions,
  ): Promise<ClientResult<number>> {
    return this.#client.request(countEndpoint(pfun), countRequest(this.#baseUrl, pfun, params), options);
  }
}
