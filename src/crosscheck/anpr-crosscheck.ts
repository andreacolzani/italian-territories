/**
 * ANPR cross-check (§6.11): ANPR rows (half-open dates, from the adapter) joined to the municipality
 * versions after the derived fields. It never writes data and never blocks (D2, D22): divergences
 * are `warning`s, one per divergence; known ANPR gaps are `info`s, one per code (§8.2).
 *
 * **Join.** A version with a cadastral code is joined to the ANPR rows with that cadastral code; a
 * version without one (pre-1930 suppressions, §3.5 item 3) falls back to the ANPR rows with its ISTAT
 * code (any cadastral code). Only rows overlapping the version count; every anomaly gives the method
 * (`matchedBy`: `cadastral` | `istat-code`). The same rule holds for both methods: consecutive rows of
 * the join key are compared day by day; rows of the join key valid on the same day are ambiguous, and
 * on those days only the version is not compared (`info`), no row is chosen.
 *
 * **Attributes**, on the overlap of each version and row:
 * - ISTAT code: equal;
 * - name: `DENOMINAZIONE_IT` (uppercase) equals the official or the Italian name in uppercase; equal
 *   only without diacritics and with uniform apostrophes (`Sampèire`/`SAMPEIRE`) is `info`, different
 *   even then is `warning`;
 * - province: `IDPROVINCIAISTAT` equals the historical code (`COD_PROV_STORICO`) of the version's
 *   province on the same dates (skipped where the province is undetermined, §6.9);
 * - a different ISTAT code or province is placed in the municipality's own history (its versions and
 *   their provinces' historical codes): a value it had earlier is an ANPR lag (`info`, e.g. Sardinia
 *   2026); otherwise a value it has later is an anachronism (`info`, e.g. Trentino 1920–23 in `022`,
 *   §3.4); a value that never appears in its history is a `warning`;
 * - `EX` region: the row overlapping the entity's last version with the latest start has region
 *   `EX` iff the entity is former Italian; ANPR missing the `EX` of a former Italian entity is `info`,
 *   an `EX` on an entity that is not former Italian is a `warning`.
 *
 * **Dates**, comparing coverages (an entity's versions; an ANPR key's rows: cadastral code, or ISTAT
 * code for rows without one):
 * - an entity no row matches: `info` (missing entity);
 * - a maximal period of existence no row covers: `info` (missing period);
 * - a period ANPR alone covers, in a stretch matching no version: `warning` (unmatched period);
 * - SITUAS covering more: more than one day `info` (missing period), e.g. Siamanna-Siapiccia from
 *   1947-11-28 in SITUAS, from 1947-12-13 in ANPR (golden-3);
 * - ANPR covering more, in a stretch it shares with SITUAS, by known cause (`info`, checked in this
 *   order): a municipality using the key at another time exists then under another key
 *   (anachronistic key); the period follows the last version of a former Italian municipality
 *   (cession extended); at most 365 days next to an establishment, reconstitution or suppression
 *   (boundary offset); otherwise `warning` (unmatched period);
 * - one day either way: `info` (off by one).
 *
 * Consecutive contiguous ANPR rows of one key with identical attributes are `info` (split rows).
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareEnds, cover } from '../build/timeline.ts';
import { compareDates, covers, daysBetween, overlaps, type HalfOpenInterval, type IsoDate } from '../dates/index.ts';
import type {
  Dated,
  DerivedFields,
  MunicipalityEntity,
  MunicipalityVersion,
  ProvinceEntity,
} from '../model/internal.ts';
import { anprRecord, compareAnprRecords, type AnprRecord } from '../sources/anpr/index.ts';
import { rowHash } from '../store/row-log.ts';
import { ANPR_ANOMALIES } from './anomalies.ts';

export type MatchMethod = 'cadastral' | 'istat-code';

/** The longest ANPR-only period next to an establishment or suppression that is an `info` (§6.11). */
const MAX_BOUNDARY_OFFSET_DAYS = 365;

/** A municipality entity with the derived field the cross-check compares. */
export type CrossCheckMunicipality = MunicipalityEntity & Pick<DerivedFields, 'isFormerItalian'>;

type InfoCode =
  | typeof ANPR_ANOMALIES.missingEntity
  | typeof ANPR_ANOMALIES.missingPeriod
  | typeof ANPR_ANOMALIES.dateOffByOne
  | typeof ANPR_ANOMALIES.boundaryOffset
  | typeof ANPR_ANOMALIES.cessionExtended
  | typeof ANPR_ANOMALIES.anachronisticKey
  | typeof ANPR_ANOMALIES.splitRows
  | typeof ANPR_ANOMALIES.notComparable
  | typeof ANPR_ANOMALIES.nameDiacritics
  | typeof ANPR_ANOMALIES.laggingName
  | typeof ANPR_ANOMALIES.anachronisticName
  | typeof ANPR_ANOMALIES.laggingIstatCode
  | typeof ANPR_ANOMALIES.anachronisticIstatCode
  | typeof ANPR_ANOMALIES.laggingProvince
  | typeof ANPR_ANOMALIES.anachronisticProvince
  | typeof ANPR_ANOMALIES.formerItalianMissing;

/** Aggregated `info` anomalies, emitted in this order. */
const INFO_MESSAGES: Record<InfoCode, string> = {
  [ANPR_ANOMALIES.missingEntity]: 'municipalities absent from ANPR',
  [ANPR_ANOMALIES.missingPeriod]: 'periods of existence absent from ANPR',
  [ANPR_ANOMALIES.dateOffByOne]: 'one-day date differences with ANPR',
  [ANPR_ANOMALIES.boundaryOffset]: 'ANPR-only periods next to an establishment or suppression, within a year',
  [ANPR_ANOMALIES.cessionExtended]: 'ANPR-only periods after a cession abroad',
  [ANPR_ANOMALIES.anachronisticKey]: 'ANPR-only periods under a key the municipality has at another time',
  [ANPR_ANOMALIES.splitRows]: 'ANPR rows split without attribute change',
  [ANPR_ANOMALIES.notComparable]: 'version periods with ambiguous ANPR rows, not compared',
  [ANPR_ANOMALIES.nameDiacritics]: 'names differing from ANPR only in diacritics or apostrophes',
  [ANPR_ANOMALIES.laggingName]: 'ANPR names the municipality had only earlier',
  [ANPR_ANOMALIES.anachronisticName]: 'ANPR names the municipality has only later',
  [ANPR_ANOMALIES.laggingIstatCode]: 'ANPR ISTAT codes the municipality had only earlier',
  [ANPR_ANOMALIES.anachronisticIstatCode]: 'ANPR ISTAT codes the municipality has only later',
  [ANPR_ANOMALIES.laggingProvince]: 'ANPR provinces the municipality belonged to only earlier',
  [ANPR_ANOMALIES.anachronisticProvince]: 'ANPR provinces the municipality belongs to only later',
  [ANPR_ANOMALIES.formerItalianMissing]: 'former Italian municipalities without the ANPR EX region',
};

interface VersionRef {
  entity: CrossCheckMunicipality;
  version: MunicipalityVersion;
  matchedBy: MatchMethod;
}

export function crossCheckAnpr(options: {
  /** The ANPR rows (as stored, §6.3: without the CSV line). */
  anpr: { rows: readonly AnprRecord[] };
  /** After the derived fields (§7). */
  municipalities: readonly CrossCheckMunicipality[];
  provinces: readonly ProvinceEntity[];
  anomalies: AnomalyCollector;
}): void {
  const { anomalies } = options;
  const info = new Map<InfoCode, unknown[]>(Object.keys(INFO_MESSAGES).map((code) => [code as InfoCode, []]));
  const addInfo = (code: InfoCode, item: unknown): void => {
    info.get(code)?.push(item);
  };
  const warn = (code: string, message: string, context: Record<string, unknown>): void => {
    anomalies.add({ level: 'warning', code, message, context });
  };

  const historicalCodes = new Map(options.provinces.map((p) => [p.id, p.historicalCodes]));
  const rows = [...options.anpr.rows].sort(compareAnprRecords);
  const rowsByCadastral = groupBy(
    rows.filter((r) => r.cadastralCode !== null),
    (r) => r.cadastralCode ?? '',
  );
  const rowsByCode = groupBy(rows, (r) => r.istatCode);

  const municipalities = [...options.municipalities].sort((a, b) => a.id - b.id);
  const versionsByCadastral = new Map<string, VersionRef[]>();
  const uncodedVersionsByCode = new Map<string, VersionRef[]>();
  for (const entity of municipalities) {
    for (const version of entity.versions) {
      const { cadastralCode } = version;
      if (cadastralCode === null)
        push(uncodedVersionsByCode, version.istatCode, { entity, version, matchedBy: 'istat-code' });
      else push(versionsByCadastral, cadastralCode, { entity, version, matchedBy: 'cadastral' });
    }
  }

  const candidateRows = ({ version, matchedBy }: VersionRef): AnprRecord[] =>
    (matchedBy === 'cadastral'
      ? rowsByCadastral.get(version.cadastralCode ?? '')
      : rowsByCode.get(version.istatCode)) ?? [];
  const candidateVersions = (row: AnprRecord): VersionRef[] => [
    ...(row.cadastralCode === null ? [] : (versionsByCadastral.get(row.cadastralCode) ?? [])),
    ...(uncodedVersionsByCode.get(row.istatCode) ?? []),
  ];

  /** The names (official and Italian, uppercase as ANPR writes them) of the entity's versions over `range`. */
  const namesIn = (entity: CrossCheckMunicipality, range: HalfOpenInterval): Set<string> =>
    new Set(
      entity.versions.filter((v) => overlaps(v, range)).flatMap((v) => [upper(v.officialName), upper(v.italianName)]),
    );

  /** The ISTAT codes of the entity's versions over `range`. */
  const istatCodesIn = (entity: CrossCheckMunicipality, range: HalfOpenInterval): Set<string> =>
    new Set(entity.versions.filter((v) => overlaps(v, range)).map((v) => v.istatCode));

  /** The historical codes of the entity's provinces over `range`. */
  const provinceCodesIn = (entity: CrossCheckMunicipality, range: HalfOpenInterval): Set<string> => {
    const codes = new Set<string>();
    for (const version of entity.versions) {
      if (version.provinceId === null || !overlaps(version, range)) continue;
      const pieces = cover<string | null>(
        intersection(version, range),
        historicalCodes.get(version.provinceId) ?? [],
        null,
      );
      for (const piece of pieces) if (piece.value !== null) codes.add(piece.value);
    }
    return codes;
  };

  /**
   * Where an ANPR value different from ours on `period` lies in the entity's history: `lagging` if
   * the entity had it before `period` (checked first), `anachronistic` if it has it after, `null` if
   * never.
   */
  const placeInHistory = (
    entity: CrossCheckMunicipality,
    period: HalfOpenInterval,
    valuesIn: (entity: CrossCheckMunicipality, range: HalfOpenInterval) => Set<string>,
    value: string,
  ): 'lagging' | 'anachronistic' | null => {
    const first = entity.versions[0]?.validFrom;
    if (first !== undefined && compareDates(first, period.validFrom) < 0) {
      if (valuesIn(entity, { validFrom: first, validTo: period.validFrom }).has(value)) return 'lagging';
    }
    if (period.validTo !== null && valuesIn(entity, { validFrom: period.validTo, validTo: null }).has(value)) {
      return 'anachronistic';
    }
    return null;
  };

  /** Compares a version with one row on a period of their overlap where no other row is valid. */
  const compareRow = (ref: VersionRef, row: AnprRecord, period: HalfOpenInterval): void => {
    const { entity, version, matchedBy } = ref;
    const context = {
      matchedBy,
      entityId: entity.id,
      versionId: version.id,
      validFrom: period.validFrom,
      validTo: period.validTo,
      anprRow: rowRef(row),
    };
    const where = `municipality ${entity.id} (version ${version.id}, ${describe(period)})`;
    if (version.istatCode !== row.istatCode) {
      const item = { ...context, situas: version.istatCode, anpr: row.istatCode };
      const place = placeInHistory(entity, period, istatCodesIn, row.istatCode);
      if (place === 'lagging') addInfo(ANPR_ANOMALIES.laggingIstatCode, item);
      else if (place === 'anachronistic') addInfo(ANPR_ANOMALIES.anachronisticIstatCode, item);
      else {
        warn(
          ANPR_ANOMALIES.divergentIstatCode,
          `${where}: ISTAT code ${version.istatCode}, ANPR ${row.istatCode}`,
          item,
        );
      }
    }
    const names = [version.officialName, version.italianName];
    if (!names.some((n) => upper(n) === row.italianName)) {
      const situas = { officialName: version.officialName, italianName: version.italianName };
      const place = placeInHistory(entity, period, namesIn, row.italianName);
      if (names.some((n) => looseName(n) === looseName(row.italianName))) {
        addInfo(ANPR_ANOMALIES.nameDiacritics, { ...context, situas, anpr: row.italianName });
      } else if (place === 'lagging') {
        addInfo(ANPR_ANOMALIES.laggingName, { ...context, situas, anpr: row.italianName });
      } else if (place === 'anachronistic') {
        addInfo(ANPR_ANOMALIES.anachronisticName, { ...context, situas, anpr: row.italianName });
      } else {
        warn(
          ANPR_ANOMALIES.divergentName,
          `${where}: name ${JSON.stringify(version.officialName)}, ANPR ${JSON.stringify(row.italianName)}`,
          { ...context, situas, anpr: row.italianName },
        );
      }
    }
    if (version.provinceId === null) return;
    const divergent = cover<string | null>(period, historicalCodes.get(version.provinceId) ?? [], null).filter(
      (p): p is Dated<string> => p.value !== null && p.value !== row.provinceCode,
    );
    const situasCodes = (pieces: readonly Dated<string>[]) =>
      pieces.map((p) => ({ validFrom: p.validFrom, validTo: p.validTo, historicalCode: p.value }));
    const placed = (place: 'lagging' | 'anachronistic' | null) =>
      divergent.filter((p) => placeInHistory(entity, p, provinceCodesIn, row.provinceCode) === place);
    const item = (pieces: readonly Dated<string>[]) => ({
      ...context,
      provinceId: version.provinceId,
      situas: situasCodes(pieces),
      anpr: row.provinceCode,
    });
    const lagging = placed('lagging');
    const anachronistic = placed('anachronistic');
    const others = placed(null);
    if (lagging.length > 0) addInfo(ANPR_ANOMALIES.laggingProvince, item(lagging));
    if (anachronistic.length > 0) addInfo(ANPR_ANOMALIES.anachronisticProvince, item(anachronistic));
    if (others.length > 0) {
      warn(
        ANPR_ANOMALIES.divergentProvince,
        `${where}: province ${version.provinceId} with historical code ` +
          `${[...new Set(others.map((p) => p.value))].join(', ')}, ANPR ${row.provinceCode}`,
        item(others),
      );
    }
  };

  /**
   * Compares the attributes of a version with its overlapping rows, day by day: on the days where
   * several rows of the join key are valid the version is not compared.
   */
  const compareAttributes = (ref: VersionRef, overlapping: readonly AnprRecord[]): void => {
    const { entity, version, matchedBy } = ref;
    const ambiguous = union(sharedDays(overlapping))
      .filter((period) => overlaps(period, version))
      .map((period) => intersection(period, version));
    for (const period of ambiguous) {
      addInfo(ANPR_ANOMALIES.notComparable, {
        entityId: entity.id,
        versionId: version.id,
        matchedBy,
        validFrom: period.validFrom,
        validTo: period.validTo,
        anprRows: overlapping.filter((r) => overlaps(period, r)).map(rowSummary),
      });
    }
    for (const row of overlapping) {
      for (const period of subtract(intersection(version, row), ambiguous)) compareRow(ref, row, period);
    }
  };

  // SITUAS side: attributes, then the periods of each entity that no row covers.
  for (const entity of municipalities) {
    let matched = false;
    const uncovered: { piece: HalfOpenInterval; ref: VersionRef; rows: AnprRecord[] }[] = [];
    for (const version of entity.versions) {
      const ref: VersionRef = {
        entity,
        version,
        matchedBy: version.cadastralCode === null ? 'istat-code' : 'cadastral',
      };
      const candidates = candidateRows(ref);
      const overlapping = candidates.filter((r) => overlaps(version, r));
      if (overlapping.length > 0) matched = true;
      compareAttributes(ref, overlapping);
      for (const piece of subtract(version, candidates)) uncovered.push({ piece, ref, rows: candidates });
    }
    if (!matched) {
      addInfo(ANPR_ANOMALIES.missingEntity, {
        entityId: entity.id,
        istatOriginId: entity.istatOriginId,
        versions: entity.versions.map(versionSummary),
      });
      continue;
    }

    const segments = union(entity.versions);
    for (const piece of union(uncovered.map((u) => u.piece))) {
      const inside = uncovered.filter((u) => covers(piece, u.piece));
      const segment = segments.find((s) => covers(s, piece)) ?? piece;
      const item = {
        entityId: entity.id,
        versionIds: inside.map((u) => u.ref.version.id),
        matchedBy: [...new Set(inside.map((u) => u.ref.matchedBy))],
        validFrom: piece.validFrom,
        validTo: piece.validTo,
      };
      if (sameInterval(piece, segment)) {
        addInfo(ANPR_ANOMALIES.missingPeriod, item);
      } else if (days(piece) === 1) {
        addInfo(ANPR_ANOMALIES.dateOffByOne, { ...item, side: 'situas-only' });
      } else {
        // ANPR covers less than SITUAS: a missing part of a period (golden-3, Siamanna 1947).
        const anprRows = uniqueRows(inside.flatMap((u) => u.rows)).filter((r) => overlaps(segment, r));
        addInfo(ANPR_ANOMALIES.missingPeriod, {
          ...item,
          side: 'situas-only',
          edge: edge(piece, segment),
          segment: { validFrom: segment.validFrom, validTo: segment.validTo },
          anprRows: anprRows.map(rowSummary),
        });
      }
    }

    // `EX` region against `is_former_italian`, on the entity's last version.
    const last = entity.versions.at(-1);
    if (last === undefined) continue;
    const lastRef: VersionRef = {
      entity,
      version: last,
      matchedBy: last.cadastralCode === null ? 'istat-code' : 'cadastral',
    };
    const overlapping = candidateRows(lastRef).filter((r) => overlaps(last, r));
    const latest = overlapping.reduce<IsoDate | null>(
      (max, r) => (max === null || compareDates(r.validFrom, max) > 0 ? r.validFrom : max),
      null,
    );
    // Rows with the same start are valid on the same day: ambiguous, not compared.
    const [row, ...others] = overlapping.filter((r) => r.validFrom === latest);
    if (row === undefined || others.length > 0 || (row.regionCode === 'EX') === entity.isFormerItalian) continue;
    const context = {
      matchedBy: lastRef.matchedBy,
      entityId: entity.id,
      versionId: last.id,
      isFormerItalian: entity.isFormerItalian,
      anprRegion: row.regionCode,
      anprRow: rowRef(row),
    };
    if (entity.isFormerItalian) {
      addInfo(ANPR_ANOMALIES.formerItalianMissing, context);
      continue;
    }
    warn(
      ANPR_ANOMALIES.formerItalianDivergence,
      `municipality ${entity.id}: not former Italian, ANPR region EX`,
      context,
    );
  }

  // ANPR side: split rows, then the periods of each key that no version covers.
  const byKey = groupBy(rows, (r) => r.cadastralCode ?? `istat:${r.istatCode}`);
  for (const [key, keyRows] of byKey) {
    const sorted = [...keyRows].sort((a, b) => compareDates(a.validFrom, b.validFrom) || compareAnprRecords(a, b));
    sorted.forEach((row, i) => {
      const previous = sorted[i - 1];
      if (previous?.validTo !== row.validFrom || attributeKey(previous) !== attributeKey(row)) return;
      addInfo(ANPR_ANOMALIES.splitRows, {
        key,
        istatCode: row.istatCode,
        date: row.validFrom,
        anprRows: [rowRef(previous), rowRef(row)],
      });
    });

    for (const stretch of union(sorted)) {
      const stretchRows = sorted.filter((r) => overlaps(stretch, r));
      const matched = stretchRows.some((r) => candidateVersions(r).some((v) => overlaps(v.version, r)));
      if (!matched) {
        warn(ANPR_ANOMALIES.unmatchedPeriod, `ANPR ${key}: ${describe(stretch)} matches no municipality version`, {
          key,
          validFrom: stretch.validFrom,
          validTo: stretch.validTo,
          anprRows: stretchRows.map(rowSummary),
        });
        continue;
      }
      const pieces = union(
        stretchRows.flatMap((r) =>
          subtract(
            r,
            candidateVersions(r).map((v) => v.version),
          ),
        ),
      );
      for (const piece of pieces) {
        const pieceRows = stretchRows.filter((r) => overlaps(piece, r));
        const near = uniqueVersions(stretchRows.flatMap(candidateVersions)).filter((v) => overlaps(stretch, v.version));
        const item = {
          key,
          validFrom: piece.validFrom,
          validTo: piece.validTo,
          anprRows: pieceRows.map(rowRef),
          side: 'anpr-only',
        };
        if (days(piece) === 1) {
          addInfo(ANPR_ANOMALIES.dateOffByOne, item);
          continue;
        }
        const known = knownCause(piece, near);
        if (known !== null) {
          addInfo(known.code, { ...item, edge: edge(piece, stretch), ...known.context });
          continue;
        }
        // ANPR covers more than SITUAS, for no known cause.
        warn(
          ANPR_ANOMALIES.unmatchedPeriod,
          `ANPR ${key}: ${describe(piece)} exists in ANPR, not in SITUAS ` +
            `(${edge(piece, stretch)} of ${describe(stretch)})`,
          {
            ...item,
            edge: edge(piece, stretch),
            segment: { validFrom: stretch.validFrom, validTo: stretch.validTo },
            versions: near.map((v) => ({
              entityId: v.entity.id,
              matchedBy: v.matchedBy,
              ...versionSummary(v.version),
            })),
          },
        );
      }
    }
  }

  for (const [code, items] of info) {
    if (items.length === 0) continue;
    anomalies.add({
      level: 'info',
      code,
      message: `${items.length} ${INFO_MESSAGES[code]}`,
      context: { count: items.length, items },
    });
  }
}

/** Uppercase as ANPR writes names (`Agliè` → `AGLIÈ`). */
/**
 * The known cause of an ANPR-only `piece` next to the versions `near` (of the join key, in the
 * stretch), in the order of §6.11, or `null`.
 */
function knownCause(
  piece: HalfOpenInterval,
  near: readonly VersionRef[],
): { code: InfoCode; context: Record<string, unknown> } | null {
  const entities = [...new Map(near.map((v) => [v.entity.id, v.entity])).values()];
  for (const entity of entities) {
    const existing = entity.versions.filter((v) => overlaps(v, piece));
    if (existing.length === 0) continue;
    return {
      code: ANPR_ANOMALIES.anachronisticKey,
      context: { entityId: entity.id, versions: existing.map(versionSummary) },
    };
  }
  for (const { entity, version } of near) {
    if (version.validTo !== piece.validFrom || entity.versions.at(-1) !== version || !entity.isFormerItalian) continue;
    return { code: ANPR_ANOMALIES.cessionExtended, context: { entityId: entity.id, versionId: version.id } };
  }
  if (days(piece) > MAX_BOUNDARY_OFFSET_DAYS) return null;
  for (const { entity, version } of near) {
    const established =
      version.validFrom === piece.validTo && !entity.versions.some((v) => v.validTo === version.validFrom);
    const suppressed =
      version.validTo === piece.validFrom && !entity.versions.some((v) => v.validFrom === version.validTo);
    if (!established && !suppressed) continue;
    return {
      code: ANPR_ANOMALIES.boundaryOffset,
      context: {
        entityId: entity.id,
        versionId: version.id,
        boundary: established ? 'establishment' : 'suppression',
        days: days(piece),
      },
    };
  }
  return null;
}

function upper(name: string): string {
  return name.toLocaleUpperCase('it');
}

/** The ANPR attributes whose equality makes two consecutive rows a split without change. */
function attributeKey(row: AnprRecord): string {
  return JSON.stringify([
    row.istatCode,
    row.cadastralCode,
    row.italianName,
    row.otherName,
    row.provinceCode,
    row.regionCode,
    row.provinceAbbreviation,
  ]);
}

/** Comparison key of names: uppercase, without diacritics, with uniform apostrophes and no spaces around them. */
function looseName(name: string): string {
  return upper(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/\s*'\s*/g, "'")
    .normalize('NFC');
}

/** The days on which two of `rows` are valid (pairwise overlaps, not merged). */
function sharedDays(rows: readonly AnprRecord[]): HalfOpenInterval[] {
  return rows.flatMap((a, i) =>
    rows
      .slice(i + 1)
      .filter((b) => overlaps(a, b))
      .map((b) => intersection(a, b)),
  );
}

/** Overlapping or contiguous intervals merged, sorted. */
function union(intervals: readonly HalfOpenInterval[]): HalfOpenInterval[] {
  const sorted = [...intervals].sort((a, b) => compareDates(a.validFrom, b.validFrom));
  const merged: HalfOpenInterval[] = [];
  for (const { validFrom, validTo } of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && compareEnds(validFrom, last.validTo) <= 0) {
      if (compareEnds(validTo, last.validTo) > 0) last.validTo = validTo;
    } else {
      merged.push({ validFrom, validTo });
    }
  }
  return merged;
}

/** The parts of `range` that no interval of `covering` covers. */
function subtract(range: HalfOpenInterval, covering: readonly HalfOpenInterval[]): HalfOpenInterval[] {
  const covered = union(covering).map((i) => ({ ...i, value: true }));
  return cover(range, covered, false)
    .filter((p) => !p.value)
    .map(({ validFrom, validTo }) => ({ validFrom, validTo }));
}

function intersection(a: HalfOpenInterval, b: HalfOpenInterval): HalfOpenInterval {
  return {
    validFrom: compareDates(a.validFrom, b.validFrom) >= 0 ? a.validFrom : b.validFrom,
    validTo: compareEnds(a.validTo, b.validTo) <= 0 ? a.validTo : b.validTo,
  };
}

function sameInterval(a: HalfOpenInterval, b: HalfOpenInterval): boolean {
  return a.validFrom === b.validFrom && a.validTo === b.validTo;
}

function days(interval: HalfOpenInterval): number {
  return interval.validTo === null ? Infinity : daysBetween(interval.validFrom, interval.validTo);
}

/** Where `piece` lies in `segment`. */
function edge(piece: HalfOpenInterval, segment: HalfOpenInterval): 'start' | 'end' | 'inside' {
  if (piece.validFrom === segment.validFrom) return 'start';
  if (piece.validTo === segment.validTo) return 'end';
  return 'inside';
}

function describe({ validFrom, validTo }: HalfOpenInterval): string {
  return `[${validFrom}, ${validTo ?? '…'})`;
}

/** Identifies an ANPR row in anomaly contexts. */
/**
 * Identifies an ANPR row in anomaly contexts: its store row hash (§6.3; unique, unlike the other
 * fields when ANPR repeats a row) and the fields a reader needs to find it.
 */
function rowRef(row: AnprRecord) {
  return {
    hash: rowHash(anprRecord(row)),
    istatCode: row.istatCode,
    cadastralCode: row.cadastralCode,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

function rowSummary(row: AnprRecord) {
  return {
    hash: rowHash(anprRecord(row)),
    validFrom: row.validFrom,
    validTo: row.validTo,
    istatCode: row.istatCode,
    cadastralCode: row.cadastralCode,
    italianName: row.italianName,
  };
}

function versionSummary(version: MunicipalityVersion) {
  return {
    versionId: version.id,
    validFrom: version.validFrom,
    validTo: version.validTo,
    istatCode: version.istatCode,
    cadastralCode: version.cadastralCode,
  };
}

function uniqueRows(rows: readonly AnprRecord[]): AnprRecord[] {
  return [...new Set(rows)].sort(compareAnprRecords);
}

function uniqueVersions(refs: readonly VersionRef[]): VersionRef[] {
  const byVersion = new Map(refs.map((r) => [r.version.id, r]));
  return [...byVersion.values()].sort((a, b) => a.version.id - b.version.id);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) push(groups, key(item), item);
  return groups;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
