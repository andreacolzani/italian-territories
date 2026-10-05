/**
 * Stable anomaly codes of the ANPR cross-check (§6.11, §8.2). Never `blocking` (D22). Warnings are
 * one per divergence; info anomalies are one per code, with the count and the items in `context`.
 */
export const ANPR_ANOMALIES = {
  /** `warning`: ANPR could not be downloaded or used; the cross-check is skipped. */
  unavailable: 'anpr-unavailable',
  /** `info`: rows the adapter dropped as malformed. */
  rowDropped: 'anpr-row-dropped',
  /** `warning`: ANPR gives an ISTAT code that never appears in the municipality's history. */
  divergentIstatCode: 'anpr-divergent-istat-code',
  /** `warning`: ANPR's name is neither the official nor the Italian name, even without diacritics. */
  divergentName: 'anpr-divergent-name',
  /** `warning`: ANPR's province is the historical code of none of the municipality's provinces, at any time. */
  divergentProvince: 'anpr-divergent-province',
  /** `warning`: a start or end differing by more than one day on a period ANPR partly covers. */
  dateDivergence: 'anpr-date-divergence',
  /** `warning`: a period only ANPR knows, matching no municipality version. */
  unmatchedPeriod: 'anpr-unmatched-period',
  /** `warning`: ANPR marks `EX` a municipality that is not former Italian. */
  formerItalianDivergence: 'anpr-former-italian-divergence',
  /** `info`: municipalities ANPR does not know at all. */
  missingEntity: 'anpr-missing-entity',
  /** `info`: periods of existence ANPR does not cover at all. */
  missingPeriod: 'anpr-missing-period',
  /** `info`: a start or end differing by one day. */
  dateOffByOne: 'anpr-date-off-by-one',
  /** `info`: consecutive ANPR rows with identical attributes. */
  splitRows: 'anpr-split-rows',
  /** `info`: days of a version on which several ANPR rows of the join key are valid, not compared. */
  notComparable: 'anpr-not-comparable',
  /** `info`: names equal only without diacritics and with uniform apostrophes. */
  nameDiacritics: 'anpr-name-diacritics',
  /** `info`: an ANPR ISTAT code the municipality had only earlier (ANPR lag, e.g. Sardinia 2026). */
  laggingIstatCode: 'anpr-lagging-istat-code',
  /** `info`: an ANPR ISTAT code the municipality has only later in its history. */
  anachronisticIstatCode: 'anpr-anachronistic-istat-code',
  /** `info`: an ANPR province the municipality belonged to only earlier (ANPR lag, e.g. Sardinia 2026). */
  laggingProvince: 'anpr-lagging-province',
  /** `info`: an ANPR province the municipality belongs to only later in its history (§3.4). */
  anachronisticProvince: 'anpr-anachronistic-province',
  /** `info`: a former Italian municipality ANPR does not mark `EX`. */
  formerItalianMissing: 'anpr-former-italian-missing',
} as const;
