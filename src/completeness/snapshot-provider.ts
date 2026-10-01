/**
 * Where the orchestrator gets snapshots from (§6.5). The real provider reads the store first:
 * a manifest of the current projection version is used as is, without network, unless the
 * request must be refreshed (today's snapshots, `audit`, `rebuild --refetch`). Otherwise the
 * snapshot is fetched through the SITUAS adapter and stored.
 *
 * Only the manifest travels back: equality is projection equality, i.e. `content_hash` (§6.3).
 */
import type { IsoDate } from '../dates/index.ts';
import type { Level } from '../model/common.ts';
import type { SituasPublicSource } from '../sources/situas-public/index.ts';
import type { AdapterStats, PutOutcome, Store } from '../store/index.ts';

/** `adapter_stats` keys of snapshot manifests (§3.5 item 16). */
export const HISTORICAL_CODE_FALLBACKS = 'historical_code_fallbacks';
export const HISTORICAL_CODE_FALLBACK_UTS_CODES = 'historical_code_fallback_uts_codes';

export interface SnapshotInfo {
  level: Level;
  date: IsoDate;
  /** Content hash of the projection: equal hashes mean equal snapshots. */
  contentHash: string;
  adapterStats: AdapterStats;
  /** `store`: the stored manifest was used; `fetched`: fetched (network or HTTP cache) and stored. */
  origin: 'store' | 'fetched';
  /** Outcome of the store put, `null` when the stored manifest was used. */
  outcome: PutOutcome | null;
}

export interface SnapshotProvider {
  /** Throws the HTTP client errors of the fetch (§6.1); the orchestrator classifies them. */
  snapshot: (level: Level, date: IsoDate) => Promise<SnapshotInfo>;
}

export interface StoreSnapshotProviderOptions {
  store: Store;
  source: SituasPublicSource;
  /**
   * Requests that skip the stored manifest and the HTTP cache (today, `audit` samples,
   * `rebuild --refetch`).
   */
  mustRefresh: (level: Level, date: IsoDate) => boolean;
}

export function storeSnapshotProvider(options: StoreSnapshotProviderOptions): SnapshotProvider {
  const { store, source, mustRefresh } = options;
  return {
    snapshot: async (level, date) => {
      const refresh = mustRefresh(level, date);
      if (!refresh) {
        const manifest = await store.getSnapshotManifest(level, date);
        if (manifest !== undefined) {
          return {
            level,
            date,
            contentHash: manifest.content_hash,
            adapterStats: manifest.adapter_stats,
            origin: 'store',
            outcome: null,
          };
        }
      }
      const { data, fetchedAt } = await source.fetchSnapshot(level, date, { cache: refresh ? 'refresh' : 'prefer' });
      const { manifest, outcome } = await store.putSnapshot(level, date, data.pfun, {
        fetchedAt,
        rows: data.snapshot.rows,
        adapterStats: {
          [HISTORICAL_CODE_FALLBACKS]: data.historicalCodeFallbacks,
          [HISTORICAL_CODE_FALLBACK_UTS_CODES]: data.historicalCodeFallbackUtsCodes,
        },
      });
      return {
        level,
        date,
        contentHash: manifest.content_hash,
        adapterStats: manifest.adapter_stats,
        origin: 'fetched',
        outcome,
      };
    },
  };
}
