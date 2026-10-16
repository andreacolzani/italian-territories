/**
 * §6.11. Never writes data and never blocks (D2, D22). The cadastral code is missing for pre-1930
 * suppressions (§3.5 item 3) and on some ANPR rows, so the join falls back to the ISTAT code. On days
 * where several rows of the join key are valid no row is chosen. ANPR lags behind SITUAS (Sardinia
 * 2026) and anticipates it (Trentino 1920–23 already in `022`, §3.4), so a value found elsewhere in
 * the municipality's history is only `info`. The data stop at `today`, so ANPR is compared up to it.
 */
import type { AnomalyCollector } from '../anomalies.ts';
import { compareEnds, cover } from '../build/timeline.ts';
import {
  compareDates,
  covers,
  daysBetween,
  isAfter,
  overlaps,
  type HalfOpenInterval,
  type IsoDate,
} from '../dates/index.ts';
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

const MAX_BOUNDARY_OFFSET_DAYS = 365;

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
  | typeof ANPR_ANOMALIES.laggingCadastral
  | typeof ANPR_ANOMALIES.anachronisticCadastral
  | typeof ANPR_ANOMALIES.laggingProvince
  | typeof ANPR_ANOMALIES.anachronisticProvince
  | typeof ANPR_ANOMALIES.formerItalianMissing;

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
  [ANPR_ANOMALIES.laggingCadastral]: 'ANPR cadastral codes the municipality had only earlier',
  [ANPR_ANOMALIES.anachronisticCadastral]: 'ANPR cadastral codes the municipality has only later',
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
  anpr: { rows: readonly AnprRecord[] };
  municipalities: readonly CrossCheckMunicipality[];
  provinces: readonly ProvinceEntity[];
  today: IsoDate;
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
  const rows = asOf(options.anpr.rows, options.today).sort(compareAnprRecords);
  const rowsByCadastral = groupBy(
    rows.filter((r) => r.cadastralCode !== null),
    (r) => r.cadastralCode ?? '',
  );
  const rowsByCode = groupBy(rows, (r) => r.istatCode);
  const uncodedRowsByCode = groupBy(
    rows.filter((r) => r.cadastralCode === null),
    (r) => r.istatCode,
  );

  const municipalities = [...options.municipalities].sort((a, b) => compareCodeUnits(a.id, b.id));
  const versionsByCadastral = new Map<string, VersionRef[]>();
  const uncodedVersionsByCode = new Map<string, VersionRef[]>();
  const versionsByCode = new Map<string, VersionRef[]>();
  for (const entity of municipalities) {
    for (const version of entity.versions) {
      const { cadastralCode } = version;
      const ref: VersionRef = { entity, version, matchedBy: cadastralCode === null ? 'istat-code' : 'cadastral' };
      if (cadastralCode === null) push(uncodedVersionsByCode, version.istatCode, ref);
      else push(versionsByCadastral, cadastralCode, ref);
      push(versionsByCode, version.istatCode, ref);
    }
  }

  const joinedRows = ({ version }: VersionRef): AnprRecord[] =>
    version.cadastralCode === null
      ? (rowsByCode.get(version.istatCode) ?? [])
      : [...(rowsByCadastral.get(version.cadastralCode) ?? []), ...(uncodedRowsByCode.get(version.istatCode) ?? [])];
  const joinedVersions = (row: AnprRecord): VersionRef[] =>
    row.cadastralCode === null
      ? (versionsByCode.get(row.istatCode) ?? [])
      : [...(versionsByCadastral.get(row.cadastralCode) ?? []), ...(uncodedVersionsByCode.get(row.istatCode) ?? [])];

  const byKey = groupBy(rows, (r) => r.cadastralCode ?? `istat:${r.istatCode}`);
  const retriedVersions = new Map<AnprRecord, VersionRef[]>();
  const retriedRows = new Map<MunicipalityVersion, AnprRecord[]>();
  for (const keyRows of byKey.values()) {
    for (const stretch of union(keyRows)) {
      const stretchRows = keyRows.filter((r) => overlaps(stretch, r));
      if (stretchRows.some((r) => joinedVersions(r).some((v) => overlaps(v.version, r)))) continue;
      for (const row of stretchRows) {
        const found = (versionsByCode.get(row.istatCode) ?? []).filter((v) => overlaps(v.version, row));
        if (found.length === 0) continue;
        retriedVersions.set(row, found);
        for (const ref of found) push(retriedRows, ref.version, row);
      }
    }
  }

  const candidateRows = (ref: VersionRef): AnprRecord[] => [
    ...joinedRows(ref),
    ...(retriedRows.get(ref.version) ?? []),
  ];
  const candidateVersions = (row: AnprRecord): VersionRef[] => [
    ...joinedVersions(row),
    ...(retriedVersions.get(row) ?? []),
  ];
  const methodOf = (version: MunicipalityVersion, row: AnprRecord): MatchMethod =>
    version.cadastralCode !== null && version.cadastralCode === row.cadastralCode ? 'cadastral' : 'istat-code';

  const namesIn = (entity: CrossCheckMunicipality, range: HalfOpenInterval): Set<string> =>
    new Set(
      entity.versions.filter((v) => overlaps(v, range)).flatMap((v) => [upper(v.officialName), upper(v.italianName)]),
    );

  const istatCodesIn = (entity: CrossCheckMunicipality, range: HalfOpenInterval): Set<string> =>
    new Set(entity.versions.filter((v) => overlaps(v, range)).map((v) => v.istatCode));

  const cadastralCodesIn = (entity: CrossCheckMunicipality, range: HalfOpenInterval): Set<string> =>
    new Set(
      entity.versions
        .filter((v) => overlaps(v, range))
        .flatMap((v) => (v.cadastralCode === null ? [] : [v.cadastralCode])),
    );

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

  const compareRow = (ref: VersionRef, row: AnprRecord, period: HalfOpenInterval): void => {
    const { entity, version } = ref;
    const context = {
      matchedBy: methodOf(version, row),
      entityId: entity.id,
      versionFrom: version.validFrom,
      validFrom: period.validFrom,
      validTo: period.validTo,
      anprRow: rowRef(row),
    };
    const where = `municipality ${entity.id} (version from ${version.validFrom}, ${describe(period)})`;
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
    // Different only on a stretch retried by ISTAT code: the cadastral code is the divergence.
    if (version.cadastralCode !== null && row.cadastralCode !== null && version.cadastralCode !== row.cadastralCode) {
      const item = { ...context, situas: version.cadastralCode, anpr: row.cadastralCode };
      const place = placeInHistory(entity, period, cadastralCodesIn, row.cadastralCode);
      if (place === 'lagging') addInfo(ANPR_ANOMALIES.laggingCadastral, item);
      else if (place === 'anachronistic') addInfo(ANPR_ANOMALIES.anachronisticCadastral, item);
      else {
        warn(
          ANPR_ANOMALIES.divergentCadastral,
          `${where}: cadastral code ${version.cadastralCode}, ANPR ${row.cadastralCode}`,
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

  const compareAttributes = (ref: VersionRef, overlapping: readonly AnprRecord[]): void => {
    const { entity, version, matchedBy } = ref;
    const ambiguous = union(sharedDays(overlapping))
      .filter((period) => overlaps(period, version))
      .map((period) => intersection(period, version));
    for (const period of ambiguous) {
      addInfo(ANPR_ANOMALIES.notComparable, {
        entityId: entity.id,
        versionFrom: version.validFrom,
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
        versionsFrom: inside.map((u) => u.ref.version.validFrom),
        matchedBy: [...new Set(inside.map((u) => u.ref.matchedBy))],
        validFrom: piece.validFrom,
        validTo: piece.validTo,
      };
      if (sameInterval(piece, segment)) {
        addInfo(ANPR_ANOMALIES.missingPeriod, item);
      } else if (days(piece) === 1) {
        addInfo(ANPR_ANOMALIES.dateOffByOne, { ...item, side: 'situas-only' });
      } else {
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
      versionFrom: last.validFrom,
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

/** In the order of §6.11. */
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
    return { code: ANPR_ANOMALIES.cessionExtended, context: { entityId: entity.id, versionFrom: version.validFrom } };
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
        versionFrom: version.validFrom,
        boundary: established ? 'establishment' : 'suppression',
        days: days(piece),
      },
    };
  }
  return null;
}

/** ANPR writes names in uppercase (`Agliè` → `AGLIÈ`). */
function upper(name: string): string {
  return name.toLocaleUpperCase('it');
}

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

function looseName(name: string): string {
  return upper(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/\s*'\s*/g, "'")
    .normalize('NFC');
}

function sharedDays(rows: readonly AnprRecord[]): HalfOpenInterval[] {
  return rows.flatMap((a, i) =>
    rows
      .slice(i + 1)
      .filter((b) => overlaps(a, b))
      .map((b) => intersection(a, b)),
  );
}

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

function edge(piece: HalfOpenInterval, segment: HalfOpenInterval): 'start' | 'end' | 'inside' {
  if (piece.validFrom === segment.validFrom) return 'start';
  if (piece.validTo === segment.validTo) return 'end';
  return 'inside';
}

function describe({ validFrom, validTo }: HalfOpenInterval): string {
  return `[${validFrom}, ${validTo ?? '…'})`;
}

/** Anomalies identify rows as stored, not as clipped by `asOf`. */
const STORED = new WeakMap<AnprRecord, AnprRecord>();

function asOf(rows: readonly AnprRecord[], today: IsoDate): AnprRecord[] {
  return rows
    .filter((row) => !isAfter(row.validFrom, today))
    .map((row) => {
      if (row.validTo === null || !isAfter(row.validTo, today)) return row;
      const open = { ...row, validTo: null };
      STORED.set(open, row);
      return open;
    });
}

/** By store row hash: ANPR repeats rows with equal fields. */
function rowRef(clipped: AnprRecord) {
  const row = STORED.get(clipped) ?? clipped;
  return {
    hash: rowHash(anprRecord(row)),
    istatCode: row.istatCode,
    cadastralCode: row.cadastralCode,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

function rowSummary(clipped: AnprRecord) {
  const row = STORED.get(clipped) ?? clipped;
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
  const byVersion = new Map(refs.map((r) => [`${r.entity.id}|${r.version.validFrom}`, r]));
  return [...byVersion.values()].sort(
    (a, b) => compareCodeUnits(a.entity.id, b.entity.id) || compareDates(a.version.validFrom, b.version.validFrom),
  );
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

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
