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
  historicalCodeFallbacks: number;
  historicalCodeFallbackUtsCodes: string[];
}

export class SituasPublicSource {
  readonly #client: HttpClient;
  readonly #baseUrl: string;

  constructor(client: HttpClient, baseUrl: string) {
    this.#client = client;
    this.#baseUrl = baseUrl;
  }

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
    const { rows, historicalCodeFallbacks, historicalCodeFallbackUtsCodes } = result.data;
    return {
      ...result,
      data: {
        snapshot: { level, date, rows: rows as Snapshot<L>['rows'] },
        pfun,
        historicalCodeFallbacks,
        historicalCodeFallbackUtsCodes,
      },
    };
  }

  /** Administrative date in `[from, to]`, both included. */
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

  fetchCount(
    pfun: SnapshotPfun | EventListPfun,
    params: CountParams,
    options?: RequestOptions,
  ): Promise<ClientResult<number>> {
    return this.#client.request(countEndpoint(pfun), countRequest(this.#baseUrl, pfun, params), options);
  }
}
