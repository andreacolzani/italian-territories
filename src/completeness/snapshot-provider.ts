/** Only the manifest travels back: snapshot equality is `content_hash` equality (§6.3). */
import type { IsoDate } from '../dates/index.ts';
import type { CachePolicy } from '../http/index.ts';
import type { Level } from '../model/common.ts';
import type { SituasPublicSource } from '../sources/situas-public/index.ts';
import { NotInStoreError, type AdapterStats, type PutOutcome, type Store } from '../store/index.ts';

export const HISTORICAL_CODE_FALLBACKS = 'historical_code_fallbacks';
export const HISTORICAL_CODE_FALLBACK_UTS_CODES = 'historical_code_fallback_uts_codes';

export interface SnapshotInfo {
  level: Level;
  date: IsoDate;
  contentHash: string;
  adapterStats: AdapterStats;
  /** `fetched` includes the HTTP cache. */
  origin: 'store' | 'fetched';
  outcome: PutOutcome | null;
}

export interface SnapshotProvider {
  snapshot: (level: Level, date: IsoDate) => Promise<SnapshotInfo>;
}

export interface StoreSnapshotProviderOptions {
  store: Store;
  source: SituasPublicSource;
  mustRefresh: (level: Level, date: IsoDate) => boolean;
  /** `{ fetchedSince: today }` in `rebuild --refetch`, so an interrupted refetch resumes the same day. */
  refreshPolicy?: CachePolicy;
  offline?: boolean;
}

export function storeSnapshotProvider(options: StoreSnapshotProviderOptions): SnapshotProvider {
  const { store, source, mustRefresh, offline = false, refreshPolicy = 'refresh' } = options;
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
      if (offline) throw new NotInStoreError(`snapshot ${level} ${date}`);
      const { data, fetchedAt } = await source.fetchSnapshot(level, date, {
        cache: refresh ? refreshPolicy : 'prefer',
      });
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
